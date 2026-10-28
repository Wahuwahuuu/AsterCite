import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage as reply} from '@earendil-works/pi-ai';
import {mainFixture,preparation,SOURCE_IDS} from './main-fixture.ts';
import {PaperWebSession} from '../../agent/web-session.ts';
import {parseConfig,sha} from '../../agent/config.ts';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Assets} from '../../agent/assets.ts';
import type {MainHarnessOptions} from '../../agent/session-main-v2.ts';
const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
test('a pre-cancelled turn makes no model requests and retains a resumable stopped record',async()=>{
  const controller=new AbortController();controller.abort();
  const f=await mainFixture([],[[0]],{controls,answerPolicy:'workbench-v1'});
  try{const result=await f.harness.runTurn('解释方法',['p1'],'stopped-before-start',controller.signal);assert.equal(result.failure_code,'CANCELLED');assert.equal(result.requests.length,0);assert.equal(result.tasks?.phase,'stopped');assert.match(result.final_answer,/已停止/);assert.ok(f.harness.snapshot());}finally{f.harness.dispose();}
});
test('the web adapter saves stopped text, task states and budget, restores them, then accepts a new question',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-stop-')),seed=await mainFixture([]),raw=JSON.parse(await readFile('configs/model.example.json','utf8'));
  raw.model.base_url='https://example.invalid/v1';raw.model.model_id='fixture';raw.session.compaction='off';
  const assets:Assets={root,indexVersion:'prepared-fixture',publicPapers:[{paper_id:'p1',title:'Paper One',abstract:'catalog'}],evidenceIndex:new Map(seed.chunks.map(chunk=>[chunk.chunk_id,{...chunk,index_version:'prepared-fixture',text_sha256:sha(chunk.text)}])),implementationId:'8'.repeat(64),commonPrompt:''};
  const options={directory:root,assets,config:parseConfig(raw),sources:new Map(seed.chunks.map(chunk=>[chunk.chunk_id,chunk])),key:'fixture-stop-key',worker:{async request(){return {backend:'rrf_rerank',index_version:'prepared-fixture',chunks:[seed.chunks[0]]};}},createHarness:async(params:MainHarnessOptions)=>{const {modelRuntime,model,...extra}=params;return (await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({execution:{state:'complete',remaining_needs:[],needs_sources:true},answer:'已生成的说明。'.repeat(20)+`[cite:${SOURCE_IDS[0]}]`}))],[[0]],extra)).harness;}};
  let session:PaperWebSession|undefined;
  try{
    session=await PaperWebSession.open(options);await session.configure(['p1'],false);const id=randomUUID();
    const view=await session.ask('解释论文方法',undefined,update=>{if(update.text.length>12){assert.equal(session!.stop(randomUUID()),false);assert.equal(session!.stop(id),true);}},{request_id:id});
    assert.equal(view.turns[0].stopped,true);assert.match(view.turns[0].answer,/已生成的说明/);assert.equal(view.turns[0].tasks?.phase,'stopped');assert.equal(view.budget.model_attempts,2);assert.equal(session.stop(id),false);
    await session.close();session=await PaperWebSession.open(options);const restored=await session.view();assert.equal(restored.turns[0].answer,view.turns[0].answer);assert.deepEqual(restored.turns[0].tasks,view.turns[0].tasks);assert.equal(restored.budget.model_attempts,2);
    const next=await session.ask('继续解释');assert.equal(next.turns[1].status,'completed');assert.equal(next.budget.model_attempts,4);
  }finally{await session?.close();seed.harness.dispose();await rm(root,{recursive:true,force:true});}
});
test('stopping an active streamed response retains text, sources and actual attempts; the next turn works',async()=>{
  const controller=new AbortController();let cancelled=false;
  const body='已经生成的方法说明。'.repeat(30)+`[cite:${SOURCE_IDS[0]}]`;
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({execution:{state:'complete',remaining_needs:[],needs_sources:true},answer:body}))],[[0]],{controls,answerPolicy:'workbench-v1',onAnswerUpdate:update=>{if(!cancelled&&update.text.length>20){cancelled=true;controller.abort();}}});
  try{
    const result=await f.harness.runTurn('解释方法',['p1'],'stopped-stream',controller.signal);assert.equal(result.failure_code,'CANCELLED');assert.match(result.final_answer,/已经生成的方法说明/);assert.match(result.final_answer,/已停止/);assert.equal(result.tasks?.phase,'stopped');assert.equal(result.requests.length,2);assert.ok(result.requests.every(request=>request.http_attempts<=1));
    f.faux.setResponses([reply(JSON.stringify(preparation)),reply(JSON.stringify({execution:{state:'complete',remaining_needs:[],needs_sources:true},answer:`继续解释。[cite:${SOURCE_IDS[0]}]`}))]);
    const next=await f.harness.runTurn('继续解释',['p1'],'next-turn');assert.equal(next.status,'completed',next.error??'');assert.match(next.final_answer,/继续解释/);assert.notEqual(next.tasks?.phase,'stopped');
  }finally{f.harness.dispose();}
});
