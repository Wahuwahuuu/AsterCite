"""A resident JSONL worker with explicit P0/P1 smoke and pinned P2 modes.

P0/P1 remains stdlib-only and reads only its two predetermined corpus files.
P2 model/index dependencies are loaded only after explicit index configuration.
"""

import argparse
import json
from pathlib import Path
import re
import sys
from typing import Any


BACKEND = "smoke_lexical"
MAX_QUERY_CODEPOINTS = 1000
MAX_ABSTRACT_CODEPOINTS = 1200
MAX_CHUNK_CODEPOINTS = 2000
_WORD = re.compile(r"\w+", re.UNICODE)
_REQUEST_FIELDS = {"version", "request_id", "method", "params"}


class CorpusError(ValueError):
    """The fixed runtime corpus does not satisfy its source contract."""


class ParameterError(ValueError):
    """A tool parameter does not satisfy the finite method contract."""


def _utf8_string(value: Any, *, nonempty: bool = False) -> bool:
    if not isinstance(value, str) or (nonempty and not value.strip()):
        return False
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def _tokens(text: str) -> set[str]:
    return set(_WORD.findall(text.lower()))


def _read_jsonl(corpus_dir: Path, filename: str) -> list[dict[str, Any]]:
    path = corpus_dir / filename
    # Even a renamed symlink cannot redirect the runtime loader to eval/gold.
    if path.resolve(strict=True).parent != corpus_dir:
        raise CorpusError("Corpus file is outside its runtime directory.")
    rows = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise CorpusError("Corpus records must be objects.")
            rows.append(row)
    return rows


