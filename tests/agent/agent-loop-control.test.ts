import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fauxAssistantMessage as reply,fauxToolCall as call,getCurrentTools,getCurrentSystemPrompt,type FauxResponseStep,type TranscriptContext} from '@earendil-works/pi-ai';
import {mainFixture,preparation,SOURCE_IDS,PREPARED_INDEX} from './main-fixture.ts';
import {TurnExecutionTracker} from '../../agent/turn-execution.ts';

const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
const complete=(text:string,needs_sources?:boolean)=>reply(JSON.stringify({execution:{state:'complete',remaining_needs:[],...(needs_sources===undefined?{}:{needs_sources})},answer:text}));
const needsTool=(name:string,response:ReturnType<typeof reply>)=>(context:TranscriptContext)=>{assert.ok(getCurrentTools(context.messages).some(tool=>tool.name===name),'Provider must actually receive '+name);return response;};
async function discovery(steps:FauxResponseStep[]){
  const seed=await mainFixture([]),papers=Array.from({length:5},(_,i)=>({paper_id:'p'+(i+1),title:i===0?'Paper One':'Paper '+(i+1),abstract:i===0?'CATALOG_ONLY':'Public catalog description'}));seed.harness.dispose();
  return mainFixture(steps,[[0]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1',knownPaperIds:new Set(papers.map(p=>p.paper_id)),
    p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,
      evidenceIndex:new Map(seed.chunks.map(chunk=>[chunk.chunk_id,{...chunk,index_version:PREPARED_INDEX,text_sha256:createHash('sha256').update(chunk.text).digest('hex')}])),publicPapers:papers,nlu:true,reflect:false,structuredMemory:true}});
}
test('discovery can autonomously read originals after catalog search: provider tools remain present during generate',async()=>{
  const f=await discovery([reply(JSON.stringify({intent:'answer',targets:[],rewrite:'Choose a paper and introduce its method',queries:[]})),
    needsTool('search_papers',reply([call('search_papers',{query:'papers',limit:1})],{stopReason:'toolUse'})),
    needsTool('retrieve_chunks',reply([call('retrieve_chunks',{query:'method',paper_ids:['p1']})],{stopReason:'toolUse'})),
    complete(`来源说明。[cite:${SOURCE_IDS[0]}]`)]);
  try{const result=await f.harness.runTurn('Choose a paper and introduce its method',[],'autonomous-reading');assert.equal(result.status,'completed',result.error??'');assert.deepEqual(f.calls.map(c=>c.method),['search_papers','retrieve_chunks']);assert.equal(result.execution?.state,'complete');assert.ok(!result.closing_reason);assert.deepEqual(result.citation_validity.cited_ids,[SOURCE_IDS[0]]);}finally{f.harness.dispose();}
});
test('a missing completion flag cannot turn an invented abstract identifier into a source or bypass original reading',async()=>{
  const wrong='p1:abstract';
  const f=await discovery([reply(JSON.stringify({intent:'answer',targets:[],rewrite:'Explain an available paper',queries:[]})),
    needsTool('search_papers',reply([call('search_papers',{query:'available',limit:1})],{stopReason:'toolUse'})),complete(`摘要介绍。[cite:${wrong}]`),
    context=>{assert.ok(getCurrentSystemPrompt(context.messages).includes(wrong));return needsTool('retrieve_chunks',reply([call('retrieve_chunks',{query:'original method',paper_ids:['p1']})],{stopReason:'toolUse'}))(context);},
    complete(`根据原文说明。[cite:${SOURCE_IDS[0]}]`)]);
  try{const result=await f.harness.runTurn('Explain an available paper',[],'missing-source-flag');assert.equal(result.status,'completed',result.error??'');assert.equal(result.execution?.state,'complete');assert.equal(result.execution?.needs_sources,true);assert.equal(result.requests.length,5);assert.deepEqual(result.citation_validity.cited_ids,[SOURCE_IDS[0]]);assert.ok(!result.final_answer.includes('引用未定位'));assert.equal(result.requests.some(request=>request.stage==='citation_repair'),false);}finally{f.harness.dispose();}
});
test('citation feedback returns to the open loop and the model can choose another source lookup',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),complete('初稿。[cite:wrong]',false),
    needsTool('retrieve_chunks',reply([call('retrieve_chunks',{query:'additional original',paper_ids:['p1']})],{stopReason:'toolUse'})),complete(`修正说明。[cite:${SOURCE_IDS[1]}]`,false)],[[0],[1]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1'});
  try{const result=await f.harness.runTurn('解释论文方法',['p1'],'citation-back-to-loop');assert.equal(result.status,'completed',result.error??'');assert.equal(result.execution?.state,'complete');assert.equal(result.execution?.needs_sources,true);assert.ok(!result.closing_reason);assert.equal(result.tools.filter(tool=>tool.executed).length,2);assert.deepEqual(result.citation_validity.cited_ids,[SOURCE_IDS[1]]);}finally{f.harness.dispose();}
});
test('the reserved last request closes exploration regardless of the displayed generate phase',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),complete('任务仍未完成，现有依据有限。',true),context=>{assert.deepEqual(getCurrentTools(context.messages),[]);return reply(JSON.stringify({execution:{state:'partial',remaining_needs:['缺少所需内容']},answer:'保留当前可用的部分结果。'}));}],[[0]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1',maxRequests:3});
  try{const result=await f.harness.runTurn('解释论文方法',['p1'],'explicit-last-request');assert.equal(result.requests.length,3);assert.equal(result.status,'completed',result.error??'');assert.equal(result.business_status,'partial');assert.ok(result.closing_reason);assert.ok(result.final_answer.includes('部分结果'));}finally{f.harness.dispose();}
});
test('an actual empty original lookup can end with an honest evidence gap',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({execution:{state:'partial',remaining_needs:['缺少方法原文']},answer:'这次原文查询没有找到相关说明。'}))],[[]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1'});
  try{const result=await f.harness.runTurn('解释论文方法',['p1'],'actual-empty-source');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,2);assert.equal(result.execution?.state,'partial');assert.equal(result.tools.filter(tool=>tool.executed).length,1);}finally{f.harness.dispose();}
});
test('host provenance requirements survive omitted and false model flags without depending on any answer wording',()=>{
  for(const needs_sources of [undefined,false,true]){const tracker=new TurnExecutionTracker(),facts={progress_key:'catalog',source_count:0,cited_source_count:0,retrieval_attempts:0,successful_retrievals:0,running_tools:0,can_continue:true,requires_sources:true};const result=tracker.decide({state:'complete',remaining_needs:[],...(needs_sources===undefined?{}:{needs_sources})},facts);assert.equal(result.state,'working');assert.equal(result.needs_sources,true);}
});
test('conversation and pure catalog navigation still finish without forcing an original lookup',async()=>{
  for(const intent of ['session_update','find_papers']){const f=await mainFixture([reply(JSON.stringify({intent,targets:[],rewrite:'user request',queries:[]})),complete('可以从目录选择一篇论文继续讨论。',false)],[[0]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1'});try{const result=await f.harness.runTurn(intent==='session_update'?'你好':'列出可选论文',[],'nonfactual-'+intent);assert.equal(result.status,'completed',result.error??'');assert.equal(result.execution?.state,'complete');assert.equal(result.tools.length,0);}finally{f.harness.dispose();}}
});
