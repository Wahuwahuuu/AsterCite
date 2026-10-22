import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../agent/assets.ts";
interface Source {chunk_id:string;paper_id:string;section:string;text:string}
interface Turn {question:string;answer:string;sources:Source[]}
const value=JSON.parse(await readFile(join(PROJECT_ROOT,"demo/dialogue.json"),"utf8")) as {turns:Turn[]};
console.log("AsterCite · 论文问答示例\n示例回放 · 问题 → 回答 → 证据\n");
for(const [index,t] of value.turns.entries()){
  const labels=new Map(t.sources.map((s,i)=>[s.chunk_id,String(i+1)]));
  const answer=t.answer.replace(/\[cite:([^\]]+)\]/gu,(match,id:string)=>labels.has(id)?"["+labels.get(id)+"]":match);
  console.log("── "+(index+1)+" ──\n\n问："+t.question+"\n\n答："+answer+"\n");
  for(const s of t.sources){
    const excerpt=s.text.replace(/\s+/gu," ").trim();
    console.log("["+labels.get(s.chunk_id)+"] "+s.paper_id+" · "+s.section+"\n"+(excerpt.length>320?excerpt.slice(0,320)+"…":excerpt)+"\n");
  }
}
