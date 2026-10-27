import test from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { sha } from "../../agent/config.ts";
import { selectedTargets,validateCoverage } from "../../agent/selected-scope.ts";
import { traceInput,traceOutput,type ExecutionEvent } from "../../agent/execution-trace.ts";
import { mainFixture,PREPARED_INDEX } from "./main-fixture.ts";
import type { Chunk } from "../../agent/contracts.ts";

const papers=[1,2,3].map(i=>({paper_id:`p${i}`,title:`Paper ${i} Study`,abstract:"catalog"}));
const chunks:Chunk[]=papers.map((p,i)=>{const text=`Paper ${i+1} has source evidence.`,id=`${PREPARED_INDEX}:${p.paper_id}:s0:p0:c0-${text.length}`;return {paper_id:p.paper_id,paragraph_id:`${p.paper_id}:s0:p0`,chunk_id:id,citation:`[${id}]`,truncated:false,section:"Methods",text,start:0,end:text.length,index_version:PREPARED_INDEX};});
const coverage=chunks.map(c=>({paper_id:c.paper_id,status:"addressed",summary:"已结合本篇原文说明",citations:[c.chunk_id]}));
const answer={status:"answer",answer:chunks.map(c=>`${c.paper_id} source [cite:${c.chunk_id}]`).join("\n\n"),exact_quotes:[],paper_coverage:coverage};
async function multiFixture(responses:Parameters<typeof mainFixture>[0],available=chunks){
  return mainFixture(responses,[],{knownPaperIds:new Set(papers.map(p=>p.paper_id)),selectedScopeCoverage:true,
    controls:{arm:"C",reflect:false,compaction:"off",reliability:"candidate",implementation_id:"1".repeat(64)},
    p2:{profile:"B",executionVersion:"full-v1",answerContract:"full-v1-json",indexVersion:PREPARED_INDEX,publicPapers:papers,reflect:false,structuredMemory:true,evidenceIndex:new Map(chunks.map(c=>[c.chunk_id,{...c,text_sha256:sha(c.text),index_version:PREPARED_INDEX}]))},
    worker:{async request(method,params){if(method==="search_papers")return {papers,backend:"rrf_rerank",index_version:PREPARED_INDEX};const ids="paper_ids" in params?params.paper_ids:[];return {chunks:available.filter(c=>ids.includes(c.paper_id)),backend:"rrf_rerank",index_version:PREPARED_INDEX};}}
  });
}

test("selected collective targets cannot silently collapse, while explicit exclusions and singular references remain meaningful",()=>{
  assert.deepEqual(selectedTargets("选择的论文如何分析情感？",["p1","p2","p3"],papers),["p1","p2","p3"]);
  assert.deepEqual(selectedTargets("它们各自用了什么输入数据？",["p1","p2","p3"],papers),["p1","p2","p3"]);
  assert.deepEqual(selectedTargets("选择的论文如何分析情感？不要使用外部资料。",["p1","p2","p3"],papers),["p1","p2","p3"]);
  assert.deepEqual(selectedTargets("比较 p1 和 p2",["p1","p2","p3"],papers),["p1","p2"]);
  assert.deepEqual(selectedTargets("选择的论文中不要使用 p1，只回答 p2",["p1","p2","p3"],papers),[]);
  assert.deepEqual(selectedTargets("这篇使用了哪些特征？",["p1","p2"],papers),[]);
  assert.throws(()=>validateCoverage(coverage.slice(0,1),["p1","p2","p3"],new Map(chunks.map(c=>[c.chunk_id,c])),answer.answer));
  assert.throws(()=>validateCoverage(coverage.map(c=>({...c,citations:[chunks[0].chunk_id]})),["p1","p2","p3"],new Map(chunks.map(c=>[c.chunk_id,c])),answer.answer));
});

