import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {fitPreparationHistory} from '../../agent/preparation-history.ts';
import {preparationPayload} from '../../agent/question-preparation.ts';
import {estimateVisibleContext} from '../../agent/workbench-context.ts';
import type {DialogueRecord} from '../../agent/domain-memory.ts';
import {sha} from '../../agent/config.ts';
import {mainFixture,preparation,SOURCE_IDS,PREPARED_INDEX} from './main-fixture.ts';

const measure=(payload:Record<string,unknown>)=>estimateVisibleContext({messages:[{role:'system',content:'Prepare the question using the actual supplied history.',timestamp:0},{role:'user',content:JSON.stringify(payload),timestamp:0}]});
const context={original:'最后一个方法的不足是什么？',allowed:new Set(['p1']),publicPapers:[{paper_id:'p1',title:'Paper One',abstract:''}],frameId:'frame',history:[] as DialogueRecord[],activeConstraints:[]};
const project=(history:DialogueRecord[],question:string,budget=25000,extra:Record<string,unknown>={})=>fitPreparationHistory({original_question:question,...extra},history,question,{maxInputTokens:budget,measure});

test('available context retains all six turns and the end of an answer beyond 4000 characters',()=>{
  const history=Array.from({length:6},(_,i)=>({turn_id:'turn-'+i,user_text:'问题 '+i,final_answer:'说明内容。'.repeat(1100)+`\n末尾方法 ${i}：独有细节。`}));
  const original=structuredClone(history),result=project(history,'最后一个方法的不足是什么？',50000);
  const rows=result.payload.recent_dialogue as Array<{turn_id:string;assistant_text:string}>;
  assert.equal(result.fits,true);assert.equal(rows.length,6);assert.deepEqual(rows.map(row=>row.assistant_text),history.map(turn=>turn.final_answer));
  assert.match(rows[5].assistant_text,/末尾方法 5/);assert.equal(result.info.omitted_turns,0);assert.deepEqual(result.info.excerpt_turn_ids,[]);assert.deepEqual(history,original);
});

test('an explicitly referenced old turn gets its full answer before unrelated recent replies consume the budget',()=>{
  const history=Array.from({length:8},(_,i)=>({turn_id:'old-'+i,user_text:`问题 ${i+1}`,final_answer:'背景说明。'.repeat(1000)+`\n旧轮次完整结尾 ${i+1}。`}));
  const result=project(history,'回到第2轮，最后一个方法的不足是什么？',8000);
  const rows=result.payload.recent_dialogue as Array<{turn_id:string;assistant_text:string}>;
  assert.equal(result.fits,true);assert.equal(rows.find(row=>row.turn_id==='old-1')?.assistant_text,history[1].final_answer);
  assert.equal(result.info.focus_complete,true);assert.ok(result.info.omitted_turns>0||result.info.excerpt_turn_ids.length>0);
  assert.ok(measure(result.payload)<=8000);assert.deepEqual(rows.map(row=>history.findIndex(turn=>turn.turn_id===row.turn_id)),rows.map(row=>history.findIndex(turn=>turn.turn_id===row.turn_id)).sort((a,b)=>a-b));
});

test('a reply too large for a single request has marked verbatim excerpts with its ending and Unicode ranges',()=>{
  const text='开头说明😀\n'+'很长的背景。'.repeat(10000)+'\n最后一个方法：尾部稀有方法😀，不足是缺少跨域验证。';
  const history=[{turn_id:'huge-reply',user_text:'先说明这几种方法',final_answer:text}],before=structuredClone(history);
  const result=project(history,'最后一个方法的不足是什么？',1600),row=(result.payload.recent_dialogue as Array<{assistant_text:string;assistant_text_truncated:boolean;assistant_original_codepoints:number;assistant_text_ranges:Array<{start:number;end:number}>}>)[0];
  assert.equal(result.fits,true);assert.equal(result.info.focus_complete,false);assert.equal(row.assistant_text_truncated,true);
  assert.match(row.assistant_text,/尾部稀有方法😀/);assert.match(row.assistant_text,/已省略原文/);assert.ok(!row.assistant_text.includes('\ufffd'));
  assert.equal(row.assistant_original_codepoints,Array.from(text).length);for(const range of row.assistant_text_ranges)assert.ok(row.assistant_text.includes(Array.from(text).slice(range.start,range.end).join('')));
  assert.deepEqual(history,before);assert.ok(measure(result.payload)<=1600);
});

test('long-term memory and fixed request fields consume the same input budget as dialogue',()=>{
  const history=[{turn_id:'t',user_text:'上轮问题',final_answer:'说明。'.repeat(2000)+'尾部内容'}];
  const base=project(history,'继续',2000),withMemory=project(history,'继续',2000,{long_term_memory:{items:[{content:'记忆内容。'.repeat(100)}]}});
  assert.equal(base.fits,true);assert.equal(withMemory.fits,true);assert.ok(JSON.stringify(withMemory.payload.recent_dialogue).length<JSON.stringify(base.payload.recent_dialogue).length);
  const overflow=project(history,'继续',1000,{public_catalog:'固定目录'.repeat(1000)});assert.equal(overflow.fits,false);assert.equal(overflow.info.included_turns,0);
});

