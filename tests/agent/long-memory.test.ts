import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {LongTermMemory,MemoryOwners,memoryProjection,type LongMemoryEntry,type MemoryRecall} from '../../agent/long-term-memory.ts';
import {RuntimeFailure,type WorkerTransport} from '../../agent/contracts.ts';
import {DomainMemory} from '../../agent/domain-memory.ts';
import {createWebServer} from '../../agent/web-server.ts';
import {PaperWebSession,type WebView,type WebSessionPort} from '../../agent/web-session.ts';
import {parseConfig,sha} from '../../agent/config.ts';
import type {Assets} from '../../agent/assets.ts';
import {isMemorySessionInput} from '../../agent/question-preparation.ts';
import {mainFixture,preparation,SOURCE_IDS,PREPARED_INDEX} from './main-fixture.ts';
import {parseMemoryDigest} from '../../agent/memory-synthesis.ts';

const papers=[{paper_id:'p1',title:'Study One',abstract:'Original abstract'},{paper_id:'p2',title:'Study Two',abstract:'Another abstract'}];
function worker(){const records=new Map<string,Map<string,LongMemoryEntry>>(),slots=new Map<string,string>();let fail=false;
  const port:WorkerTransport={async request(){throw new Error('No paper calls from memory management');},async memoryOperation(raw){if(fail)throw new Error('private upstream failure');const owner=String(raw.owner),action=raw.action;let rows=records.get(owner);if(!rows){rows=new Map();records.set(owner,rows);}
    const save=(value:unknown)=>{const entry=value as Partial<LongMemoryEntry>;const stable=owner+':'+entry.slot,id=entry.id??(entry.slot?slots.get(stable):undefined)??randomUUID();if(entry.slot)slots.set(stable,id);const old=rows.get(id),stamp=new Date().toISOString(),saved={id,kind:entry.kind!,content:entry.content!,paper_ids:entry.paper_ids??[],source_session:entry.source_session??'',source_turn:entry.source_turn??'',created_at:old?.created_at??stamp,updated_at:stamp,slot:entry.slot??'',edited:entry.edited===true};rows.set(id,saved);return saved;};
    if(action==='list')return {backend:'qdrant-edge',entries:[...rows.values()],total:rows.size,next_cursor:null};
    if(action==='recall')return {backend:'qdrant-edge',entries:[...rows.values()].filter(row=>row.kind==='preference'||!raw.preferences_only&&(!(raw.paper_ids as string[])?.length||!row.paper_ids.length||row.paper_ids.some(id=>(raw.paper_ids as string[]).includes(id)))).slice(0,25)};
    if(action==='upsert')return {entry:save(raw.entry)};
    if(action==='upsert_batch')return {entries:(raw.entries as unknown[]).map(save)};
    if(action==='delete'){if(!rows.has(String(raw.id)))throw new RuntimeFailure('INVALID_PARAMS','missing');rows.delete(String(raw.id));}
    if(action==='clear')rows.clear();if(action==='delete_session')for(const [id,row] of rows)if(row.source_session===raw.source_session)rows.delete(id);
    return {deleted:true};}};return {port,records,fail:()=>{fail=true;}};
}

test('memory identities persist without storing their raw credentials and cannot impersonate another browser',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-memory-owner-'));try{const store=new MemoryOwners(root),first=await store.create(),second=await store.create(),owner=await store.authenticate(first.credential);assert.equal(owner.enabled,true);assert.notEqual(owner.id,(await store.authenticate(second.credential)).id);
    assert.equal((await store.configure(first.credential,false)).enabled,false);assert.equal((await new MemoryOwners(root).authenticate(first.credential)).enabled,false);
    await assert.rejects(store.authenticate(owner.id+'.'+second.credential.split('.')[1]),/differs/u);
    const saved=await readFile(join(root,'.local/memory/owners',owner.id+'.json'),'utf8');assert.ok(!saved.includes(first.credential.split('.')[1]));
  }finally{await rm(root,{recursive:true,force:true});}
});

