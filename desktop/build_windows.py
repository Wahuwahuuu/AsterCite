"""Build a Windows x64 installer from an explicit product file list and a clean CPU environment."""
from __future__ import annotations
import argparse, hashlib, json, os, pathlib, shutil, subprocess, sys, urllib.request, zipfile
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from desktop.resources import digest, restore

def run(args, cwd=None):
    # Build tools never need generation credentials.
    env = {k:v for k,v in os.environ.items() if k not in {"PIPAPER_API_KEY", "ASTERCITE_WEB_TOKEN"}}
    env["PYTHONDONTWRITEBYTECODE"]="1"
    subprocess.run([str(a) for a in args], cwd=cwd or ROOT, env=env, check=True)

def fetch(meta, output):
    if not output.exists():
        with urllib.request.urlopen(meta["url"], timeout=120) as source, output.open("xb") as target:
            shutil.copyfileobj(source, target)
    if digest(output) != meta["sha256"]:
        raise ValueError("Runtime download differs: " + output.name)
    return output

def source_files(root=ROOT):
    files = json.loads((root / "desktop/product-files.json").read_bytes())
    if not isinstance(files,list) or len(files)!=len(set(files)):
        raise ValueError("Invalid product file list")
    forbidden={".git",".local",".cache",".runtime",".venv","node_modules",".release-work","experiments","evaluation","evaluations","reproduce","runs","reports","metrics","benchmarks","research"}
    for name in files:
        path=pathlib.PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or forbidden.intersection(path.parts) or "\\" in name or ":" in name or path.name.startswith(".env") or name=="AGENTS.md" or name.startswith(("docs/specs/","docs/plans/","docs/internal/")) or name.endswith((".local.json",".log",".bundle",".key",".pem")):
            raise ValueError("Private path in product file list")
        if not (root/name).resolve().is_relative_to(root.resolve()) or not (root/name).is_file():
            raise ValueError("Missing product source: "+name)
    return files

def stage_app(stage, cpu_python, downloads):
    stage=pathlib.Path(stage).resolve()
    if not stage.is_relative_to(ROOT/".release-work") or stage.exists():
        raise ValueError("Use a new stage directory inside .release-work")
    cpu_python=pathlib.Path(cpu_python).resolve(strict=True)
    probe="import sys,json,importlib.metadata as m; print(json.dumps({'base':sys.base_prefix,'site':next(p for p in sys.path if p.endswith('site-packages')),'python':list(sys.version_info[:3]),'torch':m.version('torch'),'memory':m.version('qdrant-edge-py')}))"
    info=json.loads(subprocess.check_output([str(cpu_python),"-c",probe],text=True))
    if info["python"] != [3,12,13] or info["torch"] != "2.9.1+cpu" or info['memory'] != '0.9.0':
        raise ValueError("Use CPython 3.12.13 and the locked CPU environment, including Qdrant Edge")
    stage.mkdir(parents=True)
    for name in source_files():
        target=stage/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(ROOT/name,target)
    # No application configuration or user records are copied from the build computer.
    assets=json.loads((ROOT/"desktop/runtime-assets.json").read_bytes())
    downloads=pathlib.Path(downloads).resolve();downloads.mkdir(parents=True,exist_ok=True)
    node_archive=fetch(assets["node"],downloads/"node.zip")
    node_home=downloads/"node-v24.11.1-win-x64"
    if not node_home.exists():
        with zipfile.ZipFile(node_archive) as bundle: bundle.extractall(downloads)
    runtime=stage/".runtime"; (runtime/"node").mkdir(parents=True)
    for name in ["node.exe","LICENSE"]: shutil.copy2(node_home/name,runtime/"node"/name)
    shutil.copy2(fetch(assets["vc_redist"],downloads/"vc_redist.x64.exe"),runtime/"vc_redist.x64.exe")
    ignore=shutil.ignore_patterns("__pycache__","*.pyc","*.pyo","site-packages","__pypackages__","Scripts")
    shutil.copytree(info["base"],runtime/"python",ignore=ignore)
    shutil.copytree(info["site"],runtime/"python/Lib/site-packages",ignore=shutil.ignore_patterns("__pycache__","*.pyc","*.pyo","_virtualenv.py","_virtualenv.pth"))
    node=runtime/"node/node.exe"
    run([node,node_home/"node_modules/npm/bin/npm-cli.js","ci","--ignore-scripts","--omit=dev","--no-audit","--no-fund","--cache",ROOT/".cache/npm"],stage)
    # Restore/validate inside staging too, so the installed library is ready without source downloads.
    restore(stage)
    run([runtime/"python/python.exe","-c","import torch,transformers,numpy,faiss; assert not torch.cuda.is_available(); print('Bundled CPU runtime ready')"],stage)
    # Prevent third-party bytecode from embedding the build computer's absolute paths.
    run([runtime/"python/python.exe","-B",stage/"desktop/prepare.py","--check"],stage)
    result={"stage_files":sum(1 for p in stage.rglob('*') if p.is_file()),"version":json.loads((stage/"package.json").read_bytes())["version"]}
    return result

if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cpu-python",required=True,type=pathlib.Path)
    parser.add_argument("--stage",required=True,type=pathlib.Path)
    parser.add_argument("--downloads",default=ROOT/".release-work/windows-v1.1/downloads",type=pathlib.Path)
    parser.add_argument("--iscc",required=True,type=pathlib.Path)
    parser.add_argument("--output",default=ROOT/"dist",type=pathlib.Path)
    args=parser.parse_args()
    if sys.platform!="win32": raise SystemExit("Build this installer on Windows x64")
    result=stage_app(args.stage,args.cpu_python,args.downloads)
    args.output.mkdir(parents=True,exist_ok=True)
    run([args.iscc,"/Q","/DStageDir="+str(args.stage.resolve()),"/DOutputDir="+str(args.output.resolve()),"/DAppVersion="+result["version"],ROOT/"desktop/windows.iss"])
    print(json.dumps(result))
