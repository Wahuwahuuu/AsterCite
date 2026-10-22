"""P2 derived token chunks and exact local retrieval; runtime never reads Gold.

Heavy imports are lazy so the original stdlib P0 worker remains runnable.
Models must already exist in pinned local snapshot directories. No downloader
or model-catalog refresh is part of a build or worker request.
"""
from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import sys
from typing import Any

from retriever.worker import CorpusError, ParameterError, _bounded_integer, _query, _utf8_string

DENSE_REPO = "BAAI/bge-m3"
DENSE_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
RERANK_REPO = "BAAI/bge-reranker-v2-m3"
RERANK_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
PROFILES = ("dense", "bm25", "rrf", "rrf_rerank")
WINDOW = 512
OVERLAP = 64
RRF_K = 60
CANDIDATES = 20
MAX_CHUNK_CODEPOINTS = 2000
QUERY_NORMALIZATION = "public_metadata_prefix_v1"
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?")
MODEL_FILES = ("config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
               "sentencepiece.bpe.model", "model.safetensors", "pytorch_model.bin")
CHUNK_FIELDS = {"paper_id", "paragraph_id", "chunk_id", "section", "start", "end", "text",
                "index_version", "text_sha256", "citation", "truncated"}
MAP_FIELDS = {"paper_id", "paragraph_id", "chunk_id", "section", "start", "end",
              "index_version", "text_sha256", "paragraph_sha256"}


class ModelOOM(RuntimeError):
    """Caller must restart the entire comparison/build with CPU, not one query."""
    code = "MODEL_OOM"


class QueryTooLong(ValueError):
    code = "QUERY_TOO_LONG"


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def jsonl(rows: list[dict]) -> bytes:
    return b"".join(canonical(row) + b"\n" for row in rows)