test('completed reading and explicit preferences cross sessions, update without duplicates and remain owner scoped',async()=>{
  const f=worker(),first=new LongTermMemory(f.port,'cli:local',papers),state=new DomainMemory(PREPARED_INDEX).state,turn=randomUUID();
  const domain=new DomainMemory(PREPARED_INDEX,state);domain.rememberAnswer(turn,'解释 p1 的实验','这是论文原文支持的阅读说明。',['p1'],['source'],'answer');
  const saved=await first.remember('session-one',turn,'以后用中文回答，记住：我正在研究情感分析',domain.state,'completed');assert.ok(saved.saved>=2);
  const reopened=new LongTermMemory(f.port,'cli:local',papers),recall=await reopened.recall('继续研究情感分析',['p1']);assert.equal(recall.status,'ready');assert.ok(recall.items.some(row=>row.kind==='preference'&&row.content.includes('中文')));assert.ok(recall.items.some(row=>row.kind==='reading'&&row.source_session==='session-one'));
  await reopened.remember('session-two',randomUUID(),'以后用英文回答',state,'completed');assert.equal((await reopened.list()).entries.filter(row=>row.slot==='preference:language').length,1);assert.ok((await reopened.list()).entries.some(row=>row.slot==='preference:language'&&row.content.includes('英文')));
  await reopened.remember('session-two',randomUUID(),'以后不要用英文，用中文回答；不要简短，要详细解释',state,'completed');const updated=(await reopened.list()).entries;assert.ok(updated.find(row=>row.slot==='preference:language')?.content.includes('中文'));assert.ok(updated.find(row=>row.slot==='preference:detail')?.content.includes('详细'));
  await reopened.remember('session-two',randomUUID(),'以后不要用英文，回答不要过于简短',state,'completed');const negative=(await reopened.list()).entries;assert.ok(negative.find(row=>row.slot==='preference:language')?.content.includes('不要用英文'));assert.ok(negative.find(row=>row.slot==='preference:detail')?.content.includes('不要过于简短'));
  const other=new LongTermMemory(f.port,'web:'+randomUUID(),papers);assert.equal((await other.list()).total,0);
  await reopened.removeSession('session-one');assert.ok((await reopened.list()).entries.every(row=>row.source_session!=='session-one'));
});

test('ordinary one-turn formatting instructions are not made permanent and credentials never enter memory',async()=>{
  const f=worker(),memory=new LongTermMemory(f.port,'cli:local',papers,['fixture-private-model-key']),state=new DomainMemory(PREPARED_INDEX).state;
  await memory.remember('session',randomUUID(),'这次请用表格回答',state,'completed');assert.equal((await memory.list()).total,0);
  await memory.remember('session',randomUUID(),'记住我正在研究情感分析',state,'completed');assert.ok((await memory.list()).entries.some(row=>row.content==='我正在研究情感分析'));await memory.clear();
  await assert.rejects(memory.save({kind:'note',content:'api_key=fixture-private-model-key'}),/凭证/u);
  await assert.rejects(memory.save({kind:'note',content:'我的密码是fixture-only'}),/凭证/u);
  await memory.remember('session',randomUUID(),'记住：fixture-private-model-key',state,'completed');assert.equal((await memory.list()).total,0);
  const paused=new LongTermMemory(f.port,'cli:local',papers,[],false);assert.equal((await paused.recall('解释论文',['p1'])).status,'disabled');assert.equal((await paused.remember('session',randomUUID(),'以后用中文',state,'completed')).saved,0);
  f.fail();assert.equal((await memory.recall('question',[])).status,'unavailable');assert.equal((await memory.remember('session',randomUUID(),'以后用中文回答',state,'completed')).saved,0);
});

