import assert from 'node:assert/strict';
import test from 'node:test';
import {buildExecutionTimeline,executionDetailAt,executionIndexAt,executionNodeIndex,type ReplayTurn} from '../../web/activity.js';
import {formatTraceValue} from '../../web/trace-view.js';
import type {WebActivity,WebExecutionDetail} from '../../agent/web-session.ts';

const item=(id:string,kind:'model'|'tool',end:number,extra:Partial<WebActivity>={}):WebActivity=>({id,kind,status:'completed',label:kind,detail:'visible event',elapsed_ms:end,has_details:true,...extra});
const detail=(id:string,kind:'model'|'tool',end:number,duration:number,extra:Partial<WebExecutionDetail>={}):WebExecutionDetail=>({id,kind,status:'completed',phase:'answer',stage:'agent',turn_id:'one',cycle:1,turn_elapsed_ms:end,elapsed_ms:duration,started_at:new Date(1000+end-duration).toISOString(),input:{query:'source question'},output:{text:'visible result',tool_calls:[]},...extra});
const turn=(activity:WebActivity[],extra:Partial<ReplayTurn>={}):ReplayTurn=>({question:'Compare the selected papers.',status:'completed',elapsed_ms:110,activity,...extra});

test('nested JSON strings and objects are readable while raw text is preserved exactly',()=>{
  const raw=' {"chunks":[{"text":"中文原文","positions":[1,2]}],"ok":true} ';
  assert.equal(formatTraceValue(raw),JSON.stringify(JSON.parse(raw),null,2));
  assert.match(formatTraceValue(raw),/\n  "chunks": \[\n    \{/u);
  assert.equal(formatTraceValue(raw,true),raw);
  assert.equal(formatTraceValue({a:[1,2]}),'{\n  "a": [\n    1,\n    2\n  ]\n}');
  for(const plain of ['ordinary output\nsecond line','{incomplete','<img src=x onerror=alert(1)>','null','42','"text"'])assert.equal(formatTraceValue(plain),plain);
});

test('real request durations reconstruct starts and host-planned tool returns without invented model calls',()=>{
  const activity=[item('prepare','model',20),item('tool-a','tool',45,{origin:'host_plan'}),item('tool-b','tool',60,{origin:'host_plan'}),item('answer','model',100)];
  const details={prepare:detail('prepare','model',20,15,{stage:'question_preparation'}),'tool-a':detail('tool-a','tool',45,20,{origin:'host_plan'}),'tool-b':detail('tool-b','tool',60,15,{origin:'host_plan'}),answer:detail('answer','model',100,35,{stage:'generate'})};
  const timeline=buildExecutionTimeline(turn(activity),details);
  assert.deepEqual(timeline.events.map(event=>[event.key,event.at]),[['question',0],['prepare:start',5],['prepare:end',20],['tool-a:start',25],['tool-a:end',45],['tool-b:start',45],['tool-b:end',60],['answer:start',65],['answer:end',100],['finish',110]]);
  assert.equal(timeline.events.filter(event=>event.kind==='model').length,4);
  assert.equal(timeline.events.find(event=>event.key==='tool-b:start')?.edge,'observation-action');
  assert.equal(timeline.events.find(event=>event.key==='tool-a:start')?.edge,'understand-action');
  assert.equal(timeline.events.find(event=>event.key==='answer:start')?.node,'generate');
  assert.equal(timeline.duration,110);
  assert.ok(!timeline.events.some(event=>event.edge==='generate-generate'),'a normal output is not a citation repair loop');
});

test('a stale running detail retains the known start but uses the completed activity time',()=>{
  const pending=detail('a','tool',30,10,{status:'running'}),timeline=buildExecutionTimeline(turn([item('a','tool',55)]),{a:pending});
  assert.deepEqual(timeline.events.filter(event=>event.id==='a').map(event=>[event.moment,event.at]),[['start',20],['end',55]]);
});

test('autonomous tool observations return to model decisions and only an actual repair creates a self loop',()=>{
  const activity=[item('choose','model',20),item('tool','tool',40,{origin:'model'}),item('choose-again','model',60),item('answer','model',80),item('repair','model',100)];
  const details={choose:detail('choose','model',20,15,{phase:'agent'}),tool:detail('tool','tool',40,10),'choose-again':detail('choose-again','model',60,15,{phase:'agent'}),answer:detail('answer','model',80,10,{stage:'generate'}),repair:detail('repair','model',100,15,{stage:'citation_repair'})};
  const events=buildExecutionTimeline(turn(activity),details).events;
  assert.equal(events.find(event=>event.key==='choose-again:start')?.edge,'observation-decision');
  assert.equal(events.filter(event=>event.edge==='generate-generate').length,1);
  assert.equal(events.find(event=>event.edge==='generate-generate')?.key,'repair:start');
});

test('legacy cumulative times produce completion events only, never a fabricated request start',()=>{
  const legacy={...detail('old','model',40,40),started_at:undefined,turn_elapsed_ms:undefined} as unknown as WebExecutionDetail;
  const timeline=buildExecutionTimeline(turn([item('old','model',40)]),{old:legacy});
  assert.deepEqual(timeline.events.map(event=>event.key),['question','old:end','finish']);
  assert.equal(timeline.events[1].legacy,true);assert.equal(timeline.events[1].at,40);
});

test('seeking to a pending request reveals only its known input, not its future output or duration',()=>{
  const original=detail('request','model',70,50),snapshot=structuredClone(original),timeline=buildExecutionTimeline(turn([item('request','model',70)]),{request:original});
  const start=timeline.events[executionIndexAt(timeline,30)],visible=executionDetailAt(original,start);
  assert.equal(start.moment,'start');assert.equal(visible?.status,'running');assert.equal(visible?.output,undefined);assert.equal(visible?.elapsed_ms,0);assert.equal(visible?.playback_pending,true);
  assert.deepEqual(visible?.input,original.input);assert.deepEqual(original,snapshot);
  const end=timeline.events[executionIndexAt(timeline,70)];assert.equal(end.moment,'end');assert.deepEqual(executionDetailAt(original,end)?.output,original.output);
});

test('same-time events remain individually addressable and seeking clamps to the recorded sequence',()=>{
  const timeline=buildExecutionTimeline(turn([item('a','tool',40),item('b','tool',50)]),{a:detail('a','tool',40,20),b:detail('b','tool',50,10)});
  const at40=timeline.events.filter(event=>event.at===40);assert.deepEqual(at40.map(event=>event.key),['a:end','b:start']);
  assert.equal(timeline.events[executionIndexAt(timeline,40)].key,'b:start');
  assert.equal(executionIndexAt(timeline,-1),0);assert.equal(timeline.events[executionIndexAt(timeline,1000)].key,'finish');
});

test('graph navigation reaches tool observations and wraps through every saved return',()=>{
  const timeline=buildExecutionTimeline(turn([item('a','tool',40),item('b','tool',60)]),{a:detail('a','tool',40,15),b:detail('b','tool',60,15)});
  const first=executionNodeIndex(timeline,'observation');
  assert.equal(timeline.events[first].key,'a:end');
  const second=executionNodeIndex(timeline,'observation',first);
  assert.equal(timeline.events[second].key,'b:end');
  assert.equal(executionNodeIndex(timeline,'observation',second),first);
  assert.equal(executionNodeIndex(timeline,'observation',timeline.events.length-1),first);
  assert.equal(executionNodeIndex(timeline,'not-recorded'),-1);
});

test('graph navigation includes answer-only completions and legacy events without changing history',()=>{
  const request=detail('answer','model',80,30,{stage:'generate',phase:'agent',input:{messages:[],tools:[{name:'retrieve_chunks'}]},output:{text:'Visible answer',tool_calls:[]}});
  const timeline=buildExecutionTimeline(turn([item('answer','model',80)]),{answer:request}),before=structuredClone(timeline);
  assert.equal(timeline.events[executionNodeIndex(timeline,'decision')].key,'answer:start');
  assert.equal(timeline.events[executionNodeIndex(timeline,'generate')].key,'answer:end');
  const legacy=buildExecutionTimeline(turn([item('old','tool',40)]));
  assert.equal(legacy.events[executionNodeIndex(legacy,'observation')].key,'old:end');
  assert.deepEqual(timeline,before);
});

test('live requests have no future completion and absent records do not become a simulated loop',()=>{
  const live=buildExecutionTimeline(turn([item('pending','tool',25,{status:'running'})],{status:'running',elapsed_ms:40}));
  assert.deepEqual(live.events.map(event=>event.key),['question','pending:start']);assert.equal(live.duration,40);
  const empty=buildExecutionTimeline(turn([]));assert.equal(empty.hasRecords,false);assert.equal(empty.events.length,1);
  const other=buildExecutionTimeline(turn([item('another','model',50)]),{pending:detail('pending','tool',25,10)});
  assert.ok(!other.events.some(event=>event.id==='pending'));
});

test('memory synthesis is a memory operation even though it uses a model request',()=>{
  const activities=[item('answer','model',60,{stage:'generate',phase:'agent'}),item('check','model',80,{stage:'turn_completion',phase:'auxiliary'}),item('remember','model',100,{stage:'long_term_memory',phase:'auxiliary'})];
  const details={answer:detail('answer','model',60,20,{stage:'generate',phase:'agent'}),check:detail('check','model',80,20,{stage:'turn_completion',phase:'auxiliary'}),remember:detail('remember','model',100,20,{stage:'long_term_memory',phase:'auxiliary'})};
  const events=buildExecutionTimeline(turn(activities),details).events;
  assert.equal(events.find(event=>event.key==='check:start')?.node,'generate');
  for(const event of events.filter(event=>event.id==='remember')){assert.equal(event.node,'memory');assert.ok(event.title.includes('提炼长期记忆'));}
  assert.equal(events.at(-1)?.node,'memory');
  const pending=buildExecutionTimeline(turn(activities)).events;assert.equal(pending.find(event=>event.id==='remember')?.node,'memory');
});

test('missing details do not imply that a stored request lacks start times',()=>{
  const unavailable=buildExecutionTimeline(turn([item('call_provider','tool',60)])).events;
  assert.equal(unavailable.find(event=>event.id==='call_provider')?.legacy,false);
  const retained=buildExecutionTimeline(turn([item('call_provider','tool',60,{stage:'generate',phase:'agent',started_at:'2026-10-29T00:00:00Z',request_elapsed_ms:20})])).events;
  assert.deepEqual(retained.filter(event=>event.id==='call_provider').map(event=>[event.moment,event.at]),[['start',40],['end',60]]);
  assert.equal(retained.some(event=>event.legacy),false);
});

test('a model can decide to call tools during answer composition without exposing future tool calls at replay start',()=>{
  const input={format:'provider_payload',messages:[],settings:{},tools:[{name:'retrieve_chunks',description:'read source',parameters:{type:'object'}}]} as const;
  const request=detail('choose','model',50,20,{stage:'generate',phase:'agent',input:{...input,tools:[...input.tools],messages:[]},output:{text:'',tool_calls:[{id:'call_real',name:'retrieve_chunks',arguments:{query:'original'}}]}});
  const timeline=buildExecutionTimeline(turn([item('choose','model',50)]),{choose:request});
  for(const event of timeline.events.filter(event=>event.id==='choose'))assert.equal(event.node,'decision');
  const start=timeline.events.find(event=>event.key==='choose:start')!;assert.equal(executionDetailAt(request,start)?.output,undefined);
  const answer={...request,output:{text:'This is the answer.',tool_calls:[]}};
  const answered=buildExecutionTimeline(turn([item('choose','model',50)]),{choose:answer}).events;
  assert.equal(answered.find(event=>event.key==='choose:start')?.node,'decision');assert.equal(answered.find(event=>event.key==='choose:end')?.node,'generate');
});