def tokenize_bm25(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


def recipe(device: str) -> dict:
    if device not in ("cuda", "cpu"):
        raise ValueError("P2 device must be cuda or cpu")
    return {"recipe_version": "pipaper-p2-chunks-v1", "window_tokens_including_special": WINDOW,
            "overlap_content_tokens": OVERLAP, "paragraph_policy": "one paragraph; preserve raw source slices",
            "no_title_or_section_prefix": True, "dense_pooling": "normalized_cls", "device": device,
            "dtype": "float16" if device == "cuda" else "float32", "batch_size": 1,
            "faiss": "IndexFlatIP", "bm25": {"token_pattern": _WORD.pattern, "normalization": "casefold",
                "stopwords": False, "stemming": False, "k1": 1.5, "b": 0.75, "epsilon": 0.25},
            "branch_candidates": CANDIDATES, "rrf_k": RRF_K, "rrf_rank_origin": 1,
            "rrf_weights": [1, 1], "output_top_k": 5, "output_max_codepoints": MAX_CHUNK_CODEPOINTS,
            "reranker_truncation": False, "reranker_pair_max_tokens": 8192,
            "query_max_codepoints": 1000, "query_normalization": QUERY_NORMALIZATION,
            "tie_break": "chunk_id ascending"}


def full_recipe(device: str) -> dict:
    return {**recipe(device), "recipe_version": "pipaper-full-chunks-v1",
            "window_max_codepoints": MAX_CHUNK_CODEPOINTS,
            "window_policy": "joint token and raw codepoint bounds; shrink at original token offsets; continuous coverage"}


def normalize_retrieval_query(query: str, papers: dict[str, dict], scope: set[str]) -> str:
    """Remove only literal public paper-location prefixes at message line start.

    Matching against complete public title/ID pairs avoids rewriting a body
    mention, a partial title, or an object outside the active retrieval scope.
    No annotations, case IDs, inferred needs, or answer terms are inputs.
    """
    prefixes = [f'{head} "{papers[pid]["title"]}" ({pid}),'
                for pid in sorted(scope) for head in ("In the paper", "In")]
    lines = []
    for line in query.splitlines(keepends=True):
        replacement = line
        for prefix in prefixes:
            if line.startswith(prefix):
                suffix = line[len(prefix):].lstrip(" \t")
                # A location-only message must not disappear from the query.
                if suffix.strip():
                    replacement = suffix
                break
        lines.append(replacement)
    effective = "".join(lines)
    return effective if effective.strip() else query


def snapshot_directory(models_dir: Path, name: str) -> Path:
    if name == "dense":
        return models_dir / "bge-m3" / DENSE_REVISION
    if name == "reranker":
        return models_dir / "bge-reranker-v2-m3" / RERANK_REVISION
    raise ValueError("Unknown local model")


def model_inventory(models_dir: Path) -> dict:
    result = {}
    for name, repo, revision in [("dense", DENSE_REPO, DENSE_REVISION),
                                 ("reranker", RERANK_REPO, RERANK_REVISION)]:
        directory = snapshot_directory(models_dir, name).resolve(strict=True)
        files = {filename: file_sha256(directory / filename)
                 for filename in MODEL_FILES if (directory / filename).is_file()}
        if not {"config.json", "tokenizer.json"} <= files.keys() or not ({"model.safetensors", "pytorch_model.bin"} & files.keys()):
            raise CorpusError("Pinned model snapshot is incomplete")
        result[name] = {"repo": repo, "revision": revision, "files": files}
    return result


def load_source(corpus_dir: Path) -> tuple[list[dict], dict[str, dict], dict]:
    """Load only pinned text and corpus manifest, with no eval path access."""
    corpus_dir = corpus_dir.resolve(strict=True)
    path = corpus_dir / "papers.jsonl"
    if path.resolve(strict=True).parent != corpus_dir:
        raise CorpusError("Runtime papers escape their corpus directory")
    content = path.read_bytes()
    parent_path = corpus_dir.parent / "manifests" / "corpus.json"
    parent = json.loads(parent_path.read_text(encoding="utf-8"))
    if sha256(content) != parent.get("files", {}).get("papers.jsonl"):
        raise CorpusError("P1 source papers differ from their pinned manifest")
    raw = [json.loads(line) for line in content.decode("utf-8").splitlines() if line.strip()]
    papers, paragraphs = [], {}
    seen = set()
    for row in raw:
        if not isinstance(row, dict) or not all(_utf8_string(row.get(k), nonempty=True) for k in ("paper_id", "title")):
            raise CorpusError("Invalid paper metadata")
        if row["paper_id"] in seen or not _utf8_string(row.get("abstract")) or not isinstance(row.get("full_text"), list):
            raise CorpusError("Invalid or duplicate paper source")
        seen.add(row["paper_id"])
        sections = []
        for s, section in enumerate(row["full_text"]):
            if not isinstance(section, dict) or not _utf8_string(section.get("section_name")) or not isinstance(section.get("paragraphs"), list):
                raise CorpusError("Invalid paper section")
            if not all(_utf8_string(text) for text in section["paragraphs"]):
                raise CorpusError("Invalid paragraph text")
            sections.append({"section_name": section["section_name"], "paragraphs": list(section["paragraphs"])})
            for p, text in enumerate(section["paragraphs"]):
                pid = f"{row['paper_id']}:s{s}:p{p}"
                paragraphs[pid] = {"paper_id": row["paper_id"], "paragraph_id": pid,
                                   "section": section["section_name"], "text": text}
        papers.append({"paper_id": row["paper_id"], "title": row["title"], "abstract": row["abstract"], "full_text": sections})
    if len(papers) != parent.get("paper_count") or {p["paper_id"] for p in parent.get("papers", [])} != seen:
        raise CorpusError("P1 source paper list differs from its pinned manifest")
    return papers, paragraphs, {"papers_sha256": sha256(content), "corpus_manifest_sha256": sha256(parent_path.read_bytes()),
                                "p1_index_version": parent["index_version"], "paper_count": len(papers)}


def token_slices(text: str, tokenizer: Any, window: int = WINDOW, overlap: int = OVERLAP,
                 max_codepoints: int | None = None) -> list[tuple[int, int]]:
    """Offsets are raw Unicode-codepoint ranges; no decoded text is used."""
    if not text:
        return []
    special = tokenizer.num_special_tokens_to_add(pair=False)
    content_limit = window - special
    if not 0 <= overlap < content_limit:
        raise ValueError("Invalid token window or overlap")
    if max_codepoints is not None and (type(max_codepoints) is not int or max_codepoints < 1):
        raise ValueError("Invalid raw codepoint window")
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True, truncation=False)
    ids, offsets = encoded["input_ids"], encoded["offset_mapping"]
    if len(ids) != len(offsets):
        raise CorpusError("Tokenizer offsets differ from tokens")
    if (max_codepoints is None or len(text) <= max_codepoints) and len(tokenizer(text, add_special_tokens=True, truncation=False)["input_ids"]) <= window:
        return [(0, len(text))]
    if not offsets:
        raise CorpusError("Nonempty long text has no tokenizer offsets")
    for start, end in offsets:
        if type(start) is not int or type(end) is not int or not 0 <= start <= end <= len(text):
            raise CorpusError("Tokenizer offsets are not valid Unicode-codepoint ranges")
    ranges = []
    token_start = 0
    while token_start < len(ids):
        token_end = min(token_start + content_limit, len(ids))
        start = 0 if token_start == 0 else offsets[token_start][0]
        while True:
            end = len(text) if token_end == len(ids) else offsets[token_end][0]
            if (end > start and (max_codepoints is None or end-start <= max_codepoints)
                    and len(tokenizer(text[start:end], add_special_tokens=True, truncation=False)["input_ids"]) <= window):
                break
            token_end -= 1
            if token_end <= token_start:
                raise CorpusError("Tokenizer cannot produce a bounded source slice")
        if ranges and (start <= ranges[-1][0] or end <= ranges[-1][1]):
            raise CorpusError("Tokenizer windows do not make progress")
        ranges.append((start, end))
        if token_end == len(ids):
            break
        # Extremely fragmented offsets may require a smaller local overlap;
        # never loop on a token boundary that has not advanced.
        token_start = max(token_start + 1, token_end - overlap)
    if ranges[0][0] != 0 or ranges[-1][1] != len(text) or any(b[0] > a[1] for a, b in zip(ranges, ranges[1:])):
        raise CorpusError("Token chunks leave an uncovered source range")
    return ranges


