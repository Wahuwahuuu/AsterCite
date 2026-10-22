import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebSource, WebTurn } from "../agent/web-session.ts";

const PROJECT_ROOT=fileURLToPath(new URL("../",import.meta.url));
const raw=JSON.parse(await readFile(join(PROJECT_ROOT,"demo/dialogue.json"),"utf8"));
const papers=[{paper_id:"1611.09441",title:"Sentiment Analysis for Twitter: Going Beyond Tweet Text"},
  {paper_id:"1705.02394",title:"Learning Representations of Emotional Speech with Deep Convolutional Generative Adversarial Networks"}];
const labels=["这篇论文用了哪些语言特征？","研究使用了怎样的数据集？","切换论文，查看语音表示学习方法","用中文比较两篇论文的方法"];
const topics=["情感分析 · 方法理解","沿用论文对象 · 继续追问","语音表示 · 论文切换","跨论文比较 · 偏好纠正"];
const turns: Array<WebTurn&{label:string;topic:string}>=raw.turns.map((turn:{question:string;answer:string;sources:WebSource[]},i:number)=>({
  question:turn.question,answer:turn.answer,label:labels[i],topic:topics[i],status:"completed",elapsed_ms:0,requests:0,tokens:null,stages:[],
  sources:turn.sources.map(s=>({chunk_id:s.chunk_id,paper_id:s.paper_id,title:papers.find(p=>p.paper_id===s.paper_id)?.title??s.paper_id,section:s.section,text:s.text}))
}));
await writeFile(join(PROJECT_ROOT,"web/sample.json"),JSON.stringify({mode:"demo",papers,turns},null,2)+"\n");
await writeFile(join(PROJECT_ROOT,"web/config.json"),JSON.stringify({mode:"demo",papers,model:null,access_token_required:false},null,2)+"\n");
console.log("网页示例已准备。");