class SmokeCorpus:
    """Validated in-memory runtime data, with deterministic lexical scores."""

    def __init__(self, papers: dict[str, dict[str, Any]], chunks: list[dict[str, Any]], index_version: str):
        self.papers = papers
        self.chunks = chunks
        self.index_version = index_version
        self._paper_terms = {
            paper_id: _tokens(paper["title"] + " " + paper["abstract"])
            for paper_id, paper in papers.items()
        }
        self._chunk_terms = [(chunk, _tokens(chunk["text"])) for chunk in chunks]

    @classmethod
    def load(cls, corpus_dir: Path) -> "SmokeCorpus":
        try:
            if not corpus_dir.is_absolute():
                raise CorpusError("Corpus directory must be absolute.")
            corpus_dir = corpus_dir.resolve(strict=True)
            if not corpus_dir.is_dir():
                raise CorpusError("Corpus directory is not a directory.")
            paper_rows = _read_jsonl(corpus_dir, "papers.jsonl")
            chunk_rows = _read_jsonl(corpus_dir, "chunks.jsonl")
            if not paper_rows or not chunk_rows:
                raise CorpusError("Runtime corpus must contain papers and chunks.")

            papers: dict[str, dict[str, Any]] = {}
            paragraphs: dict[str, tuple[str, str, str]] = {}
            for row in paper_rows:
                if not all(_utf8_string(row.get(field), nonempty=True) for field in ("paper_id", "title", "source_split")):
                    raise CorpusError("Paper metadata is invalid.")
                if not _utf8_string(row.get("abstract")):
                    raise CorpusError("Paper abstract is invalid.")
                paper_id = row["paper_id"]
                if paper_id in papers:
                    raise CorpusError("Paper IDs must be unique.")
                full_text = row.get("full_text")
                if not isinstance(full_text, list) or not full_text:
                    raise CorpusError("Paper full text is invalid.")
                sections = []
                for section_index, section in enumerate(full_text):
                    if not isinstance(section, dict) or not _utf8_string(section.get("section_name")):
                        raise CorpusError("Paper section is invalid.")
                    texts = section.get("paragraphs")
                    if not isinstance(texts, list) or not all(_utf8_string(text) for text in texts):
                        raise CorpusError("Paper paragraphs are invalid.")
                    sections.append({"section_name": section["section_name"], "paragraphs": list(texts)})
                    for paragraph_index, text in enumerate(texts):
                        paragraph_id = f"{paper_id}:s{section_index}:p{paragraph_index}"
                        paragraphs[paragraph_id] = (paper_id, section["section_name"], text)
                # Keep only runtime fields; never return annotation metadata.
                papers[paper_id] = {
                    "paper_id": paper_id,
                    "title": row["title"],
                    "abstract": row["abstract"],
                    "source_split": row["source_split"],
                    "full_text": sections,
                }

            chunks = []
            chunk_ids: set[str] = set()
            index_versions: set[str] = set()
            chunk_fields = ("paper_id", "paragraph_id", "chunk_id", "section", "text", "index_version")
            for row in chunk_rows:
                if not all(_utf8_string(row.get(field), nonempty=(field != "section")) for field in chunk_fields):
                    raise CorpusError("Chunk fields are invalid.")
                if row.get("backend") != BACKEND or row["chunk_id"] in chunk_ids:
                    raise CorpusError("Chunk backend or ID is invalid.")
                source = paragraphs.get(row["paragraph_id"])
                if source is None or source[0] != row["paper_id"] or source[1] != row["section"]:
                    raise CorpusError("Chunk source is invalid.")
                start, end = row.get("start"), row.get("end")
                if type(start) is not int or type(end) is not int:
                    raise CorpusError("Chunk ranges must be integers.")
                if not 0 <= start < end <= len(source[2]) or end - start > MAX_CHUNK_CODEPOINTS:
                    raise CorpusError("Chunk range is invalid.")
                if source[2][start:end] != row["text"]:
                    raise CorpusError("Chunk text does not match its actual source range.")
                chunk_ids.add(row["chunk_id"])
                index_versions.add(row["index_version"])
                chunks.append({field: row[field] for field in (*chunk_fields, "start", "end", "backend")})
            if len(index_versions) != 1:
                raise CorpusError("All chunks must use the same index version.")
            return cls(papers, chunks, index_versions.pop())
        except (OSError, UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise CorpusError("Runtime corpus cannot be loaded.") from exc

    def search_papers(self, params: dict[str, Any]) -> dict[str, Any]:
        if set(params) - {"query", "limit"}:
            raise ParameterError()
        query = _query(params.get("query"))
        limit = _bounded_integer(params.get("limit", 5), 1, 10)
        terms = _tokens(query)
        candidates = [
            (len(terms & paper_terms), paper_id)
            for paper_id, paper_terms in self._paper_terms.items()
            if terms & paper_terms
        ]
        candidates.sort(key=lambda candidate: (-candidate[0], candidate[1]))
        papers = []
        for _, paper_id in candidates[:limit]:
            paper = self.papers[paper_id]
            papers.append({
                "paper_id": paper_id,
                "title": paper["title"],
                "abstract": paper["abstract"][:MAX_ABSTRACT_CODEPOINTS],
                "backend": BACKEND,
                "index_version": self.index_version,
            })
        return {"papers": papers, "backend": BACKEND, "index_version": self.index_version}

    def retrieve_chunks(self, params: dict[str, Any]) -> dict[str, Any]:
        if set(params) - {"query", "paper_ids", "top_k"}:
            raise ParameterError()
        query = _query(params.get("query"))
        top_k = _bounded_integer(params.get("top_k", 5), 1, 5)
        paper_ids = params.get("paper_ids")
        if not isinstance(paper_ids, list) or not 1 <= len(paper_ids) <= 4:
            raise ParameterError()
        if not all(_utf8_string(paper_id, nonempty=True) and paper_id in self.papers for paper_id in paper_ids):
            raise ParameterError()
        if len(set(paper_ids)) != len(paper_ids):
            raise ParameterError()
        scope = set(paper_ids)
        terms = _tokens(query)
        candidates = [
            (len(terms & chunk_terms), chunk)
            for chunk, chunk_terms in self._chunk_terms
            if chunk["paper_id"] in scope and terms & chunk_terms
        ]
        candidates.sort(key=lambda candidate: (-candidate[0], candidate[1]["chunk_id"]))
        return {
            "chunks": [dict(chunk) for _, chunk in candidates[:top_k]],
            "backend": BACKEND,
            "index_version": self.index_version,
        }


def _query(value: Any) -> str:
    if not _utf8_string(value, nonempty=True) or len(value) > MAX_QUERY_CODEPOINTS:
        raise ParameterError()
    return value


def _bounded_integer(value: Any, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ParameterError()
    return value


def _error(request_id: str | None, code: str, message: str) -> dict[str, Any]:
    return {"version": 1, "request_id": request_id, "error": {"code": code, "message": message}}


def handle_request(corpus: SmokeCorpus, request: Any) -> dict[str, Any]:
    request_id = None
    if isinstance(request, dict) and _utf8_string(request.get("request_id"), nonempty=True):
        request_id = request["request_id"]
    if (
        not isinstance(request, dict)
        or set(request) != _REQUEST_FIELDS
        or type(request.get("version")) is not int
        or request["version"] != 1
        or request_id is None
        or not isinstance(request.get("method"), str)
        or not isinstance(request.get("params"), dict)
    ):
        return _error(request_id, "INVALID_REQUEST", "Request must follow the version 1 protocol.")
    try:
        if request["method"] == "search_papers":
            result = corpus.search_papers(request["params"])
        elif request["method"] == "retrieve_chunks":
            result = corpus.retrieve_chunks(request["params"])
        else:
            return _error(request_id, "METHOD_NOT_FOUND", "Method is not supported.")
        return {"version": 1, "request_id": request_id, "result": result}
    except ParameterError:
        return _error(request_id, "INVALID_PARAMS", "Parameters do not satisfy the tool contract.")
    except Exception as exc:
        # P2 local computation failures remain distinguishable from no-hit.
        code = getattr(exc, "code", None)
        if code in {"QUERY_TOO_LONG", "MODEL_OOM"}:
            return _error(request_id, code, "Local retrieval cannot complete with the current input or device.")
        # Never put corpus contents, stack traces, or incidental local paths in a
        # model-visible error. An unexpected fault stays distinct from no-hit.
        return _error(request_id, "INTERNAL_ERROR", "Retrieval failed.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="PiPaper fixed-corpus JSONL worker; explicit P2 index mode")
    parser.add_argument("--corpus-dir", required=True, type=Path)
    parser.add_argument("--index-dir", type=Path)
    parser.add_argument("--models-dir", type=Path)
    parser.add_argument("--profile", choices=("dense", "bm25", "rrf", "rrf_rerank"))
    parser.add_argument("--device", choices=("cuda", "cpu"))
    args = parser.parse_args(argv)
    p2 = args.index_dir is not None
    if p2 and (args.models_dir is None or args.profile is None):
        parser.error("P2 index mode requires --models-dir and --profile")
    if not p2 and any(value is not None for value in (args.models_dir, args.profile, args.device)):
        parser.error("P2 options require --index-dir")
    try:
        if p2:
            # Direct script launch has the retriever directory, not the project
            # root, on sys.path. Preserve shared protocol exception identities.
            if __package__ in (None, ""):
                sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
                sys.modules.setdefault("retriever.worker", sys.modules[__name__])
            from retriever.p2 import P2Corpus, ModelOOM
            corpus = P2Corpus.load(args.index_dir, args.models_dir, args.corpus_dir, args.profile, args.device)
        else:
            corpus = SmokeCorpus.load(args.corpus_dir)
    except Exception as exc:
        if getattr(exc, "code", None) == "MODEL_OOM":
            sys.stderr.write("PiPaper worker startup failed: MODEL_OOM; restart entire batch on CPU.\n")
            return 3
        sys.stderr.write("PiPaper worker startup failed: invalid corpus.\n")
        return 2

    if p2:
        ready = {"version": 1, "type": "ready", "backend": corpus.backend, "index_version": corpus.index_version}
        sys.stdout.buffer.write(json.dumps(ready, separators=(",", ":")).encode("utf-8") + b"\n")
        sys.stdout.buffer.flush()

    for raw_line in sys.stdin.buffer:
        try:
            request = json.loads(raw_line.decode("utf-8"))
            response = handle_request(corpus, request)
        except (UnicodeError, ValueError, RecursionError):
            response = _error(None, "INVALID_REQUEST", "Request must follow the version 1 protocol.")
        encoded = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            sys.stdout.buffer.write(encoded + b"\n")
            sys.stdout.buffer.flush()
        except BrokenPipeError:
            return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