def make_token_chunks(paragraphs: dict[str, dict], tokenizer: Any, index_version: str,
                      max_codepoints: int | None = None) -> tuple[list[dict], list[dict]]:
    chunks, mapping = [], []
    for source in paragraphs.values():
        text = source["text"]
        for start, end in token_slices(text, tokenizer, max_codepoints=max_codepoints):
            visible = text[start:end]
            if len(visible) > MAX_CHUNK_CODEPOINTS:
                raise CorpusError("P2 source slice exceeds the common visible text limit; explicit calibration is required")
            cid = f"{index_version}:{source['paragraph_id']}:c{start}-{end}"
            chunk = {"paper_id": source["paper_id"], "paragraph_id": source["paragraph_id"], "chunk_id": cid,
                     "section": source["section"], "start": start, "end": end, "text": visible,
                     "index_version": index_version, "text_sha256": sha256(visible.encode("utf-8")),
                     "citation": f"[{cid}]", "truncated": False}
            chunks.append(chunk)
            mapping.append({k: chunk[k] for k in ("paper_id", "paragraph_id", "chunk_id", "section", "start", "end", "index_version", "text_sha256")})
            mapping[-1]["paragraph_sha256"] = sha256(text.encode("utf-8"))
    if not chunks:
        raise CorpusError("Derived corpus has no chunks")
    return chunks, mapping


