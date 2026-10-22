"""Prepare the included paper library and pinned local models on first launch."""
from __future__ import annotations
import argparse, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.resources import restore, digest, contained
from scripts.download_models import download
from retriever.p2 import verify_artifacts, dependency_versions, model_inventory

def prepare(root=ROOT, check=False):
    root = pathlib.Path(root).resolve()
    resources = restore(root)
    model_manifest = json.loads((root / "data/manifests/p2-models.json").read_bytes())
    stamp = {"version": 1, "library": resources["archive_sha256"], "requirements": digest(root / "desktop/requirements-win-x64.lock")}
    ready = contained(root, ".local/desktop/ready.json")
    models_present = all((root / ".cache/models" / model["relative_directory"] / name).is_file() and (root / ".cache/models" / model["relative_directory"] / name).stat().st_size == meta["bytes"]
                         for model in model_manifest["models"] for name, meta in model["files"].items())
    same = False
    try:
        same = json.loads(ready.read_bytes()) == stamp
    except (OSError, ValueError):
        pass
    index = verify_artifacts(root / resources["index_dir"], root / resources["corpus_dir"])
    if dependency_versions() != index["identity"]["dependencies"]:
        raise ValueError("Retrieval environment differs; reinstall this version of AsterCite")
    if check:
        return {"ready": same and models_present, "papers": resources["paper_count"]}
    if not same or not models_present:
        print("首次使用需要准备约 4.6 GB 的本地检索模型，下载中断后可重新启动继续。", flush=True)
        download(root)
        if model_inventory(root / ".cache/models") != index["identity"]["models"]:
            raise ValueError("Retrieval models differ")
        ready.parent.mkdir(parents=True, exist_ok=True)
        ready.write_text(json.dumps(stamp) + "\n", encoding="utf8")
    return {"ready": True, "papers": resources["paper_count"]}

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(check=args.check)))
    except Exception as error:
        print("本地检索准备未完成：" + str(error), file=sys.stderr)
        sys.exit(1)
