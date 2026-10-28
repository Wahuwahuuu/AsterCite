import assert from 'node:assert/strict';
import test from 'node:test';
import {fauxAssistantMessage as reply,fauxToolCall as call,type Api,type Model} from '@earendil-works/pi-ai';
import {shouldCompact} from '@earendil-works/pi-coding-agent';
import {ContextTracker,compactionPolicy,estimateVisibleContext} from '../../agent/workbench-context.ts';
import {traceInput} from '../../agent/execution-trace.ts';
import {DomainMemory} from '../../agent/domain-memory.ts';
import {mainFixture,preparation,SOURCE_IDS} from './main-fixture.ts';
const controls={arm:'C',reflect:false,compaction:'native',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;

test('product compaction crosses 80 percent and reserves the same recent context for either trigger',()=>{
  const policy=compactionPolicy(32768);assert.equal(policy.threshold_tokens,26214);assert.equal(policy.keep_recent_tokens,8192);
  const settings={enabled:true,reserveTokens:policy.reserve_tokens,keepRecentTokens:policy.keep_recent_tokens};
  assert.equal(shouldCompact(26214,32768,settings),false);assert.equal(shouldCompact(26215,32768,settings),true);
  assert.equal(compactionPolicy(8192).keep_recent_tokens,2048);
});

test('current context uses one request including cache, not cumulative charges, and survives restoration',()=>{
  const tracker=new ContextTracker(),payload=traceInput({messages:[{role:'user',content:'Visible question'}]},'provider_payload');
  tracker.request(payload,'generate');assert.equal(tracker.view(32768,true).basis,'estimate');
  tracker.response({input:1000,output:100,cacheRead:300,cacheWrite:200,reasoning:null,totalTokens:1600},'generate');
  assert.equal(tracker.view(32768,true).used_tokens,1600);
  tracker.response({input:500,output:50,cacheRead:0,cacheWrite:0,reasoning:null,totalTokens:550},'generate');
  assert.equal(tracker.view(32768,true).used_tokens,550);assert.equal(tracker.view(32768,true).remaining_tokens,32218);
  assert.deepEqual(new ContextTracker(tracker.state).view(32768,true),tracker.view(32768,true));
  const base={messages:[{role:'assistant',content:[{type:'text',text:'Visible'}]}]};
  assert.equal(estimateVisibleContext({...base,headers:{Authorization:'private'},messages:[{role:'assistant',content:[...base.messages[0].content,{type:'thinking',thinking:'hidden'.repeat(10000)}]}]}),estimateVisibleContext(base));
});

test('compression records keep actual summaries and signed differences, including unchanged and error outcomes',()=>{
  const tracker=new ContextTracker();tracker.begin('manual',18000,18);tracker.end(7000,8,'actual saved summary','completed','done');
  const record=tracker.view(32768,true).compressions[0];assert.equal(record.before_tokens-record.after_tokens,11000);assert.equal(record.summary,'actual saved summary');
  tracker.begin('manual',7000,8);tracker.end(7000,8,'','unchanged','recent history retained');
  assert.equal(tracker.state.compressions.at(-1)?.status,'unchanged');assert.equal(tracker.view(32768,true).basis,'estimate');
  tracker.begin('threshold',7000,8);tracker.end(7000,8,'','error','original context retained');assert.equal(tracker.state.compressions.at(-1)?.status,'error');
});

test('reading memory preserves real answer excerpts, preferences and multiple objects without promoting them to verified facts',()=>{
  const memory=new DomainMemory('fixture');memory.state.user_constraints.push({key:'language',value:'中文',source_quote:'用中文回答',source_turn:'turn-0',superseded_by:null});
  memory.rememberAnswer('turn-1','比较两篇论文','实际回答',['p2','p1'],['source-2','source-1'],'partial');
  assert.deepEqual(memory.state.comparison_order,['p2','p1']);assert.equal(memory.state.current_paper,null);assert.equal(memory.activeConstraints()[0].value,'中文');
  assert.equal(memory.state.conclusions.length,0);assert.equal(memory.state.reading_notes?.[0].source_turn,'turn-1');
  for(let i=2;i<8;i++)memory.rememberAnswer('turn-'+i,'追问 '+i,'后续回答',['p1'],['source-1'],'answer');
  assert.equal(memory.state.reading_notes?.length,4);assert.equal(memory.projection().current_paper?.paper_id,'p1');
  const summary=JSON.parse(memory.summary([{turn_id:'turn-7',user_text:'追问 7',final_answer:'后续回答'}],true));
  assert.deepEqual(summary.domain_memory.reading_notes,memory.projection().reading_notes);assert.equal(summary.conversation_only[0].final_answer,undefined);
});

test('an autonomously chosen paper is written back after the answer and is present in restored follow-up context',async()=>{
  const f=await mainFixture([reply('invalid preparation'),reply([call('retrieve_chunks',{query:'first',paper_ids:['p1']})],{stopReason:'toolUse'}),reply(`这篇论文的说明 [cite:${SOURCE_IDS[0]}]。`)],[[0]],{answerPolicy:'workbench-v1',controls});
  let snapshot;
  try{const record=await f.harness.runTurn('从论文库选一篇解释它的主要内容',[],'reading-choice');assert.equal(record.status,'completed',record.error??'');assert.equal(f.harness.memory.state.current_paper?.paper_id,'p1');assert.equal(f.harness.memory.state.current_paper?.source_turn,'reading-choice');assert.equal(f.harness.memory.state.reading_notes?.[0].answer_excerpt,record.final_answer);snapshot=f.harness.snapshot();assert.ok(snapshot.state.context_state?.latest);}
  finally{f.harness.dispose();}
  const restored=await mainFixture([reply(JSON.stringify(preparation)),context=>{assert.ok(JSON.stringify(context).includes('reading_notes'));assert.ok(JSON.stringify(context).includes('这篇论文的说明'));return reply(`继续说明 [cite:${SOURCE_IDS[0]}]。`);}],[[0]],{answerPolicy:'workbench-v1',controls,controlledSnapshot:snapshot});
  try{const record=await restored.harness.runTurn('继续讲这篇论文',[],'follow-up');assert.equal(record.status,'completed',record.error??'');assert.equal(restored.harness.memory.state.reading_notes?.length,2);}finally{restored.harness.dispose();}
});

test('manual compression uses the configured retention, records real before/after, and adds no model request',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(`已有说明 [cite:${SOURCE_IDS[0]}]。`),reply(JSON.stringify(preparation)),reply(`继续说明 [cite:${SOURCE_IDS[0]}]。`)],[[0]],{answerPolicy:'workbench-v1',controls});
  try{
    await f.harness.runTurn('先解释论文',['p1'],'first');
    for(let i=0;i<8;i++)await f.harness.session.sendCustomMessage({customType:'visible-history-fixture',content:'Earlier source description. '.repeat(1100)+i,display:false},{triggerTurn:false});
    const retention=f.harness.settings.getCompactionSettings().keepRecentTokens;assert.equal(retention,8192);f.harness.requestCompaction();
    const record=await f.harness.runTurn('继续解释论文',['p1'],'second');assert.equal(record.status,'completed',record.error??'');assert.equal(record.requests.length,2);assert.equal(record.compaction_control?.keep_recent_tokens,retention);assert.equal(f.harness.settings.getCompactionSettings().keepRecentTokens,retention);
    const compression=f.harness.contextView().compressions.find(item=>item.reason==='manual');assert.equal(compression?.status,'completed');assert.ok(compression!.before_tokens>compression!.after_tokens);assert.ok(compression!.summary.includes('已有说明'));assert.ok(f.harness.snapshot().state.context_state?.compressions.length);
  }finally{f.harness.dispose();}
});