class ModelPool:
    """At most one model occupies CUDA; pinned local models may remain on CPU."""
    def __init__(self, models_dir: Path, device: str):
        import torch
        from transformers import AutoTokenizer
        self.torch = torch
        self.device = device
        recipe(device)
        if device == "cuda" and not torch.cuda.is_available():
            raise ModelOOM("CUDA is unavailable; restart the entire build/comparison on CPU")
        self.dtype = torch.float16 if device == "cuda" else torch.float32
        self.models_dir = models_dir
        self.models: dict[str, Any] = {}
        self.active: str | None = None
        self.tokenizers = {name: AutoTokenizer.from_pretrained(str(snapshot_directory(models_dir, name)),
                            local_files_only=True, trust_remote_code=False, use_fast=True)
                           for name in ("dense", "reranker")}
        if not all(t.is_fast for t in self.tokenizers.values()):
            raise CorpusError("P2 requires fast tokenizer source offsets")

    def _model(self, name: str) -> Any:
        from transformers import AutoModel, AutoModelForSequenceClassification
        try:
            if self.device == "cuda" and self.active is not None and self.active != name:
                self.models[self.active].to("cpu")
                self.torch.cuda.empty_cache()
            if name not in self.models:
                loader = AutoModel if name == "dense" else AutoModelForSequenceClassification
                self.models[name] = loader.from_pretrained(str(snapshot_directory(self.models_dir, name)),
                    local_files_only=True, trust_remote_code=False, torch_dtype=self.dtype)
                self.models[name].eval()
            model = self.models[name].to(self.device)
            self.active = name
            return model
        except self.torch.cuda.OutOfMemoryError as exc:
            raise ModelOOM("Local model OOM; restart the entire build/comparison on CPU") from exc

    def _inputs(self, name: str, value: Any, *, pair: bool = False) -> dict:
        tokenizer = self.tokenizers[name]
        encoded = tokenizer(value, padding=True, truncation=False, return_tensors="pt")
        # BGE models have 8194 positions including the pad-position offset;
        # actual supported sequence length is 8192, not the tokenizer sentinel.
        if encoded["input_ids"].shape[1] > 8192:
            raise QueryTooLong("Encoded input exceeds the pinned model token limit")
        return {k: v.to(self.device) for k, v in encoded.items()}

    def encode(self, texts: list[str]) -> Any:
        import numpy as np
        model = self._model("dense")
        vectors = []
        try:
            with self.torch.inference_mode():
                for text in texts:
                    inputs = self._inputs("dense", [text])
                    hidden = model(**inputs).last_hidden_state[:, 0]
                    norm = self.torch.nn.functional.normalize(hidden.float(), p=2, dim=1)
                    vectors.append(norm.cpu().numpy()[0])
        except self.torch.cuda.OutOfMemoryError as exc:
            raise ModelOOM("Dense computation OOM; restart the entire build/comparison on CPU") from exc
        return np.ascontiguousarray(vectors, dtype=np.float32)

    def rerank(self, query: str, texts: list[str]) -> list[float]:
        model = self._model("reranker")
        scores = []
        try:
            with self.torch.inference_mode():
                for text in texts:
                    inputs = self._inputs("reranker", [[query, text]], pair=True)
                    logits = model(**inputs).logits.reshape(-1)
                    if logits.numel() != 1:
                        raise CorpusError("Pinned reranker returned an unexpected score shape")
                    value = float(logits[0].float().cpu().item())
                    if not math.isfinite(value):
                        raise CorpusError("Pinned reranker returned a nonfinite score")
                    scores.append(value)
        except self.torch.cuda.OutOfMemoryError as exc:
            raise ModelOOM("Reranker computation OOM; restart the entire build/comparison on CPU") from exc
        return scores

    def close(self) -> None:
        self.models.clear()
        self.active = None
        gc.collect()
        if self.torch.cuda.is_available():
            self.torch.cuda.empty_cache()


def dependency_versions() -> dict:
    return {name: importlib.metadata.version(name) for name in
            ("torch", "transformers", "tokenizers", "numpy", "faiss-cpu", "rank-bm25", "huggingface-hub")}


