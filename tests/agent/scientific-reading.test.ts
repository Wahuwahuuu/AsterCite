import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {sha} from '../../agent/config.ts';
import {ScientificReading,scientificContentType,withScientificReading} from '../../agent/scientific-reading.ts';
import {createPaperTools,validatePaperParams,type ToolContext} from '../../agent/tools.ts';
import {TurnLedger} from '../../agent/ledger.ts';
import type {Chunk,P2HarnessConfig,RetrieveParams,RetrieveResult,WorkerTransport} from '../../agent/contracts.ts';
import {webTurn} from '../../agent/web-session.ts';
import {mainFixture,preparation,PREPARED_INDEX} from './main-fixture.ts';

const paper='1908.10084',index='reading-fixture';
const table='### Table 1: Scores (%)\n\n| Model | Score (%) | Objective |\n| --- | --- | --- |\n'+Array.from({length:25},(_,i)=>`| Encoder ${i} | 89.2 | $\\frac{a}{b}$ ${'notes '.repeat(16)} |`).join('\n');
const block={kind:'table',text:table,section:'Table 1: Scores (%)',locator:'T1',format:'markdown'};
function config():P2HarnessConfig{return {profile:'B',indexVersion:index,evidenceIndex:new Map(),publicPapers:[{paper_id:paper,title:'Study',abstract:'Complete abstract.'}]};}
async function cache(root:string){
  const original='<article><table><tr><td>fixture</td></tr></table></article>',digest=sha(original),directory=join(root,'.cache/scientific-reading',sha(index).slice(0,16));await mkdir(directory,{recursive:true});
  const data={version:'scientific-html-v1',index_version:index,paper_id:paper,original_sha256:digest,source_url:`https://arxiv.org/html/${paper}v1`,blocks:[block],blocks_sha256:sha(JSON.stringify([block]))};
  await writeFile(join(directory,paper+'.html'),original);await writeFile(join(directory,paper+'.json'),JSON.stringify(data));return {data,directory};
}
function toolContext(p2:P2HarnessConfig,workbench=true):ToolContext{return {knownPaperIds:new Set([paper]),getScope:()=>[paper],getLedger:()=>new TurnLedger('reading',[paper],[],12,20,true),p2,workbench};}
function read(worker:WorkerTransport,ctx:ToolContext,args:RetrieveParams){const execute=createPaperTools(worker,ctx)[1].execute as unknown as (id:string,args:RetrieveParams)=>Promise<{details:RetrieveResult}>;return execute('read-'+String(args.offset??0),args);}

test('original scientific content requests differ from asking for a table-shaped answer',()=>{
  assert.equal(scientificContentType('用表格总结论文的方法'),undefined);
  assert.equal(scientificContentType('present in a table'),undefined);
  assert.equal(scientificContentType('解释论文表 2 的数值'),'table');
  assert.equal(scientificContentType('解释损失函数的公式'),'equation');
  assert.equal(scientificContentType('读取表格和公式'),'all');
  assert.equal(scientificContentType('不要表格，也不需要公式'),undefined);
});

test('product retrieval expands and pages; strict retrieval retains its original five-source contract',async()=>{
  const chunks:Chunk[]=Array.from({length:12},(_,i)=>{const text=`Source ${i} gives an independent result.`;return {paper_id:paper,paragraph_id:'p'+i,chunk_id:'s'+i,section:'Results',start:0,end:text.length,text,citation:`[s${i}]`,index_version:index,truncated:false};});
  const p2=config();p2.evidenceIndex=new Map(chunks.map(c=>[c.chunk_id,{...c,index_version:index,text_sha256:sha(c.text)}]));
  const requests:RetrieveParams[]=[];const worker:WorkerTransport={async request(_method,value){const args=value as RetrieveParams;requests.push(args);const offset=args.offset??0,selected=chunks.slice(offset,offset+(args.top_k??5));return {backend:'rrf_rerank',index_version:index,chunks:selected,...(args.reading_mode?{selection:{offset,returned:selected.length,total:chunks.length,next_offset:offset+selected.length,has_more:offset+selected.length<chunks.length}}:{})};}};
  const ctx=toolContext(p2),first=await read(worker,ctx,{paper_ids:[paper],query:'results'});
  assert.equal(first.details.chunks.length,8);assert.equal(requests[0].top_k,8);assert.equal(requests[0].reading_mode,'workbench-v1');assert.equal(first.details.selection?.next_offset,8);
  const rest=await read(worker,ctx,{paper_ids:[paper],query:'results',offset:8,top_k:20});
  assert.equal(rest.details.chunks.length,4);assert.equal(rest.details.selection?.has_more,false);
  assert.throws(()=>validatePaperParams('retrieve_chunks',{query:'results',paper_ids:[paper],top_k:6},toolContext(p2,false)),/allowed range/u);
  await read(worker,toolContext(p2,false),{query:'results',paper_ids:[paper]});
  assert.equal(requests.at(-1)?.top_k,5);assert.equal(requests.at(-1)?.reading_mode,undefined);
});

