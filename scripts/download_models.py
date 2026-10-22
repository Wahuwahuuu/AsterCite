"""Explicitly download only pinned retrieval weights; generation credentials are unused."""
from __future__ import annotations
import argparse,hashlib,json,pathlib,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
def file_sha(path):
    h=hashlib.sha256()
    with path.open("rb") as s:
        while block:=s.read(8*1024*1024):h.update(block)
    return h.hexdigest()
def download(root=ROOT):
    root=pathlib.Path(root).resolve();manifest=json.loads((root/"data/manifests/p2-models.json").read_bytes())
    total=0
    for model in manifest["models"]:
        for name,meta in model["files"].items():
            target=root/".cache/models"/model["relative_directory"]/name
            if not target.resolve().is_relative_to(root):raise ValueError("Model output escapes project")
            if target.exists():
                if target.stat().st_size!=meta["bytes"] or file_sha(target)!=meta["sha256"]:raise ValueError("Existing model file differs: "+name)
                continue
            target.parent.mkdir(parents=True,exist_ok=True);part=target.with_suffix(target.suffix+".partial")
            if part.exists():raise ValueError("Interrupted download exists; inspect/remove its .partial file before retry")
            url="https://huggingface.co/"+model["repo_id"]+"/resolve/"+model["revision"]+"/"+name
            print("Downloading "+model["repo_id"]+" @ "+model["revision"]+" / "+name,flush=True)
            with urllib.request.urlopen(url,timeout=180) as src,part.open("xb") as dst:
                while block:=src.read(8*1024*1024):dst.write(block)
            if part.stat().st_size!=meta["bytes"] or file_sha(part)!=meta["sha256"]:raise ValueError("Downloaded file hash differs: "+name)
            part.rename(target);total+=meta["bytes"]
    return {"status":"verified","models":len(manifest["models"]),"downloaded_bytes":total,"provider_calls":0}
if __name__=="__main__":
    argparse.ArgumentParser(description=__doc__).parse_args();print(json.dumps(download()))