def build_index(corpus_dir: Path, models_dir: Path, artifacts_dir: Path, device: str = "cuda", full: bool = False) -> Path:
    import faiss
    import numpy as np
    papers, paragraphs, parent = load_source(corpus_dir)
    models = model_inventory(models_dir)
    identity = {"parent": parent, "recipe": full_recipe(device) if full else recipe(device), "models": models, "dependencies": dependency_versions()}
    build_id = ("pipaper-full-index-v1-" if full else "pipaper-p2-index-v1-") + sha256(canonical(identity))[:16]
    target = artifacts_dir.resolve() / build_id
    if target.exists():
        existing = verify_artifacts(target, corpus_dir)
        if existing.get("identity") != identity:
            raise CorpusError("Existing index identity differs; no files overwritten")
        return target
    pool = ModelPool(models_dir, device)
    try:
        chunks, mapping = make_token_chunks(paragraphs, pool.tokenizers["dense"], build_id,
                                             max_codepoints=MAX_CHUNK_CODEPOINTS if full else None)
        vectors = pool.encode([chunk["text"] for chunk in chunks])
    finally:
        pool.close()
    if vectors.ndim != 2 or vectors.shape[0] != len(chunks) or not np.isfinite(vectors).all():
        raise CorpusError("Dense vector shape or values are invalid")
    if not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5):
        raise CorpusError("Dense vectors are not normalized")
    tokens = [tokenize_bm25(c["text"]) for c in chunks]
    if not any(tokens):
        raise CorpusError("BM25 corpus has no English words")
    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)
    # Nothing is written until tokenization and all local computation pass.
    # A failed partial write remains visible, never overwritten or accepted.
    target.mkdir(parents=True, exist_ok=False)
    (target / "chunks.jsonl").write_bytes(jsonl(chunks))
    (target / "source-map.jsonl").write_bytes(jsonl(mapping))
    (target / "bm25.json").write_bytes(canonical({"tokens": tokens, "config": identity["recipe"]["bm25"]}) + b"\n")
    np.save(target / "dense-vectors.npy", vectors, allow_pickle=False)
    # FAISS's Windows C stdio path API cannot open this project's Chinese
    # directory reliably; Python performs Unicode-safe file IO on its bytes.
    (target / "dense.index").write_bytes(faiss.serialize_index(index).tobytes())
    files = {name: sha256((target / name).read_bytes()) for name in
             ("chunks.jsonl", "source-map.jsonl", "bm25.json", "dense-vectors.npy", "dense.index")}
    manifest = {"schema_version": 1, "index_version": build_id, "identity": identity, "chunk_count": len(chunks),
                "paper_count": len(papers), "dense_dimensions": vectors.shape[1], "files": files,
                "supported_profiles": list(PROFILES), "gold_loaded": False, "model_api_calls": 0}
    (target / "index-manifest.json").write_bytes(json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n")
    verify_artifacts(target, corpus_dir)
    return target


def verify_artifacts(index_dir: Path, corpus_dir: Path) -> dict:
    index_dir = index_dir.resolve(strict=True)
    manifest = json.loads((index_dir / "index-manifest.json").read_text(encoding="utf-8"))
    _, paragraphs, parent = load_source(corpus_dir)
    if manifest.get("schema_version") != 1 or manifest.get("identity", {}).get("parent") != parent:
        raise CorpusError("P2 index parent source identity differs")
    version = manifest.get("index_version")
    settings = manifest.get("identity", {}).get("recipe", {})
    full = settings.get("recipe_version") == "pipaper-full-chunks-v1"
    if settings.get("device") not in ("cpu", "cuda") or settings != (full_recipe(settings["device"]) if full else recipe(settings["device"])):
        raise CorpusError("P2 index recipe differs from the implemented contract")
    if (manifest.get("supported_profiles") != list(PROFILES) or manifest.get("gold_loaded") is not False
            or manifest.get("model_api_calls") != 0 or manifest.get("paper_count") != parent["paper_count"]):
        raise CorpusError("P2 index metadata differs from the runtime contract")
    if version != ("pipaper-full-index-v1-" if full else "pipaper-p2-index-v1-") + sha256(canonical(manifest["identity"]))[:16]:
        raise CorpusError("P2 index build identity differs")
    required = {"chunks.jsonl", "source-map.jsonl", "bm25.json", "dense-vectors.npy", "dense.index"}
    if set(manifest.get("files", {})) != required:
        raise CorpusError("P2 index file inventory is incomplete")
    for name, digest in manifest["files"].items():
        path = index_dir / name
        if path.resolve(strict=True).parent != index_dir or sha256(path.read_bytes()) != digest:
            raise CorpusError("P2 index file hash or path differs")
    chunks = [json.loads(line) for line in (index_dir / "chunks.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    mapping = [json.loads(line) for line in (index_dir / "source-map.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(chunks) != manifest.get("chunk_count") or len(mapping) != len(chunks):
        raise CorpusError("P2 chunk count differs")
    seen, coverage = set(), {}
    for chunk, location in zip(chunks, mapping):
        if not isinstance(chunk, dict) or not isinstance(location, dict) or set(chunk) != CHUNK_FIELDS or set(location) != MAP_FIELDS:
            raise CorpusError("P2 runtime artifact has unexpected fields; annotations are forbidden")
        source = paragraphs.get(chunk.get("paragraph_id"))
        start, end = chunk.get("start"), chunk.get("end")
        if (source is None or type(start) is not int or type(end) is not int or not 0 <= start < end <= len(source["text"])
                or end - start > MAX_CHUNK_CODEPOINTS or chunk.get("text") != source["text"][start:end]
                or chunk.get("paper_id") != source["paper_id"] or chunk.get("section") != source["section"]):
            raise CorpusError("P2 source range cannot reconstruct its actual visible text")
        cid = f"{version}:{source['paragraph_id']}:c{start}-{end}"
        if (chunk.get("chunk_id") != cid or cid in seen or chunk.get("index_version") != version
                or chunk.get("citation") != f"[{cid}]" or chunk.get("truncated") is not False
                or chunk.get("text_sha256") != sha256(chunk["text"].encode("utf-8"))):
            raise CorpusError("P2 chunk citation or identity differs")
        seen.add(cid)
        coverage.setdefault(source["paragraph_id"], []).append((start, end))
        if any(location.get(k) != chunk.get(k) for k in ("paper_id", "paragraph_id", "chunk_id", "section", "start", "end", "index_version", "text_sha256")):
            raise CorpusError("P2 source map differs from its chunk")
        if location.get("paragraph_sha256") != sha256(source["text"].encode("utf-8")):
            raise CorpusError("P2 source paragraph hash differs")
    for pid, source in paragraphs.items():
        if not source["text"]:
            continue
        cursor = 0
        for start, end in sorted(coverage.get(pid, [])):
            if start > cursor:
                raise CorpusError("P2 index leaves an uncovered source range")
            cursor = max(cursor, end)
        if cursor != len(source["text"]):
            raise CorpusError("P2 index omits a source paragraph range")
    return manifest


def rrf(rankings: list[list[tuple[float, dict]]], limit: int = CANDIDATES) -> list[tuple[float, dict]]:
    scores: dict[str, float] = {}
    chunks = {}
    for ranking in rankings:
        branch_seen = set()
        for rank, (_, chunk) in enumerate(ranking, 1):
            cid = chunk["chunk_id"]
            if cid in branch_seen:
                raise CorpusError("A retrieval branch returned duplicate chunk IDs")
            branch_seen.add(cid)
            chunks[cid] = chunk
            scores[cid] = scores.get(cid, 0.0) + 1.0 / (RRF_K + rank)
    return sorted(((score, chunks[cid]) for cid, score in scores.items()), key=lambda row: (-row[0], row[1]["chunk_id"]))[:limit]


class P2Corpus:
    def __init__(self, papers: list[dict], chunks: list[dict], vectors: Any, bm25: Any, manifest: dict, pool: Any, profile: str):
        if profile not in PROFILES:
            raise ValueError("Unknown P2 retrieval profile")
        self.papers = {p["paper_id"]: p for p in papers}
        self.chunks, self.vectors, self.bm25 = chunks, vectors, bm25
        self.manifest, self.pool, self.profile = manifest, pool, profile
        self.index_version = manifest["index_version"]
        self.backend = profile
        self._paper_terms = {pid: set(tokenize_bm25(p["title"] + " " + p["abstract"])) for pid, p in self.papers.items()}

    @classmethod
    def load(cls, index_dir: Path, models_dir: Path, corpus_dir: Path, profile: str = "rrf", device: str | None = None) -> "P2Corpus":
        import faiss
        import numpy as np
        from rank_bm25 import BM25Okapi
        if profile not in PROFILES:
            raise CorpusError("Unknown P2 retrieval profile")
        if not all(path.is_absolute() for path in (index_dir, models_dir, corpus_dir)):
            raise CorpusError("P2 runtime paths must be absolute")
        manifest = verify_artifacts(index_dir, corpus_dir)
        pinned_device = manifest["identity"]["recipe"]["device"]
        if device is not None and device != pinned_device:
            raise CorpusError("Worker device differs from index; rebuild the entire comparison")
        if model_inventory(models_dir) != manifest["identity"]["models"]:
            raise CorpusError("Runtime local model snapshot differs from the index")
        if dependency_versions() != manifest["identity"]["dependencies"]:
            raise CorpusError("Runtime dependency versions differ from the index")
        papers, _, _ = load_source(corpus_dir)
        chunks = [json.loads(line) for line in (index_dir / "chunks.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
        vectors = np.load(index_dir / "dense-vectors.npy", allow_pickle=False)
        if (vectors.dtype != np.float32 or vectors.shape != (len(chunks), manifest["dense_dimensions"])
                or not np.isfinite(vectors).all() or not np.allclose(np.linalg.norm(vectors, axis=1), 1, atol=1e-5)):
            raise CorpusError("Persisted dense vectors differ from their contract")
        index = faiss.deserialize_index(np.frombuffer((index_dir / "dense.index").read_bytes(), dtype=np.uint8))
        if index.ntotal != len(chunks) or index.d != vectors.shape[1] or not np.array_equal(index.reconstruct_n(0, len(chunks)), vectors):
            raise CorpusError("Persisted FAISS index differs from dense vectors")
        artifact = json.loads((index_dir / "bm25.json").read_text(encoding="utf-8"))
        if artifact.get("tokens") != [tokenize_bm25(chunk["text"]) for chunk in chunks] or artifact.get("config") != manifest["identity"]["recipe"]["bm25"]:
            raise CorpusError("BM25 artifact differs from the common source text")
        bm25 = BM25Okapi(artifact["tokens"], k1=1.5, b=0.75, epsilon=0.25)
        pool = ModelPool(models_dir, pinned_device) if profile != "bm25" else None
        # Resolve local weights before announcing ready; a user turn must not
        # hide heavy model loading in its first tool timeout.
        if pool is not None:
            pool.encode(["local readiness check"])
            if profile == "rrf_rerank":
                pool.rerank("local readiness check", ["local readiness check"])
        return cls(papers, chunks, vectors, bm25, manifest, pool, profile)

    def _scope(self, params: dict, requested: list[str] | None = None) -> set[str]:
        allowed = params.get("allowed_paper_ids", list(self.papers))
        if (not isinstance(allowed, list) or not allowed
                or not all(isinstance(pid, str) and pid in self.papers for pid in allowed)
                or len(set(allowed)) != len(allowed)):
            raise ParameterError()
        scope = set(allowed)
        if requested is not None and not set(requested) <= scope:
            raise ParameterError()
        return scope if requested is None else set(requested)

    def search_papers(self, params: dict) -> dict:
        if set(params) - {"query", "limit", "allowed_paper_ids"}:
            raise ParameterError()
        query = _query(params.get("query"))
        limit = _bounded_integer(params.get("limit", 5), 1, 10)
        scope = self._scope(params)
        terms = set(tokenize_bm25(query))
        hits = [(len(terms & self._paper_terms[pid]), pid) for pid in scope if terms & self._paper_terms[pid]]
        hits.sort(key=lambda row: (-row[0], row[1]))
        return {"papers": [{"paper_id": pid, "title": self.papers[pid]["title"],
                            "abstract": self.papers[pid]["abstract"][:1200]} for _, pid in hits[:limit]],
                "backend": self.backend, "index_version": self.index_version}

    def _dense(self, query: str, eligible: list[int]) -> list[tuple[float, dict]]:
        import faiss
        import numpy as np
        vector = self.pool.encode([query])
        index = faiss.IndexFlatIP(self.vectors.shape[1])
        index.add(np.ascontiguousarray(self.vectors[eligible]))
        # Exact full scoped order provides a deterministic chunk-ID tie break
        # even when >20 items have the same score at the candidate boundary.
        scores, ids = index.search(vector, len(eligible))
        ranking = [(float(score), self.chunks[eligible[int(i)]]) for score, i in zip(scores[0], ids[0])]
        if not all(math.isfinite(score) for score, _ in ranking):
            raise CorpusError("Dense retrieval returned nonfinite scores")
        return sorted(ranking, key=lambda row: (-row[0], row[1]["chunk_id"]))[:CANDIDATES]

    def _lexical(self, query: str, eligible: list[int]) -> list[tuple[float, dict]]:
        scores = self.bm25.get_scores(tokenize_bm25(query))
        # Scores rank candidates only: zero/negative BM25 scores cannot be
        # turned into evidence-insufficiency decisions or implicit filtering.
        ranking = [(float(scores[i]), self.chunks[i]) for i in eligible]
        if not all(math.isfinite(score) for score, _ in ranking):
            raise CorpusError("BM25 retrieval returned nonfinite scores")
        return sorted(ranking, key=lambda row: (-row[0], row[1]["chunk_id"]))[:CANDIDATES]

    def retrieve_chunks(self, params: dict) -> dict:
        if set(params) - {"query", "paper_ids", "top_k", "allowed_paper_ids"}:
            raise ParameterError()
        query = _query(params.get("query"))
        top_k = _bounded_integer(params.get("top_k", 5), 1, 5)
        requested = params.get("paper_ids")
        if (not isinstance(requested, list) or not 1 <= len(requested) <= 4
                or not all(isinstance(pid, str) and pid in self.papers for pid in requested)
                or len(set(requested)) != len(requested)):
            raise ParameterError()
        scope = self._scope(params, requested)
        effective_query = normalize_retrieval_query(query, self.papers, scope)
        eligible = [i for i, chunk in enumerate(self.chunks) if chunk["paper_id"] in scope]
        if not eligible:
            ranking = []
        elif self.profile == "bm25":
            ranking = self._lexical(effective_query, eligible)
        elif self.profile == "dense":
            ranking = self._dense(effective_query, eligible)
        else:
            ranking = rrf([self._dense(effective_query, eligible), self._lexical(effective_query, eligible)])
            if self.profile == "rrf_rerank" and ranking:
                scored = self.pool.rerank(effective_query, [chunk["text"] for _, chunk in ranking])
                ranking = sorted(zip(scored, [chunk for _, chunk in ranking]), key=lambda row: (-row[0], row[1]["chunk_id"]))
        return {"chunks": [dict(chunk) for _, chunk in ranking[:top_k]], "backend": self.backend,
                "index_version": self.index_version, "query": query, "effective_query": effective_query,
                "query_normalization": QUERY_NORMALIZATION}

    def close(self) -> None:
        if self.pool is not None:
            self.pool.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build an independent P2 index from pinned P1 source text")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build")
    build.add_argument("--corpus-dir", type=Path, required=True)
    build.add_argument("--models-dir", type=Path, required=True)
    build.add_argument("--artifacts-dir", type=Path, required=True)
    build.add_argument("--device", choices=("cuda", "cpu"), default="cuda")
    build.add_argument("--full", action="store_true", help="Independent full-project joint token/codepoint recipe; preserves P2 default")
    verify = sub.add_parser("verify")
    verify.add_argument("--corpus-dir", type=Path, required=True)
    verify.add_argument("--index-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            directory = build_index(args.corpus_dir, args.models_dir, args.artifacts_dir, args.device, full=args.full)
            print(json.dumps({"status": "full_index_built" if args.full else "p2_index_built", "index_dir": str(directory),
                              "index_version": directory.name, "model_api_calls": 0}))
        else:
            manifest = verify_artifacts(args.index_dir, args.corpus_dir)
            print(json.dumps({"status": "p2_source_mapping_verified", "index_version": manifest["index_version"],
                              "chunks": manifest["chunk_count"], "model_api_calls": 0}))
        return 0
    except ModelOOM:
        print(json.dumps({"status": "model_oom", "action": "restart_entire_batch_cpu", "model_api_calls": 0}), file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