test('native automatic compression uses the product 80 percent policy and persists its result',async()=>{
  const seed=await mainFixture([]);const model={...seed.harness.session.model!,contextWindow:32768,maxTokens:4096} as Model<Api>;seed.harness.dispose();
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(`原文说明 [cite:${SOURCE_IDS[0]}]。`)],[[0]],{answerPolicy:'workbench-v1',controls,model});
  try{
    assert.equal(f.harness.settings.getCompactionSettings().reserveTokens,6554);
    for(let i=0;i<10;i++)await f.harness.session.sendCustomMessage({customType:'visible-history-fixture',content:'History description. '.repeat(520)+i,display:false},{triggerTurn:false});
    const record=await f.harness.runTurn('解释论文',['p1'],'automatic');assert.equal(record.status,'completed',record.error??'');assert.equal(record.requests.length,2);
    const compression=f.harness.contextView().compressions.find(item=>item.reason==='threshold');assert.equal(compression?.status,'completed',JSON.stringify({events:record.compaction_events,window:f.harness.session.model?.contextWindow,records:f.harness.contextView().compressions.map(c=>({reason:c.reason,status:c.status}))}));assert.ok(compression!.before_tokens>compression!.after_tokens);assert.equal(f.harness.contextView().policy.threshold_percent,80);
  }finally{f.harness.dispose();}
});