test('reading memory is condensed and consolidated by paper across turns and sessions',async()=>{
  const f=worker(),memory=new LongTermMemory(f.port,'cli:local',papers),domain=new DomainMemory(PREPARED_INDEX);
  domain.rememberAnswer('turn-one','解释实验方法','完整回答不能直接保存。'.repeat(60),['p1'],['source'],'answer');
  await memory.remember('session-one','turn-one','解释实验方法',domain.state,'completed');
  const first=(await memory.list()).entries[0];assert.equal(first.slot,'reading:v2:p1');assert.ok(first.content.includes('实验')||first.content.includes('研究方法'));assert.ok(!first.content.includes('完整回答不能直接保存'));assert.ok(first.content.length<300);
  domain.rememberAnswer('turn-two','继续讲实验结果','另一个完整回答。'.repeat(80),['p1'],['source'],'answer');
  await memory.remember('session-two','turn-two','继续讲实验结果',domain.state,'completed',{version:2,readings:[{paper_id:'p1',topic:'实验结果',progress:'已阅读结果，待核对消融设置',key_points:[],open_questions:['消融实验如何控制变量？']}]});
  const second=(await memory.list()).entries;assert.equal(second.length,1);assert.equal(second[0].id,first.id);assert.equal(second[0].source_session,'session-two');assert.ok(second[0].content.includes('消融实验如何控制变量'));assert.ok(!second[0].content.includes('另一个完整回答'));
});

test('memory synthesis uses one admitted auxiliary request and failures never discard the completed answer',async()=>{
  for(const failed of [false,true]){
    const synthesis=failed?reply('',{stopReason:'error',errorMessage:'memory unavailable'}):reply(JSON.stringify({readings:[{paper_id:'p1',topic:'研究方法',progress:'已讨论方法',key_points:[{text:'原文给出了相关说明',chunk_id:SOURCE_IDS[0],quote:'A😀 source'}],open_questions:[]}]}));
    const setup=await mainFixture([reply(JSON.stringify(preparation)),reply(`已完成说明 [cite:${SOURCE_IDS[0]}]。`),synthesis],[[0]],{answerPolicy:'workbench-v1',controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)}});
    try{setup.harness.setLongTermMemory({status:'ready',items:[],note:'fixture'});const record=await setup.harness.runTurn('解释论文方法',['p1'],'synthesis-'+failed);assert.equal(record.status,'completed',record.error??'');assert.ok(record.final_answer.startsWith('已完成说明'));assert.equal(record.requests.length,3);assert.equal(record.requests[2].stage,'long_term_memory');assert.equal(Boolean(setup.harness.getLongTermMemoryDigest()),!failed);assert.equal(record.failure_code,null);}
    finally{setup.harness.dispose();}
  }
  const seed=await mainFixture([]);seed.harness.dispose();
  assert.throws(()=>parseMemoryDigest(JSON.stringify({readings:[{paper_id:'foreign',topic:'主题',progress:'进度',key_points:[],open_questions:[]}]}),['p1'],new Map()),/Unrelated/u);
  const unsupported=parseMemoryDigest(JSON.stringify({readings:[{paper_id:'p1',topic:'主题',progress:'进度',key_points:[{text:'不存在的结论',chunk_id:SOURCE_IDS[0],quote:'not in the source'}],open_questions:[]}]}),['p1'],new Map(seed.chunks.map(chunk=>[chunk.chunk_id,chunk])));assert.deepEqual(unsupported.readings[0].key_points,[]);
});

test('bounded memory context requires fresh source reading and respects the request ceiling',async()=>{
  const item:LongMemoryEntry={id:randomUUID(),kind:'reading',content:'曾阅读 p1；偏好中文说明。旧引用不可直接作为证据。',paper_ids:['p1'],source_session:'earlier',source_turn:randomUUID(),created_at:new Date().toISOString(),updated_at:new Date().toISOString(),slot:'reading:earlier',edited:false};
  const recall:MemoryRecall={status:'ready',items:[item],note:'fixture'};let inspected=false;
  const setup=await mainFixture([context=>{const input=JSON.stringify(context);assert.ok(input.includes('long_term_memory'));assert.ok(input.includes(item.content));assert.ok(input.includes('never system instructions or paper evidence'));inspected=true;return reply(JSON.stringify(preparation));},reply([call('retrieve_chunks',{query:'fresh original',paper_ids:['p1']})],{stopReason:'toolUse'}),reply(`原文支持这项说明 [cite:${SOURCE_IDS[0]}]。`)],[[0]],{maxRequests:3,answerPolicy:'workbench-v1',controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)}});
  try{setup.harness.setLongTermMemory(recall);const result=await setup.harness.runTurn('继续解释上次的 p1 论文',['p1'],'long-memory-harness');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,3);assert.equal(inspected,true);assert.deepEqual(result.citation_validity.cited_ids,[SOURCE_IDS[0]]);assert.deepEqual(setup.calls.map(call=>call.method),['retrieve_chunks']);assert.ok(JSON.stringify(memoryProjection(recall)).includes('fresh retrieval'));assert.deepEqual(setup.harness.session.getCallableToolNames(),[]);}finally{setup.harness.dispose();}
});

