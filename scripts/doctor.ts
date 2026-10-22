import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "../agent/assets.ts";
import { readConfig } from "../agent/config.ts";
const root=PROJECT_ROOT,python=join(root,".venv",process.platform==="win32"?"Scripts":"bin",process.platform==="win32"?"python.exe":"python");
let failed=false;
function status(name:string,ok:boolean,detail:string){console.log((ok?"[OK] ":"[缺失] ")+name+": "+detail);if(!ok)failed=true;}
const [major,minor,patch]=process.versions.node.split(".").map(Number);
status("Node",major>24 || major===24 && (minor>11 || minor===11 && patch>=1),process.versions.node+"，要求 >=24.11.1");
status("Python 环境",existsSync(python),".venv / Python 3.12");
for(const pkg of ["pi-ai","pi-agent-core","pi-coding-agent"]){
  try{const meta=JSON.parse(await readFile(join(root,"node_modules/@earendil-works",pkg,"package.json"),"utf8"));status(pkg,meta.version==="1.0.4",meta.version);}catch{status(pkg,false,"npm ci");}
}
status("固定语料",existsSync(join(root,"data/full-v1/corpus/papers.jsonl")),"python scripts/restore_corpus.py --download");
if(existsSync(python)){
  const result=spawnSync(python,["-c","import sys,json,importlib.metadata as m; names=['torch','transformers','numpy','faiss-cpu','rank-bm25']; print(json.dumps({'python':sys.version.split()[0],'packages':{n:m.version(n) for n in names}}))"],{encoding:"utf8",windowsHide:true,env:{...process.env,PIPAPER_API_KEY:""}});
  status("检索依赖",result.status===0,result.status===0?result.stdout.trim():"uv sync --frozen --extra retrieval");
}
try{
  const cfg=await readConfig(root);status("使用者配置",true,"已填写模型服务与参数");
  status("检索索引",existsSync(join(root,cfg.retrieval.index_dir,"index-manifest.json")),cfg.retrieval.index_dir);
  status("生成密钥",!!process.env.PIPAPER_API_KEY?.trim(),"仅检查是否存在，不显示内容");
}catch{status("使用者配置",false,"复制 configs/model.example.json 为 model.local.json 并填写自己的服务参数");}
console.log("查看离线示例无需 Python 检索依赖、模型配置或密钥。");process.exitCode=failed?1:0;
