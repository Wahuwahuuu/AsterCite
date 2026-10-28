import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {prepareWorkbenchAnswer,preferWorkbenchAnswer} from '../../agent/workbench-answer.ts';
import {RuntimeFailure,type Chunk} from '../../agent/contracts.ts';
import {mainFixture,preparation,SOURCE_IDS,PREPARED_INDEX} from './main-fixture.ts';
import type {MainHarnessOptions} from '../../agent/session-main-v2.ts';

const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
const source={paper_id:'p1',chunk_id:SOURCE_IDS[0],text:'A😀 source supports the fact.'} as Chunk;
const evidence=new Map([[source.chunk_id,source]]);
const context={evidence,expectedKind:'paper_fact' as const,allowAnswer:true};
const grounded=`这是基于论文原文的说明。[cite:${source.chunk_id}]`;
const f=(responses:Parameters<typeof mainFixture>[0],extra:Partial<MainHarnessOptions>={})=>mainFixture(responses,[[0]],{controls,answerPolicy:'workbench-v1',...extra});

test('ordinary Markdown and exact known source IDs are accepted without a JSON wrapper',()=>{
  const raw=`## 方法\n\n回答正文 [${source.chunk_id}]`,result=prepareWorkbenchAnswer(raw,context)!;
  assert.equal(result.value.status,'answer');assert.match(result.value.answer,/^## 方法/);assert.ok(result.value.answer.includes(`[cite:${source.chunk_id}]`));assert.equal(result.needsCitationRepair,false);
  assert.equal(result.original,raw);
});

test('auxiliary fields, unused quote metadata and a mistaken output kind do not discard a grounded answer',()=>{
  const result=prepareWorkbenchAnswer(JSON.stringify({status:'answer',answer_kind:'session_control',answer:grounded,confidence:'model metadata',exact_quotes:[{chunk_id:source.chunk_id,quote:'source supports'}]}),context)!;
  assert.equal(result.value.answer,grounded);assert.equal(result.value.answer_kind,'paper_fact');assert.equal(result.value.exact_quotes.length,0);assert.equal(result.needsCitationRepair,false);
});

test('structured answer bodies and unambiguous text fields remain readable content',()=>{
  const data=[{method:'Local attention',evidence:`[cite:${source.chunk_id}]`}];
  const structured=prepareWorkbenchAnswer(JSON.stringify({status:'answer',answer:data}),context)!;
  assert.equal(structured.value.answer,JSON.stringify(data,null,2));assert.equal(structured.value.status,'answer');
  const alternative=prepareWorkbenchAnswer(JSON.stringify({status:'success',response:grounded}),context)!;
  assert.equal(alternative.value.answer,grounded);
});

test('an unmatched quote annotation is a visible limitation, while a verified quote gets its actual Unicode span',()=>{
  const good=prepareWorkbenchAnswer(JSON.stringify({status:'answer',answer:`A😀 [cite:${source.chunk_id}]`,exact_quotes:[{chunk_id:source.chunk_id,quote:'A😀'}]}),context)!;
  assert.deepEqual(good.value.exact_quotes,[{chunk_id:source.chunk_id,quote:'A😀',start:0,end:2}]);
  const bad=prepareWorkbenchAnswer(JSON.stringify({status:'answer',answer:`A changed quotation [cite:${source.chunk_id}]`,exact_quotes:[{chunk_id:source.chunk_id,quote:'A changed quotation'}]}),context)!;
  assert.ok(bad.value.answer.startsWith('A changed quotation'));assert.equal(bad.value.status,'partial');assert.equal(bad.value.exact_quotes.length,0);assert.match(bad.value.answer,/标注未能与原文对应/);
});

test('an invalid citation is never converted into a fabricated source link',()=>{
  const result=prepareWorkbenchAnswer(grounded+' Other detail [cite:unseen].',context)!;
  assert.equal(result.value.status,'partial');assert.ok(result.value.answer.includes(grounded));assert.ok(!result.value.answer.includes('[cite:unseen]'));assert.match(result.value.answer,/引用未定位/);assert.equal(result.needsCitationRepair,true);
  const absent=prepareWorkbenchAnswer('A generated explanation without a source.',{...context,evidence:new Map()})!;
  assert.equal(absent.value.status,'partial');assert.match(absent.value.answer,/尚未关联到论文原文/);assert.equal(absent.needsCitationRepair,false);
});

test('missing coverage metadata is derived from actual per-paper citations, without forcing IDs into the body',()=>{
  const second={...source,paper_id:'p2',chunk_id:'other-source'},sources=new Map([[source.chunk_id,source],[second.chunk_id,second]]);
  const complete=prepareWorkbenchAnswer(grounded+'\n\nSecond paper method [cite:other-source]',{...context,evidence:sources,requiredPapers:['p1','p2']})!;
  assert.equal(complete.value.status,'answer');assert.deepEqual(complete.value.paper_coverage?.map(p=>p.status),['addressed','addressed']);assert.deepEqual(complete.notices,[]);
  const partial=prepareWorkbenchAnswer(grounded,{...context,evidence:sources,requiredPapers:['p1','p2']})!;
  assert.equal(partial.value.status,'partial');assert.equal(partial.value.paper_coverage?.[1].status,'insufficient');assert.match(partial.value.answer,/p2/);
});

test('a complete answer body survives incomplete metadata, long output and a fallible evidence hint',()=>{
  const incomplete=`{"status":"answer","answer":${JSON.stringify(grounded)},"exact_quotes":[`;
  assert.equal(prepareWorkbenchAnswer(incomplete,context)?.value.answer,grounded);
  const long='研究说明。'.repeat(5000)+grounded;assert.equal(prepareWorkbenchAnswer(JSON.stringify({answer:long}),context)?.value.answer,long);
  const hinted=prepareWorkbenchAnswer(grounded,{...context,allowAnswer:false,truncated:true})!;assert.equal(hinted.value.status,'partial');assert.ok(hinted.value.answer.startsWith(grounded));assert.match(hinted.value.answer,/输出长度上限/);
  const prose='这里展示示例 {"answer":"example"}，然后继续说明。';assert.ok(prepareWorkbenchAnswer(prose,{...context,expectedKind:'session_control'})?.value.answer.startsWith(prose));
  assert.equal(prepareWorkbenchAnswer('{"status":"answer","exact_quotes":[]}',context),null);
});

test('source improvement and explicit withdrawal take priority when selecting a correction',()=>{
  const first=prepareWorkbenchAnswer(grounded+' [cite:bad]',context)!;
  const worse=prepareWorkbenchAnswer('A shorter unlinked claim.',context)!;
  assert.equal(preferWorkbenchAnswer(first,worse),first);
  const refusal=prepareWorkbenchAnswer(JSON.stringify({status:'refusal',answer:'现有原文不足以支持这个结论。'}),context)!;
  assert.equal(preferWorkbenchAnswer(first,refusal),refusal);
});

test('the workbench returns ordinary factual text with two requests and no cosmetic repair',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply(grounded)]);
  try{const result=await setup.harness.runTurn('p1 的研究方法是什么？',['p1'],'workbench/plain');assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,grounded);assert.equal(result.requests.length,2);assert.equal(result.answer_policy,'workbench-v1');assert.equal(result.generation_failures,undefined);}
  finally{setup.harness.dispose();}
});