test('structured reading registers whole source objects and restores them without touching base identities',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-scientific-'));try{
    const saved=await cache(root),base=config();let registry:ScientificReading;
    const worker:WorkerTransport={async request(){throw new Error('Structured pagination must not fall back to plain text');},async readScientificSources(params){const sources=[...registry.sources.values()];const chunks=params.offset?[]:sources;return {backend:'scientific-html-v1',index_version:index,chunks,selection:{offset:params.offset,returned:chunks.length,total:1,next_offset:params.offset+chunks.length,has_more:false,unavailable_papers:[]}};}};
    registry=await ScientificReading.open(root,index,new Set([paper]),worker);assert.equal(registry.sources.size,1);
    const copied=withScientificReading({...base,scientificSources:registry});assert.equal(base.evidenceIndex.size,0);assert.equal(copied.evidenceIndex.size,1);
    assert.equal(withScientificReading(copied).evidenceIndex.size,1);
    const source=[...registry.sources.values()][0];assert.ok(source.text.length>2000);assert.equal(source.text,table);assert.equal(source.format,'markdown');assert.ok(source.source_url?.endsWith('#T1'));
    const result=await read(worker,toolContext(copied),{paper_ids:[paper],query:'table 1',content_type:'table',top_k:12});
    assert.equal(result.details.chunks[0].text,table);assert.equal(result.details.chunks[0].content_type,'table');
    const after=await read(worker,toolContext(copied),{paper_ids:[paper],query:'table 1',content_type:'table',offset:1});assert.equal(after.details.chunks.length,0);
    const restored=await ScientificReading.open(root,index,new Set([paper]),worker);assert.deepEqual([...restored.identities],[...registry.identities]);
    await assert.rejects(registry.retrieve({paper_ids:['foreign'],query:'x',top_k:8,offset:0,content_type:'table'}),/Unknown structured-reading paper/u);
    saved.data.blocks[0]={...block,text:table+' forged'};await writeFile(join(saved.directory,paper+'.json'),JSON.stringify(saved.data));
    await assert.rejects(registry.retrieve({paper_ids:[paper],query:'x',top_k:8,offset:0,content_type:'table'}),/blocks changed/u);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('a forged or unrelated long source cannot bypass the normal excerpt contract',async()=>{
  const p2=config(),ctx=toolContext(p2),text='invented'.repeat(400),chunk={paper_id:paper,paragraph_id:'fake',chunk_id:'fake',section:'Results',text,start:0,end:text.length,index_version:index,citation:'[fake]',truncated:false};
  await assert.rejects(read({async request(){return {backend:'rrf_rerank',index_version:index,chunks:[chunk]};}},ctx,{query:'x',paper_ids:[paper]}),/range or paper scope/u);
});

test('the real harness accepts more than five sources and the web response exposes every cited source',async()=>{
  const chunks:Chunk[]=Array.from({length:12},(_,i)=>{const text=`Experiment ${i} has a verified independent result.`;return {paper_id:'p1',paragraph_id:'p'+i,chunk_id:`${PREPARED_INDEX}:p1:s0:p${i}:c0-${text.length}`,section:'Results',start:0,end:text.length,text,index_version:PREPARED_INDEX,truncated:false};});
  const answer='逐项说明：\n\n'+chunks.map((c,i)=>`${i+1}. 实验 ${i} 报告了结果 [cite:${c.chunk_id}]。`).join('\n');
  const requests:RetrieveParams[]=[],setup=await mainFixture([reply(JSON.stringify(preparation)),reply([call('retrieve_chunks',{query:'additional results',paper_ids:['p1'],top_k:12})],{stopReason:'toolUse'}),reply(answer)],[],{
    answerPolicy:'workbench-v1',controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)},
    p2:{...config(),indexVersion:PREPARED_INDEX,executionVersion:'full-v1',nlu:true,reflect:false,structuredMemory:true,publicPapers:[{paper_id:'p1',title:'Study',abstract:'Navigation'}],evidenceIndex:new Map(chunks.map(c=>[c.chunk_id,{...c,index_version:PREPARED_INDEX,text_sha256:sha(c.text)}]))},
    worker:{async request(_method,value){const args=value as RetrieveParams;requests.push(args);return {backend:'rrf_rerank',index_version:PREPARED_INDEX,chunks:chunks.slice(0,args.top_k??5).map(c=>({...c,citation:`[${c.chunk_id}]`}))};}}});
  try{const record=await setup.harness.runTurn('逐项说明论文 p1 的全部实验结果',['p1'],'reading-twelve');assert.equal(record.status,'completed',record.error??'');assert.ok(requests.some(r=>r.top_k===12));assert.equal(record.citation_validity.cited_ids.length,12);assert.equal(webTurn(record,'question',[],new Map(chunks.map(c=>[c.chunk_id,c]))).sources.length,12);}
  finally{setup.harness.dispose();}
});
