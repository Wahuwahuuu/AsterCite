import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sha, containedPath, type AppConfig } from "./config.ts";
import { object, RuntimeFailure, type Paper, type EvidenceIdentity } from "./contracts.ts";
import { PythonWorkerClient } from "./worker-client.ts";

export const PROJECT_ROOT=fileURLToPath(new URL("../",import.meta.url));
export const CORE_FILES=["agent/contracts.ts","agent/domain-memory.ts","agent/final-answer.ts","agent/full-stages-main-v2.ts","agent/full-stages.ts","agent/ledger.ts","agent/main-controls.ts","agent/main-r2-check-v2.ts","agent/main-reliability-v2.ts","agent/p2-r2.ts","agent/p2-stages.ts","agent/pipeline-trace-prepared-v1.ts","agent/pipeline-trace.ts","agent/question-preparation.ts","agent/session-main-v2.ts","agent/session-memory.ts","agent/tools.ts","agent/worker-client.ts"];
export interface Assets {root:string;indexVersion:string;publicPapers:Paper[];evidenceIndex:Map<string,EvidenceIdentity>;implementationId:string;commonPrompt:string}
export async function fileHash(path:string):Promise<string>{
  const h=createHash("sha256");for await(const part of createReadStream(path))h.update(part as Buffer);return h.digest("hex");
}
async function rows(path:string):Promise<Record<string,unknown>[]> {return (await readFile(path,"utf8")).split(/\r?\n/u).filter(s=>s.trim()).map(s=>object(JSON.parse(s)));}
export async function loadAssets(root:string,config:AppConfig):Promise<Assets>{
  const indexRoot=await containedPath(root,config.retrieval.index_dir);
  const manifest=object(JSON.parse(await readFile(join(indexRoot,"index-manifest.json"),"utf8")));
  if(manifest.gold_loaded!==false || manifest.model_api_calls!==0 || typeof manifest.index_version!=="string")throw new RuntimeFailure("INVALID_INDEX","Index must contain public source material only");
  for(const [name,h] of Object.entries(object(manifest.files))){
    if(await fileHash(await containedPath(indexRoot,name))!==h)throw new RuntimeFailure("INVALID_INDEX","Index content hash differs: "+name);
  }
  const parent=object(object(manifest.identity).parent),recipe=object(object(manifest.identity).recipe);
  const corpusRoot=await containedPath(root,config.retrieval.corpus_dir);
  const papersPath=join(corpusRoot,"papers.jsonl"), corpusManifestPath=join(corpusRoot,"..","manifests","corpus.json");
  if(await fileHash(papersPath)!==parent.papers_sha256 || await fileHash(corpusManifestPath)!==parent.corpus_manifest_sha256)throw new RuntimeFailure("INVALID_INDEX","Corpus differs from index parent");
  if(recipe.device!==config.retrieval.device)throw new RuntimeFailure("INVALID_CONFIG","Device differs from index; rebuild a separate index for CPU");
  const papers=await rows(papersPath),publicPapers:Paper[]=[],paragraphs=new Map<string,{paper_id:string;text:string}>();
  for(const p of papers){
    if(typeof p.paper_id!=="string"||typeof p.title!=="string"||typeof p.abstract!=="string"||!Array.isArray(p.full_text))throw new RuntimeFailure("INVALID_INDEX","Malformed corpus paper");
    publicPapers.push({paper_id:p.paper_id,title:p.title,abstract:p.abstract});
    for(const [i,raw] of p.full_text.entries()){const section=object(raw);if(!Array.isArray(section.paragraphs))throw new RuntimeFailure("INVALID_INDEX","Malformed section");
      for(const [j,text] of section.paragraphs.entries()){if(typeof text!=="string")throw new RuntimeFailure("INVALID_INDEX","Malformed paragraph");paragraphs.set(p.paper_id+":s"+i+":p"+j,{paper_id:p.paper_id,text});}}
  }
  const chunks=await rows(join(indexRoot,"chunks.jsonl")),maps=await rows(join(indexRoot,"source-map.jsonl"));
  const byId=new Map(maps.map(m=>[m.chunk_id,m])),evidenceIndex=new Map<string,EvidenceIdentity>();
  if(byId.size!==maps.length || chunks.length!==maps.length || chunks.length!==manifest.chunk_count || publicPapers.length!==manifest.paper_count || new Set(publicPapers.map(p=>p.paper_id)).size!==papers.length)throw new RuntimeFailure("INVALID_INDEX","Index/catalog counts differ");
  for(const c of chunks){
    const mapping=byId.get(c.chunk_id),source=paragraphs.get(c.paragraph_id as string);
    if(!mapping || !source || source.paper_id!==c.paper_id || typeof c.chunk_id!=="string" || typeof c.text!=="string" || evidenceIndex.has(c.chunk_id) ||
       !Number.isInteger(c.start)||!Number.isInteger(c.end)||Number(c.start)<0||Number(c.end)<=Number(c.start) ||
       Array.from(source.text).slice(Number(c.start),Number(c.end)).join("")!==c.text || sha(c.text)!==c.text_sha256 ||
       mapping.paragraph_sha256!==sha(source.text)||c.index_version!==manifest.index_version ||
       ["paper_id","paragraph_id","start","end","text_sha256","index_version"].some(k=>c[k]!==mapping[k]))throw new RuntimeFailure("INVALID_INDEX","Chunk does not match exact source span");
    evidenceIndex.set(c.chunk_id,{chunk_id:c.chunk_id,paper_id:c.paper_id as string,paragraph_id:c.paragraph_id as string,start:Number(c.start),end:Number(c.end),text_sha256:c.text_sha256 as string,index_version:manifest.index_version});
  }
  const commonPrompt=await readFile(join(root,"prompts/full-common-v1.md"),"utf8");
  const hashes=await Promise.all([...CORE_FILES,"agent/config.ts","agent/assets.ts","agent/cli.ts","agent/budget.ts","retriever/p2.py","retriever/worker.py","package-lock.json","uv.lock"].map(async p=>[p,await fileHash(join(root,p))]));
  const implementationId=sha(JSON.stringify({config,hashes,prompt:sha(commonPrompt),index:manifest.index_version,manifest:await fileHash(join(indexRoot,"index-manifest.json"))}));
  return {root,indexVersion:manifest.index_version,publicPapers,evidenceIndex,implementationId,commonPrompt};
}
export async function createWorker(assets:Assets,config:AppConfig):Promise<PythonWorkerClient>{
  const py=join(assets.root,".venv",process.platform==="win32"?"Scripts":"bin",process.platform==="win32"?"python.exe":"python");
  const worker=new PythonWorkerClient({pythonPath:py,workerPath:join(assets.root,"retriever/worker.py"),
    corpusDir:await containedPath(assets.root,config.retrieval.corpus_dir),indexDir:await containedPath(assets.root,config.retrieval.index_dir),
    modelsDir:await containedPath(assets.root,config.retrieval.models_dir),profile:config.retrieval.profile,device:config.retrieval.device,expectReady:true,readyTimeoutMs:180000,timeoutMs:60000});
  try{const ready=await worker.ready();if(ready?.index_version!==assets.indexVersion)throw new RuntimeFailure("INVALID_INDEX","Worker loaded a different index");return worker;}catch(e){worker.close();throw e;}
}