test("web collective question retrieves all three separately within original request and tool budgets",async()=>{
  const events:ExecutionEvent[]=[],calls:string[][]=[];
  const setup=await mainFixture([reply(JSON.stringify({intent:"answer",targets:["p1"],rewrite:"p1 fact",queries:["only p1"]})),reply(JSON.stringify(answer))],[],{
    knownPaperIds:new Set(papers.map(p=>p.paper_id)),selectedScopeCoverage:true,onExecutionEvent:event=>events.push(event),
    controls:{arm:"C",reflect:false,compaction:"off",reliability:"candidate",implementation_id:"1".repeat(64)},
    p2:{profile:"B",executionVersion:"full-v1",answerContract:"full-v1-json",indexVersion:PREPARED_INDEX,publicPapers:papers,reflect:false,structuredMemory:true,evidenceIndex:new Map(chunks.map(c=>[c.chunk_id,{...c,text_sha256:sha(c.text),index_version:PREPARED_INDEX}]))},
    worker:{async request(method,params){if(method==="search_papers")return {papers,backend:"rrf_rerank",index_version:PREPARED_INDEX};const ids="paper_ids" in params?params.paper_ids:[];calls.push(ids);return {chunks:chunks.filter(c=>ids.includes(c.paper_id)),backend:"rrf_rerank",index_version:PREPARED_INDEX};}}
  });
  try{
    const result=await setup.harness.runTurn("选择的论文是如何分析的？请引用原文。",["p1","p2","p3"],"selected-three");
    assert.equal(result.status,"completed",result.error??"");assert.deepEqual(calls,[["p1"],["p2"],["p3"]]);assert.equal(result.requests.length,2);assert.equal(result.tools.length,3);
    assert.deepEqual(result.final_structure?.paper_coverage?.map(p=>p.paper_id),["p1","p2","p3"]);
    const models=events.filter(e=>e.kind==="model"&&e.output);assert.equal(models.length,2);assert.ok(events.some(e=>e.kind==="tool"&&e.origin==="host_plan"&&e.input));assert.ok(events.some(e=>e.kind==="tool"&&e.output?.text.includes("Paper 3")));
  }finally{setup.harness.dispose();}
});

test("request projections retain visible messages and tool calls while excluding thinking, credentials and signatures",()=>{
  const secret="fixture-secret-in-memory";
  const input=traceInput({api_key:secret,headers:{Authorization:secret},messages:[{role:"assistant",reasoning_content:"HIDDEN_PROVIDER_THOUGHT",content:[{type:"thinking",thinking:"HIDDEN_BLOCK"},{type:"text",text:"visible answer "+secret},{type:"toolCall",id:"call",name:"retrieve_chunks",arguments:{query:"fact",paper_ids:["p1"]}}]}],tools:[{type:"function",function:{name:"retrieve_chunks",description:"retrieve",parameters:{type:"object"}}}]},"provider_payload",[secret]);
  const output=traceOutput({content:[{type:"thinking",thinking:"HIDDEN_BLOCK"},{type:"text",text:"visible"},{type:"toolCall",name:"search_papers",id:"call",arguments:{query:"catalog"}}],signature:"HIDDEN_SIGNATURE"},[secret]);
  assert.match(input.messages[0].text,/REDACTED/);assert.ok(!JSON.stringify({input,output}).includes(secret));assert.ok(!JSON.stringify({input,output}).includes("HIDDEN"));assert.equal(output.tool_calls[0].name,"search_papers");
});

test("a missing paper answer receives one bounded correction without repeating retrieval",async()=>{
  const setup=await multiFixture([reply(JSON.stringify({intent:"answer",targets:["p1"],queries:["fact"]})),reply(JSON.stringify({...answer,answer:`p1 only [cite:${chunks[0].chunk_id}]`,paper_coverage:coverage.slice(0,1)})),reply(JSON.stringify(answer))]);
  try{const result=await setup.harness.runTurn("逐篇分析选择的论文",["p1","p2","p3"],"coverage-repair");assert.equal(result.status,"completed",result.error??"");assert.equal(result.requests.length,3);assert.equal(result.tools.length,3);assert.ok(result.generation_failures?.some(e=>e.code==="ANSWER_SCOPE_ERROR"));}
  finally{setup.harness.dispose();}
});

test("a paper with no returned source is explicitly insufficient, with no invented citation",async()=>{
  const partial={...answer,status:"partial",answer:`p1 source [cite:${chunks[0].chunk_id}]\n\np2 source [cite:${chunks[1].chunk_id}]\n\np3 当前摘录未找到所需依据。`,paper_coverage:[...coverage.slice(0,2),{paper_id:"p3",status:"insufficient",summary:"当前摘录未找到所需依据。",citations:[]}]};
  const setup=await multiFixture([reply(JSON.stringify({intent:"answer",targets:["p1"],queries:["fact"]})),reply(JSON.stringify(partial))],chunks.slice(0,2));
  try{const result=await setup.harness.runTurn("逐篇分析选择的论文",["p1","p2","p3"],"coverage-gap");assert.equal(result.status,"completed",result.error??"");assert.equal(result.requests.length,2);assert.equal(result.tools.length,3);assert.equal(result.final_structure?.status,"partial");assert.equal(result.final_structure?.paper_coverage?.[2].status,"insufficient");}
  finally{setup.harness.dispose();}
});