test('one selected paper resolves an explicit paper pronoun without an unnecessary clarification',async()=>{
  const setup=await f([reply(JSON.stringify({intent:'answer',targets:[],queries:[],clarification:{question:'你指哪篇论文？',reference_quote:'这篇'}})),reply(grounded)]);
  try{const result=await setup.harness.runTurn('这篇论文采用了什么方法？',['p1'],'workbench/resolved-paper');assert.equal(result.status,'completed',result.error??'');assert.equal(result.question_preparation.result?.frame.ambiguity,null);assert.deepEqual(result.question_preparation.result?.frame.ordered_targets,['p1']);assert.equal(setup.calls.length,1);assert.equal(result.final_answer,grounded);}
  finally{setup.harness.dispose();}
});

test('one unsuccessful citation repair retains the usable candidate and its original source context',async()=>{
  const original=grounded+' 另一处细节 [cite:unknown]';
  const setup=await f([reply(JSON.stringify(preparation)),reply(original),reply('')],{maxRequests:3});
  try{const result=await setup.harness.runTurn('p1 的研究方法是什么？',['p1'],'workbench/repair');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,3);assert.ok(result.final_answer.startsWith(grounded));assert.equal(result.final_request_id,result.requests[1].request_id);assert.deepEqual(result.citation_validity.unknown_ids,[]);assert.match(result.final_answer,/引用未定位/);
    const snapshot=setup.harness.snapshot();assert.equal(snapshot.state.answer_policy,'workbench-v1');assert.ok(JSON.stringify(snapshot.state).includes('引用未定位'));assert.ok(!JSON.stringify(snapshot.state).includes('[cite:unknown]'),'the next turn must see the normalized reply, not an invalid raw citation');
  }finally{setup.harness.dispose();}
});

test('a later provider failure retains an existing answer without hiding the actual failed request',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply(grounded+' [cite:bad]'),reply('',{stopReason:'error',errorMessage:'Temporary provider failure'})],{maxRequests:3});
  try{const result=await setup.harness.runTurn('p1 的研究方法',['p1'],'workbench/provider-failed');assert.equal(result.status,'error');assert.equal(result.failure_code,'MODEL_ERROR');assert.ok(result.final_answer.startsWith(grounded));assert.match(result.final_answer,/已生成内容已保留/);assert.equal(result.requests.length,3);assert.equal(result.requests[2].status,'error');assert.equal(result.final_request_id,result.requests[1].request_id);}
  finally{setup.harness.dispose();}
});