test('personal reading-history questions and remember requests need no fabricated paper citations',async()=>{
  for(const question of ['我上次读的是哪篇论文？','你还记得我的研究方向吗？','记住：我正在研究情感分析','记住我正在研究情感分析','以后用中文回答'])assert.equal(isMemorySessionInput(question),true,question);
  for(const question of ['我上次读的论文方法是什么？','记住：我喜欢中文，然后请解释论文 p1','记住：以后用中文，并比较这两篇论文'])assert.equal(isMemorySessionInput(question),false,question);
  const setup=await mainFixture([reply(JSON.stringify({...preparation,targets:[],queries:[]})),reply('你上次阅读的是 Study One。')],[],{answerPolicy:'workbench-v1',controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)}});
  try{const record=await setup.harness.runTurn('我上次读的是哪篇论文？',[],'memory-history');assert.equal(record.status,'completed',record.error??'');assert.equal(record.final_answer,'你上次阅读的是 Study One。');assert.equal(setup.calls.length,0);assert.equal(record.requests.length,2);}finally{setup.harness.dispose();}
});

test('the web adapter writes Qdrant memory, uses it in a new conversation and keeps answers when memory fails',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-memory-adapter-')),seed=await mainFixture([]);seed.harness.dispose();const f=worker();
  const raw=JSON.parse(await readFile('configs/model.example.json','utf8'));raw.model.base_url='http://127.0.0.1:1/v1';raw.model.model_id='memory-fixture';raw.session.compaction='off';const config=parseConfig(raw);
  const assets:Assets={root,indexVersion:PREPARED_INDEX,publicPapers:papers,evidenceIndex:new Map(seed.chunks.map(c=>[c.chunk_id,{...c,index_version:PREPARED_INDEX,text_sha256:sha(c.text)}])),implementationId:'8'.repeat(64),commonPrompt:''};
  const port:WorkerTransport={...f.port,async request(){return {backend:'rrf_rerank',index_version:PREPARED_INDEX,chunks:[seed.chunks[0]]};}},memory=new LongTermMemory(port,'cli:local',papers,['fixture-model-secret']);let expectedPrior=false,observed=false;
  const open=async()=>{const directory=join(root,randomUUID());await mkdir(directory);return PaperWebSession.open({directory,assets,config,worker:port,sources:new Map(seed.chunks.map(c=>[c.chunk_id,c])),key:'fixture-model-secret',longTermMemory:memory,createHarness:async params=>{const {modelRuntime,model,...extra}=params;return (await mainFixture([context=>{if(expectedPrior){assert.ok(JSON.stringify(context).includes('实验与结果'));observed=true;}return reply(JSON.stringify(preparation));},...(expectedPrior?[reply([call('retrieve_chunks',{query:'fresh original',paper_ids:['p1']})],{stopReason:'toolUse'})]:[]),reply(JSON.stringify({answer:`原文支持这项说明 [cite:${SOURCE_IDS[0]}]。`,execution:{state:'complete',remaining_needs:[],needs_sources:!expectedPrior}}))],[[0]],{...extra,maxRequests:3})).harness;}});};
  try{
    let session=await open();await session.configure(['p1'],false);const first=await session.ask('解释 p1 的实验设计');assert.equal(first.turns[0].status,'completed');assert.equal(first.turns[0].memory_write?.saved,1);await session.close();
    expectedPrior=true;session=await open();await session.configure(['p1'],false);const second=await session.ask('继续阅读上次的 p1');assert.equal(second.turns.length,1);assert.equal(observed,true);assert.equal(second.turns[0].long_term_memory?.items.length,1);assert.equal(second.long_term_memory?.enabled,true);assert.equal(second.budget.model_attempts,3);await session.close();
    f.fail();expectedPrior=false;session=await open();const fallback=await session.ask('解释 p1');assert.equal(fallback.turns[0].status,'completed');assert.equal(fallback.turns[0].long_term_memory?.status,'unavailable');assert.equal(fallback.turns[0].memory_write?.saved,0);assert.ok(fallback.turns[0].answer.includes('原文支持'));await session.close();
  }finally{await rm(root,{recursive:true,force:true});}
});

