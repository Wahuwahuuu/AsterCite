"""Install only the paper library and its matching CPU index from the product bundle."""
from __future__ import annotations
import hashlib, json, pathlib, re, stat, zipfile

INDEX_FILES = {"index-manifest.json", "chunks.jsonl", "source-map.jsonl", "bm25.json", "dense-vectors.npy", "dense.index"}
CORPUS = "data/full-v1/corpus/papers.jsonl"

def digest(path):
    h = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            h.update(block)
    return h.hexdigest()

def contained(root, name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError("Invalid resource path")
    target = root / path
    if not target.resolve().is_relative_to(root) or target.is_symlink():
        raise ValueError("Resource path escapes installation")
    return target

def read_manifest(root):
    root = pathlib.Path(root).resolve()
    manifest = json.loads((root / "desktop/resources/manifest.json").read_bytes())
    index = manifest.get("index_dir", "")
    if manifest.get("version") != 1 or not re.fullmatch(r"artifacts/bundled-cpu/pipaper-full-index-v1-[a-f0-9]{16}", index):
        raise ValueError("Invalid library version")
    expected = {CORPUS} | {index + "/" + name for name in INDEX_FILES}
    if set(manifest.get("files", {})) != expected:
        raise ValueError("Unexpected library contents")
    for meta in manifest["files"].values():
        if set(meta) != {"sha256", "bytes"} or not re.fullmatch(r"[a-f0-9]{64}", meta["sha256"]) or not isinstance(meta["bytes"], int) or not 0 < meta["bytes"] < 64 * 1024**2:
            raise ValueError("Invalid resource description")
    return manifest

def restore(root):
    root = pathlib.Path(root).resolve()
    manifest = read_manifest(root)
    archive = root / "desktop/resources/library.zip"
    if digest(archive) != manifest["archive_sha256"]:
        raise ValueError("Paper library download is incomplete; reinstall AsterCite")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) != len(manifest["files"]) or {e.filename for e in entries} != set(manifest["files"]):
            raise ValueError("Unexpected bundle entries")
        for entry in entries:
            meta = manifest["files"][entry.filename]
            if entry.file_size != meta["bytes"] or stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Invalid bundle entry")
            target = contained(root, entry.filename)
            if target.exists():
                if target.stat().st_size != meta["bytes"] or digest(target) != meta["sha256"]:
                    raise ValueError("Installed library differs; use a new installation folder")
                continue
            content = bundle.read(entry)
            if hashlib.sha256(content).hexdigest() != meta["sha256"]:
                raise ValueError("Library entry is incomplete")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = contained(root, entry.filename + ".partial")
            temporary.write_bytes(content)
            temporary.replace(target)
    return manifest