test('the final request returns a source-linked body even if the model also attempts a closed tool',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply([{type:'text',text:grounded},call('retrieve_chunks',{query:'extra',paper_ids:['p1']})],{stopReason:'toolUse'})],{maxRequests:2});
  try{const result=await setup.harness.runTurn('p1 的研究方法',['p1'],'workbench/late-tool');assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,grounded);assert.equal(result.requests.length,2);assert.equal(setup.calls.length,1);assert.ok(result.tools.some(tool=>tool.status==='rejected'));}
  finally{setup.harness.dispose();}
});

test('the final request may keep an unlinked partial answer and never overspend the request limit',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply('这是一份模型已经生成的回答。')],{maxRequests:2});
  try{const result=await setup.harness.runTurn('p1 的研究方法',['p1'],'workbench/last-request');assert.equal(result.status,'completed',result.error??'');assert.equal(result.business_status,'partial');assert.ok(result.final_answer.startsWith('这是一份模型已经生成的回答。'));assert.equal(result.requests.length,2);assert.match(result.final_answer,/尚未关联到论文原文/);}
  finally{setup.harness.dispose();}
});

test('an optional check formatting failure keeps actual retrieval and reserves final generation',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply('not a check object'),reply(grounded)],{controls:{...controls,reflect:true},maxRequests:3});
  try{const result=await setup.harness.runTurn('p1 的方法',['p1'],'workbench/check');assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,grounded);assert.deepEqual(result.requests.map(r=>r.stage),['question_preparation','evidence_check','generate']);assert.ok(result.reliability_adaptations.some(item=>item.kind==='optional_check_unavailable'));}
  finally{setup.harness.dispose();}
  const tight=await f([reply(JSON.stringify(preparation)),reply(grounded)],{controls:{...controls,reflect:true},maxRequests:2});
  try{const result=await tight.harness.runTurn('p1 的方法',['p1'],'workbench/reserve');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,2);}
  finally{tight.harness.dispose();}
});

test('workbench follow-up and recovery retain normalized visible dialogue and policy binding',async()=>{
  const setup=await f([reply(JSON.stringify(preparation)),reply(grounded),reply(JSON.stringify(preparation)),reply('补充说明。'+grounded)]);let snapshot;
  try{await setup.harness.runTurn('p1 的研究方法是什么？',['p1'],'workbench/first');const next=await setup.harness.runTurn('继续说它的输入',['p1'],'workbench/next');assert.equal(next.status,'completed',next.error??'');snapshot=setup.harness.snapshot();assert.equal(snapshot.state.dialogue.length,2);}
  finally{setup.harness.dispose();}
  await assert.rejects(mainFixture([],[[0]],{controls,controlledSnapshot:snapshot}),/Answer policy differs/);
  const restored=await f([reply(JSON.stringify(preparation)),reply(grounded)],{controlledSnapshot:snapshot});
  try{const result=await restored.harness.runTurn('继续这个问题',['p1'],'workbench/restored');assert.equal(result.status,'completed',result.error??'');}
  finally{restored.harness.dispose();}
});

test('a per-paper retrieval failure leaves other sources usable; malformed source identity still stops',async()=>{
  const papers=[{paper_id:'p1',title:'Paper One',abstract:''},{paper_id:'p2',title:'Paper Two',abstract:''}],raw={...source,paragraph_id:'p1:s0:p0',citation:`[${source.chunk_id}]`,truncated:false,section:'Methods',start:0,end:Array.from(source.text).length,index_version:PREPARED_INDEX};
  const index=new Map([[raw.chunk_id,{...raw,text_sha256:createHash('sha256').update(raw.text).digest('hex')}]]);
  const setup=await f([reply(JSON.stringify({intent:'compare',targets:['p1','p2'],queries:['methods']})),reply(grounded+'\n\np2 的原文暂未取得，不能据此判断其方法。')],{
    knownPaperIds:new Set(['p1','p2']),selectedScopeCoverage:true,
    p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,evidenceIndex:index,publicPapers:papers,reflect:false,structuredMemory:true},
    worker:{async request(_method,params){if('paper_ids' in params&&params.paper_ids.includes('p2'))throw new RuntimeFailure('WORKER_TIMEOUT','temporary retrieval failure');return {backend:'rrf_rerank',index_version:PREPARED_INDEX,chunks:[raw]};}}
  });
  try{const result=await setup.harness.runTurn('逐篇分析选择的论文',['p1','p2'],'workbench/partial-tools');assert.equal(result.status,'completed',result.error??'');assert.equal(result.business_status,'partial');assert.equal(result.requests.length,2);assert.ok(result.tools.some(t=>t.status==='error'));assert.deepEqual(result.final_structure?.paper_coverage?.map(p=>p.status),['addressed','insufficient']);assert.ok(result.final_answer.startsWith(grounded));}
  finally{setup.harness.dispose();}
  const invalid=await f([reply(JSON.stringify(preparation))],{worker:{async request(){return {backend:'rrf_rerank',index_version:'wrong-index',chunks:[raw]};}}});
  try{const result=await invalid.harness.runTurn('p1 的研究方法',['p1'],'workbench/invalid-source');assert.equal(result.status,'error');assert.equal(result.failure_code,'INVALID_RESPONSE');assert.equal(result.requests.length,1);}
  finally{invalid.harness.dispose();}
});
