import type { Paper,Chunk } from "./contracts.ts";
import { RuntimeFailure } from "./contracts.ts";
import { citationIds } from "./p2-r2.ts";

export interface PaperCoverage {paper_id:string;status:"addressed"|"insufficient";summary:string;citations:string[]}
export function selectedTargets(question:string,scope:readonly string[],papers:readonly Paper[]):string[]{
  if(scope.length<=1)return [...scope];
  const mentions=papers.filter(p=>scope.includes(p.paper_id)&&(question.includes(p.paper_id)||question.toLowerCase().includes(p.title.toLowerCase()))).map(p=>p.paper_id);
  if(/排除|除了|忽略|只(?:用|看|回答|分析)/u.test(question)||mentions.length&&/不要(?:使用|分析|回答)/u.test(question))return [];
  if(/选[中择]的?论文|勾选|这些|这几篇|逐篇|每[一]?篇|所有(?:的)?论文|分别(?:分析|说明|回答)/u.test(question))return [...scope];
  if(/这篇|那篇|同一篇|它的/u.test(question))return [];
  if(mentions.length>1&&!/排除|忽略|不[要用]|只(?:用|看|回答|分析)/u.test(question))return mentions;
  return mentions.length?[]:[...scope];
}
export function coverageInstruction(ids:readonly string[],papers:readonly Paper[]):string{
  if(!ids.length)return "";
  return `Web selected-paper contract: address EACH of these papers separately: ${JSON.stringify(ids.map(id=>({paper_id:id,title:papers.find(p=>p.paper_id===id)?.title??id})))}. Do not shrink this set because one paper looks more relevant. Retrieve per-paper evidence where the tool budget permits. If a paper does not supply the requested fact, explicitly describe that bounded gap, not invented findings. In the final JSON also return paper_coverage:[{paper_id,status:"addressed|insufficient",summary:"concise Chinese coverage statement",citations:["actual chunk ID"]}] with exactly one entry per selected paper. The answer body must name every paper ID. addressed requires a citation from THAT paper; insufficient must explicitly state what is missing. If any paper is insufficient, final status must be partial or refusal, never answer. Identifying a different research task does not establish the requested mechanism: mark that paper insufficient and say the mechanism is not shown in the retrieved excerpts; do not claim a feature is absent from the entire paper unless a source explicitly establishes that. Keep ordinary final-answer fields and citation rules.`;
}
export function validateCoverage(raw:unknown,ids:readonly string[],evidence:ReadonlyMap<string,Chunk>,answer:string):PaperCoverage[]{
  const fail=(message:string):never=>{throw new RuntimeFailure("ANSWER_SCOPE_ERROR",message);};
  if(!Array.isArray(raw)||raw.length!==ids.length)fail("paper_coverage must contain exactly one entry for EACH selected paper: "+ids.join(", "));
  const result=(raw as unknown[]).map((v,index)=>{
    if(!v||typeof v!=="object"||Array.isArray(v))return fail(`paper_coverage[${index}] must be an object`);
    const x=v as Record<string,unknown>;
    if(typeof x.paper_id!=="string"||!ids.includes(x.paper_id)||!["addressed","insufficient"].includes(String(x.status))||typeof x.summary!=="string"||!x.summary.trim()||x.summary.length>1600||!Array.isArray(x.citations)||x.citations.some(c=>typeof c!=="string"))return fail(`paper_coverage[${index}] has invalid fields`);
    if(!answer.replace(/\[cite:[^\]]+\]/gu,"").includes(x.paper_id))fail("answer must separately name selected paper "+x.paper_id);
    if(x.citations.some(c=>evidence.get(c)?.paper_id!==x.paper_id||!citationIds(answer).includes(c)))fail("paper_coverage citations must appear in answer and belong to "+x.paper_id);
    if(x.status==="addressed"&&!x.citations.length)fail("addressed paper requires its own original evidence: "+x.paper_id);
    return {paper_id:x.paper_id,status:x.status as PaperCoverage["status"],summary:x.summary,citations:x.citations as string[]};
  });
  if(new Set(result.map(x=>x.paper_id)).size!==ids.length)fail("paper_coverage contains duplicate papers");return result;
}