test('memory HTTP routes isolate browser profiles, associate legacy conversations safely and clean up source notes',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-memory-http-')),f=worker(),empty:WebView={turns:[],scope:[],pending_compaction:false,budget:{turns_reserved:0,max_turns:20,model_attempts:0,request_limit_per_turn:12,remaining_turns:20},memory:{paper_id:null,comparison:[],dimensions:[],preferences:[]}};await mkdir(join(root,'web'));await writeFile(join(root,'web/index.html'),'fixture');
  const bound:string[]=[];const server=await createWebServer({root,mode:'live',papers,memoryFactory:owner=>new LongTermMemory(f.port,'web:'+owner.id,papers,[],owner.enabled),factory:async(_dir,context):Promise<WebSessionPort>=>{if(context?.longTermMemory)bound.push('bound');return {view:async()=>structuredClone(empty),ask:async()=>structuredClone(empty),configure:async()=>structuredClone(empty),close:async()=>{}};}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port;
  const request=(path:string,body?:unknown,headers:Record<string,string>={},method=body===undefined?'GET':'POST')=>fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json','X-AsterCite-Request':'1',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  try{
    const one=await (await request('/api/memory/profiles',{})).json(),two=await (await request('/api/memory/profiles',{})).json(),own={'X-AsterCite-Memory':one.credential};
    assert.equal((await request('/api/memory')).status,403);assert.equal((await request('/api/memory',{action:'save',content:'偏好中文'},own)).status,200);
    const first=await (await request('/api/memory',undefined,own)).json();assert.equal(first.total,1);assert.equal((await (await request('/api/memory',undefined,{'X-AsterCite-Memory':two.credential})).json()).total,0);
    assert.equal((await request('/api/memory',{action:'clear'},{...own,Origin:'https://different.invalid'})).status,403);
    const legacy=await (await request('/api/sessions',{})).json(),sessionHeaders={...own,'X-AsterCite-Session':legacy.token};
    assert.equal((await request('/api/sessions/'+legacy.id,undefined,sessionHeaders)).status,200);assert.equal(bound.length,1);
    const before=await readFile(join(root,'.local/web/sessions',legacy.id,'owner.json'),'utf8');assert.ok(!before.includes(one.credential));assert.equal(JSON.parse(before).memory_profile,one.credential.split('.')[0]);
    await request('/api/sessions/'+legacy.id,undefined,{'X-AsterCite-Session':legacy.token,'X-AsterCite-Memory':two.credential});assert.equal(bound.length,1,'Another profile must not attach to the old owner');
    const service=new LongTermMemory(f.port,'web:'+one.credential.split('.')[0],papers);await service.save({kind:'reading',content:'来源会话的阅读摘记',paper_ids:['p1'],source_session:legacy.id});
    assert.equal((await request('/api/sessions/'+legacy.id,undefined,sessionHeaders,'DELETE')).status,200);assert.ok((await service.list()).entries.every(row=>row.source_session!==legacy.id));
    const removed=first.entries[0].id;assert.equal((await request('/api/memory',{action:'delete',id:removed},{'X-AsterCite-Memory':two.credential})).status,400);assert.equal((await service.list()).total,1);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
