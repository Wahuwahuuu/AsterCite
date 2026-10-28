import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {TurnExecutionTracker,executionFromOutput,type TurnExecution} from '../../agent/turn-execution.ts';
import {mainFixture,preparation,SOURCE_IDS} from './main-fixture.ts';

const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
const answer=`这是已完成的解释。[cite:${SOURCE_IDS[0]}]`;
const envelope=(text:string,state:TurnExecution['state'],needs:string[]=[],sources=true)=>reply(JSON.stringify({answer:text,execution:{state,remaining_needs:needs,needs_sources:sources}}));
const setup=(steps:Parameters<typeof mainFixture>[0],extra:Parameters<typeof mainFixture>[2]={})=>mainFixture(steps,[[0]],{controls,answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1',...extra});

test('explicit completion is independent of wording and cannot contradict unresolved goals',()=>{
  for(const body of ['对象已选定，转入下一步。','Proceed with the next phase.','继续处理剩余事项。'])assert.equal(executionFromOutput(JSON.stringify({answer:body,execution:{state:'working',remaining_needs:['解释方法']}}))?.state,'working');
  assert.equal(executionFromOutput(JSON.stringify({answer:'原文例句是“让我再检索一下”。',execution:{state:'complete',remaining_needs:[]}}))?.state,'complete');
  assert.equal(executionFromOutput(JSON.stringify({answer:'正文',execution:{state:'complete',remaining_needs:['还没回答的问题']}}))?.state,'partial');
});

test('no execution progress terminates working steps while real tool progress resets the allowance',()=>{
  const tracker=new TurnExecutionTracker(),working={state:'working',remaining_needs:['解释结果']} as const;
  const facts={progress_key:'source-a',source_count:1,retrieval_attempts:1,successful_retrievals:1,running_tools:0,can_continue:true};
  assert.equal(tracker.decide({...working,remaining_needs:[...working.remaining_needs]},facts).state,'working');
  assert.equal(tracker.decide({...working,remaining_needs:[...working.remaining_needs]},{...facts,progress_key:'source-b'}).state,'working');
  const stopped=tracker.decide({...working,remaining_needs:[...working.remaining_needs]},{...facts,progress_key:'source-b'});assert.equal(stopped.state,'partial');assert.equal(stopped.stop_reason,'no_execution_progress');
});

test('plain intermediate prose is assessed by task meaning and continues into an actual tool call',async()=>{
  const f=await setup([reply(JSON.stringify(preparation)),reply('对象已经准备好，下一步处理对应章节。'),
    reply(JSON.stringify({state:'working',remaining_needs:['读取具体方法并解释'],needs_sources:true})),
    reply([call('retrieve_chunks',{query:'actual method',paper_ids:['p1']})],{stopReason:'toolUse'}),envelope(answer,'complete')]);
  try{const r=await f.harness.runTurn('解释论文的方法',['p1'],'execution-prose');assert.equal(r.status,'completed',r.error??'');assert.equal(r.final_answer,answer);assert.equal(r.requests.filter(item=>item.stage==='turn_completion').length,1);assert.equal(r.tools.filter(tool=>tool.executed).length,2);assert.equal(r.execution?.state,'complete');}
  finally{f.harness.dispose();}
});

test('an ordinary completed explanation containing action words remains a normal answer',async()=>{
  const text=answer+'。这段讨论了“重新调取”和搜索工具的区别。';
  const f=await setup([reply(JSON.stringify(preparation)),reply(text),reply(JSON.stringify({state:'complete',remaining_needs:[],needs_sources:true}))]);
  try{const r=await f.harness.runTurn('解释论文的方法',['p1'],'execution-complete');assert.equal(r.status,'completed',r.error??'');assert.equal(r.final_answer,text);assert.equal(r.requests.length,3);assert.equal(r.execution?.state,'complete');}
  finally{f.harness.dispose();}
});

test('working steps may continue repeatedly when actual evidence work occurs between them',async()=>{
  const f=await setup([reply(JSON.stringify(preparation)),envelope('第一项已完成，还需要下一项。','working',['读取方法']),
    reply([call('retrieve_chunks',{query:'method details',paper_ids:['p1']})],{stopReason:'toolUse'}),envelope('第二项已完成，还有一项。','working',['读取结果']),
    reply([call('retrieve_chunks',{query:'result details',paper_ids:['p1']})],{stopReason:'toolUse'}),envelope(answer,'complete')]);
  try{const r=await f.harness.runTurn('解释论文的方法和结果',['p1'],'execution-multiple');assert.equal(r.status,'completed',r.error??'');assert.equal(r.final_answer,answer);assert.equal(r.requests.length,6);assert.equal(r.tools.filter(tool=>tool.executed).length,3);assert.equal(r.requests.filter(item=>item.stage==='turn_completion').length,0);}
  finally{f.harness.dispose();}
});

test('repeated working declarations without actions retain partial content and cannot loop indefinitely',async()=>{
  const f=await setup([reply(JSON.stringify(preparation)),envelope(answer,'working',['尚需解释结果']),envelope(answer,'working',['尚需解释结果'])]);
  try{const r=await f.harness.runTurn('解释论文的方法和结果',['p1'],'execution-stalled');assert.equal(r.status,'completed',r.error??'');assert.equal(r.business_status,'partial');assert.equal(r.requests.length,3);assert.equal(r.execution?.stop_reason,'no_execution_progress');assert.ok(r.final_answer.startsWith(answer));assert.equal(f.harness.memory.state.reading_notes?.at(-1)?.execution_state,'partial');}
  finally{f.harness.dispose();}
});

test('optional completion-check failure preserves the readable answer and its actual request evidence',async()=>{
  const f=await setup([reply(JSON.stringify(preparation)),reply(answer),reply('',{stopReason:'error',errorMessage:'Optional check unavailable'})]);
  try{const r=await f.harness.runTurn('解释论文的方法',['p1'],'execution-check-failed');assert.equal(r.status,'completed',r.error??'');assert.equal(r.final_answer,answer);assert.equal(r.requests.length,3);assert.equal(r.requests[2].status,'error');assert.equal(r.failure_code,null);assert.equal(r.execution?.origin,'host');assert.equal(r.final_request_id,r.requests[1].request_id);}
  finally{f.harness.dispose();}
});

test('the reserved final request is not spent on a completion check or an unbounded continuation',async()=>{
  const f=await setup([reply(JSON.stringify(preparation)),envelope(answer,'working',['补充结果'])],{maxRequests:2});
  try{const r=await f.harness.runTurn('解释论文的方法和结果',['p1'],'execution-last');assert.equal(r.status,'completed',r.error??'');assert.equal(r.requests.length,2);assert.equal(r.execution?.state,'partial');assert.ok(r.final_answer.startsWith(answer));assert.equal(r.requests.filter(item=>item.stage==='turn_completion').length,0);}
  finally{f.harness.dispose();}
});

test('a failed tool attempt is not silently promoted to task completion',async()=>{
  const f=await setup([reply('invalid preparation'),reply([call('retrieve_chunks',{query:'unavailable object',paper_ids:['unknown']})],{stopReason:'toolUse'}),
    envelope('对象已确认。','complete',[],true),reply([call('search_papers',{query:'available objects',limit:1})],{stopReason:'toolUse'}),
    reply([call('retrieve_chunks',{query:'method',paper_ids:['p1']})],{stopReason:'toolUse'}),envelope(answer,'complete')]);
  try{const r=await f.harness.runTurn('从库中选择论文并解释方法',[],'execution-tool-recovery');assert.equal(r.status,'completed',r.error??'');assert.equal(r.final_answer,answer);assert.ok(r.tools.some(tool=>tool.status==='rejected'));assert.ok(r.tools.some(tool=>tool.tool_name==='retrieve_chunks'&&tool.status==='completed'));assert.equal(r.execution?.state,'complete');}
  finally{f.harness.dispose();}
});

test('a real clarification ends normally without forcing retrieval for a missing object',async()=>{
  const f=await setup([reply('invalid preparation'),envelope('请指出要讨论的论文。','clarification',['用户指定论文'],true)]);
  try{const r=await f.harness.runTurn('解释那一篇的设置',[],'execution-clarification');assert.equal(r.status,'completed',r.error??'');assert.equal(r.execution?.state,'clarification');assert.equal(r.business_status,'clarification');assert.equal(r.tools.length,0);assert.equal(r.requests.length,2);}
  finally{f.harness.dispose();}
});

test('a legitimate structured refusal does not require a fabricated source or another tool call',async()=>{
  const f=await setup([reply('invalid preparation'),reply(JSON.stringify({status:'refusal',answer:'当前资料不足以支持这个结论。',execution:{state:'complete',remaining_needs:[],needs_sources:true}}))]);
  try{const r=await f.harness.runTurn('只依据已有资料回答这个问题',[],'execution-refusal');assert.equal(r.status,'completed',r.error??'');assert.equal(r.business_status,'refusal');assert.equal(r.tools.length,0);assert.equal(r.requests.length,2);assert.equal(r.execution?.state,'complete');}
  finally{f.harness.dispose();}
});