test('a nonexistent explicit turn is marked unavailable rather than silently replaced by the last turn',()=>{
  const history=[{turn_id:'only-turn',user_text:'问题',final_answer:'回答'}],result=project(history,'第99轮最后一个方法是什么？');
  assert.equal(result.info.reference_unavailable,true);assert.equal(result.info.focus_complete,false);assert.deepEqual(result.info.focus_turn_ids,[]);
});

test('product projection gets the full archive while historical research retains its previous preparation contract',()=>{
  const history=Array.from({length:6},(_,i)=>({turn_id:'t-'+i,user_text:'问题',final_answer:'文字'.repeat(2500)+'END'}));
  const legacy=preparationPayload({...context,history},{}) as {recent_dialogue:Array<{assistant_text:string}>};
  const product=preparationPayload({...context,history},{},undefined,true) as {recent_dialogue:Array<{assistant_text:string}>};
  assert.equal(legacy.recent_dialogue.length,4);assert.equal(Array.from(legacy.recent_dialogue[0].assistant_text).length,4000);
  assert.equal(product.recent_dialogue.length,6);assert.equal(product.recent_dialogue[0].assistant_text,history[0].final_answer);
});

test('the actual workbench preparation request recovers a long answer ending after reopening its saved session',async()=>{
  const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
  const answer='解释内容。'.repeat(1100)+`\n最后一个方法：尾部独有方法，其不足需要查看原文。[cite:${SOURCE_IDS[0]}]`;
  const first=await mainFixture([reply(JSON.stringify(preparation)),reply(answer)],[[0]],{controls,answerPolicy:'workbench-v1'});let snapshot;
  const model={...first.harness.session.model!,contextWindow:32768,maxTokens:4096};
  try{const result=await first.harness.runTurn('介绍 p1 的几种方法',['p1'],'long-answer');assert.equal(result.status,'completed',result.error??'');snapshot=first.harness.snapshot();}finally{first.harness.dispose();}
  let inspected=false;
  const next=await mainFixture([messages=>{
    const request=messages.messages.findLast(message=>message.role==='user');assert.ok(request&&request.role==='user');
    const text=typeof request.content==='string'?request.content:request.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),payload=JSON.parse(text);
    assert.equal(payload.recent_dialogue[0].assistant_text,answer);assert.match(payload.recent_dialogue[0].assistant_text,/尾部独有方法/);assert.equal(payload.history_context.focus_complete,true);inspected=true;
    return reply(JSON.stringify({...preparation,rewrite:'p1 尾部独有方法的不足',queries:['p1 method limitations']}));
  },reply(`根据原文进一步说明该方法的限制。[cite:${SOURCE_IDS[0]}]`)],[[0]],{controls,answerPolicy:'workbench-v1',controlledSnapshot:snapshot,model});
  try{const result=await next.harness.runTurn('最后一个方法的不足是什么？',['p1'],'follow-up');assert.equal(result.status,'completed',result.error??'');assert.equal(inspected,true);assert.equal(result.requests.length,2);assert.deepEqual(result.citation_validity.unknown_ids,[]);}finally{next.harness.dispose();}
});

test('an oversized preparation-only catalog falls back to normal tool use without spending an auxiliary request',async()=>{
  const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
  const seed=await mainFixture([]),model={...seed.harness.session.model!,contextWindow:8192,maxTokens:1024},chunks=seed.chunks;seed.harness.dispose();
  const setup=await mainFixture([
    reply([call('retrieve_chunks',{query:'p1 methods',paper_ids:['p1']})],{stopReason:'toolUse'}),
    reply(`继续依据原文说明该方法。[cite:${SOURCE_IDS[0]}]`)
  ],[[0]],{controls,answerPolicy:'workbench-v1',model,p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,nlu:true,reflect:false,structuredMemory:true,
    publicPapers:[{paper_id:'p1',title:'超出辅助请求预算的目录标题'.repeat(1000),abstract:''}],evidenceIndex:new Map(chunks.map(chunk=>[chunk.chunk_id,{...chunk,index_version:PREPARED_INDEX,text_sha256:sha(chunk.text)}]))}});
  try{const result=await setup.harness.runTurn('解释 p1 的方法',['p1'],'prep-budget-fallback');
    assert.equal(result.status,'completed',result.error??'');assert.equal(result.question_preparation.status,'fallback');assert.equal(result.question_preparation.request_id,null);
    assert.equal(result.requests.length,2);assert.ok(result.requests.every(request=>request.phase==='agent'));assert.equal(result.tools.filter(tool=>tool.executed).length,1);assert.deepEqual(result.citation_validity.unknown_ids,[]);
  }finally{setup.harness.dispose();}
});
