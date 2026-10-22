"""Download pinned local retrieval weights with progress and restart support."""
from __future__ import annotations
import argparse,hashlib,http.client,json,pathlib,re,time,urllib.error,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
def file_sha(path):
    h=hashlib.sha256()
    with path.open("rb") as s:
        while block:=s.read(8*1024*1024):h.update(block)
    return h.hexdigest()
def download_file(url,target,size,digest,*,attempts=5,progress=print):
    """Completed files are immutable; pinned partial files can be resumed safely."""
    target=pathlib.Path(target);part=target.with_name(target.name+".partial")
    if target.is_symlink() or part.is_symlink():raise ValueError("Download paths must not be links")
    if target.exists():
        if target.stat().st_size!=size or file_sha(target)!=digest:raise ValueError("Existing model file differs: "+target.name)
        return 0
    target.parent.mkdir(parents=True,exist_ok=True)
    if part.exists() and part.stat().st_size==size and file_sha(part)==digest:
        part.replace(target);return 0
    started=part.stat().st_size if part.exists() else 0
    for attempt in range(attempts):
        offset=part.stat().st_size if part.exists() else 0
        if offset>=size:offset=0
        request=urllib.request.Request(url,headers={"Range":f"bytes={offset}-"} if offset else {})
        try:
            with urllib.request.urlopen(request,timeout=60) as source:
                if source.status==206:
                    match=re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)",source.headers.get("Content-Range",""))
                    if not match or int(match[1])!=offset or int(match[3])!=size:raise ValueError("Download range differs")
                elif source.status==200:offset=0
                else:raise ValueError("Unexpected download response")
                last=0.0
                with part.open("ab" if offset else "wb") as output:
                    while block:=source.read(2*1024*1024):
                        offset+=len(block)
                        if offset>size:raise ValueError("Download exceeds expected size")
                        output.write(block);now=time.monotonic()
                        if now-last>=2:
                            progress(f"  {offset/size:.0%}  {offset/1024**2:.1f} / {size/1024**2:.1f} MB");last=now
            if part.stat().st_size!=size:raise OSError("Incomplete download")
            if file_sha(part)!=digest:
                # Restart this known partial file on the next run, never accept corrupt weights.
                with part.open("wb"):pass
                raise ValueError("Downloaded file differs: "+target.name)
            part.replace(target);return max(0,size-started)
        except (OSError,urllib.error.URLError,http.client.HTTPException):
            if attempt+1==attempts:raise
            progress("  连接中断，正在续传…");time.sleep(min(2**attempt,4))
    raise OSError("Download did not finish")

def download(root=ROOT):
    root=pathlib.Path(root).resolve();manifest=json.loads((root/"data/manifests/p2-models.json").read_bytes())
    total=0
    for model in manifest["models"]:
        for name,meta in model["files"].items():
            target=root/".cache/models"/model["relative_directory"]/name
            if not target.resolve().is_relative_to(root):raise ValueError("Model output escapes project")
            url="https://huggingface.co/"+model["repo_id"]+"/resolve/"+model["revision"]+"/"+name
            print("准备 "+model["repo_id"]+" / "+name,flush=True)
            total+=download_file(url,target,meta["bytes"],meta["sha256"],progress=lambda msg:print(msg,flush=True))
    return {"status":"verified","models":len(manifest["models"]),"downloaded_bytes":total,"provider_calls":0}
if __name__=="__main__":
    argparse.ArgumentParser(description=__doc__).parse_args();print(json.dumps(download()))
