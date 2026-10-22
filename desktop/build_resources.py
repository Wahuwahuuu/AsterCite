"""Build a distributable library from paper source and an independently built CPU index."""
from __future__ import annotations
import argparse, json, pathlib, sys, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from retriever.p2 import verify_artifacts, load_source, CHUNK_FIELDS, MAP_FIELDS
from desktop.resources import CORPUS, INDEX_FILES, digest

def build(index, output=ROOT / "desktop/resources"):
    index = pathlib.Path(index).resolve()
    manifest = verify_artifacts(index, ROOT / "data/full-v1/corpus")
    if manifest["identity"]["recipe"]["device"] != "cpu":
        raise ValueError("The Windows library requires an independent CPU index")
    papers, _, _ = load_source(ROOT / "data/full-v1/corpus")
    if any(set(p) != {"paper_id", "title", "abstract", "full_text"} for p in papers):
        raise ValueError("Only paper text may be bundled")
    for filename, fields in [("chunks.jsonl", CHUNK_FIELDS), ("source-map.jsonl", MAP_FIELDS)]:
        if any(set(json.loads(line)) != fields for line in (index / filename).read_text(encoding="utf8").splitlines()):
            raise ValueError("Unexpected source fields")
    index_name = "artifacts/bundled-cpu/" + index.name
    files = {CORPUS: ROOT / CORPUS, **{index_name + "/" + name: index / name for name in sorted(INDEX_FILES)}}
    output = pathlib.Path(output)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / "library.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, path in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            bundle.writestr(info, path.read_bytes())
    result = {"version": 1, "corpus_dir": "data/full-v1/corpus", "index_dir": index_name, "paper_count": len(papers),
              "archive_sha256": digest(archive), "files": {name: {"bytes": p.stat().st_size, "sha256": digest(p)} for name, p in files.items()}}
    (output / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    return {"paper_count": len(papers), "archive_bytes": archive.stat().st_size, "index_dir": index_name}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", required=True, type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(build(args.index)))
