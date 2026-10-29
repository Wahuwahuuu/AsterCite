import assert from 'node:assert/strict';
import test from 'node:test';
import {buildExecutionTimeline,buildExecutionBatches,executionBatchAt,buildExecutionGraph,type ReplayTurn} from '../../web/activity.js';
import type {WebActivity,WebExecutionDetail} from '../../agent/web-session.ts';

function fixture({parallel=false,planned=false,unknown=false,failed=false}={}){
  const activities:WebActivity[]=[],details:Record<string,WebExecutionDetail>={};
  const queries=[{query:'method A',paper_ids:['a']},{query:'method B',paper_ids:['b']}];
  const add=(id:string,kind:'model'|'tool',start:number,end:number,extra:Partial<WebExecutionDetail>={})=>{
    const row:WebExecutionDetail={id,kind,status:'completed',stage:'generate',phase:'agent',turn_id:'sample',cycle:1,elapsed_ms:end-start,turn_elapsed_ms:end,started_at:new Date(1000+start).toISOString(),input:{query:id},output:{text:'visible result',tool_calls:[]},...extra};
    details[id]=row;activities.push({id,kind,status:row.status,label:kind,detail:id,elapsed_ms:end,has_details:true,parent_id:row.parent_id,origin:row.origin,stage:row.stage,phase:row.phase,started_at:row.started_at,request_elapsed_ms:row.elapsed_ms});return row;
  };
  add('request','model',5,20,{stage:planned?'question_preparation':'generate',phase:planned?'auxiliary':'agent',input:{format:'provider_payload',messages:[],tools:[{name:'retrieve_chunks',description:'read originals',parameters:{}}],settings:{}},output:{text:planned?JSON.stringify({queries}):'',tool_calls:planned?[]:queries.map((args,i)=>({id:'tool-'+i,name:'retrieve_chunks',arguments:args}))}});
  add('tool-0','tool',25,parallel?70:40,{stage:planned?'retrieve_first':'generate',tool:'retrieve_chunks',input:queries[0],...(!unknown?{parent_id:'request',origin:planned?'host_plan':'model'}:{})});
  add('tool-1','tool',parallel?30:45,60,{stage:planned?'retrieve_first':'generate',tool:'retrieve_chunks',input:queries[1],status:failed?'error':'completed',...(!unknown?{parent_id:'request',origin:planned?'host_plan':'model'}:{})});
  if(unknown)details.request.output={text:'An older request without tool associations.',tool_calls:[]};
  add('next','model',80,90,{input:{format:'provider_payload',messages:[],tools:[{name:'retrieve_chunks',description:'read originals',parameters:{}}],settings:{}},output:{text:'Answer',tool_calls:[]}});
  const turn:ReplayTurn={question:'Compare methods',status:'completed',elapsed_ms:100,activity:activities,answer:'Answer'};
  const timeline=buildExecutionTimeline(turn,details),batches=buildExecutionBatches(turn,details),graph=buildExecutionGraph(timeline,batches);
  const at=(key:string)=>timeline.events.findIndex(event=>event.key===key);
  return {turn,details,timeline,batches,graph,at};
}

test('one model decision can run consecutive tools inside a batch without an extra outer decision',()=>{
  const f=fixture(),snapshot=structuredClone(f.timeline);
  assert.equal(f.batches.length,1);assert.equal(f.batches[0].origin,'model');
  const first=executionBatchAt(f.timeline,f.batches,f.at('tool-0:end'))!;
  assert.equal(first.returned,1);assert.equal(first.total,2);assert.equal(first.complete,false);
  assert.deepEqual(first.calls.map(call=>call.status),['completed','queued']);
  assert.equal(f.graph.events[f.at('tool-0:end')].node,'action');
  assert.equal(f.graph.events[f.at('tool-1:start')].node,'action');
  assert.equal(f.graph.events[f.at('tool-1:start')].edge,undefined);
  assert.equal(f.graph.events[f.at('tool-1:end')].node,'observation');
  assert.equal(f.graph.events[f.at('tool-1:end')].edge,'action-observation');
  assert.equal(f.graph.events[f.at('next:start')].edge,'observation-decision');
  assert.deepEqual(f.timeline,snapshot,'grouping must not rewrite original events');
});

test('plans and future outputs are not revealed before the parent response or tool return',()=>{
  const f=fixture();assert.equal(executionBatchAt(f.timeline,f.batches,f.at('request:start')),null);
  const declared=executionBatchAt(f.timeline,f.batches,f.at('request:end'))!;
  assert.equal(declared.started,0);assert.deepEqual(declared.calls.map(call=>call.status),['queued','queued']);
  const first=executionBatchAt(f.timeline,f.batches,f.at('tool-0:start'))!;
  assert.equal(first.returned,0);assert.equal(first.calls[0].end,undefined);assert.equal(first.calls[1].start,undefined);
  assert.equal(first.calls[0].start?.detail?.output,undefined,'the running request cannot expose its future output');
  const beforeNext=executionBatchAt(f.timeline,f.batches,f.at('tool-0:end'))!;
  assert.equal(beforeNext.calls[1].end,undefined);assert.equal(beforeNext.calls[1].start,undefined);
});

test('parallel calls remain inside the batch until every declared call has returned',()=>{
  const f=fixture({parallel:true}),started=executionBatchAt(f.timeline,f.batches,f.at('tool-1:start'))!;
  assert.equal(started.running,2);assert.equal(started.parallel,true);
  const firstReturn=executionBatchAt(f.timeline,f.batches,f.at('tool-1:end'))!;
  assert.equal(firstReturn.complete,false);assert.equal(firstReturn.calls[0].status,'running');assert.equal(firstReturn.calls[1].status,'completed');
  assert.equal(f.graph.events[f.at('tool-1:end')].node,'action');
  assert.equal(f.graph.events[f.at('tool-0:end')].node,'observation');
});

test('the explicit preparation plan explains host tool batches without inventing model decisions',()=>{
  const f=fixture({planned:true});assert.equal(f.batches[0].origin,'host_plan');assert.equal(f.batches[0].declared.length,2);
  const partial=executionBatchAt(f.timeline,f.batches,f.at('tool-0:end'))!;
  assert.equal(partial.total,2);assert.equal(partial.complete,false);assert.equal(partial.calls[1].id,undefined,'future host-generated call ids are not visible yet');
  assert.equal(f.graph.events[f.at('tool-0:end')].node,'action');
  assert.equal(f.graph.events.filter(event=>event.node==='decision'&&event.id==='request').length,0);
});

test('unlinked historical tools remain separate rather than being grouped by adjacency',()=>{
  const f=fixture({unknown:true});assert.equal(f.batches.length,2);
  for(const batch of f.batches){assert.equal(batch.origin,'unknown');assert.equal(batch.declared.length,0);}
  const seen=executionBatchAt(f.timeline,f.batches,f.at('tool-0:end'))!;assert.equal(seen.total,null);assert.equal(seen.complete,false);
  assert.equal(f.graph.events[f.at('tool-0:end')].node,'observation');
});

test('a failed return is retained as an error inside the batch and does not create a model request',()=>{
  const f=fixture({failed:true}),result=executionBatchAt(f.timeline,f.batches,f.at('tool-1:end'))!;
  assert.equal(result.failed,1);assert.equal(result.returned,2);assert.equal(result.complete,true);assert.equal(result.calls[1].status,'error');
  assert.equal(f.graph.events[f.at('tool-1:end')].status,'error');
  assert.equal(f.graph.events.filter(event=>event.kind==='model'&&event.moment==='start').length,2);
});

test('missing parent output keeps a linked batch total unknown rather than assuming future calls',()=>{
  const f=fixture(),details={...f.details};delete details.request;
  const batches=buildExecutionBatches(f.turn,details),timeline=buildExecutionTimeline(f.turn,details),graph=buildExecutionGraph(timeline,batches);
  const partial=executionBatchAt(timeline,batches,f.at('tool-0:end'))!;
  assert.equal(partial.total,null);assert.equal(partial.calls.length,1);assert.equal(partial.complete,false);
  assert.equal(graph.events[f.at('tool-0:end')].node,'action');
  assert.equal(graph.events[f.at('next:start')].edge,'observation-decision');
});

test('declared but unexecuted calls are not counted as successful results at turn end',()=>{
  const f=fixture();f.turn.activity=f.turn.activity!.filter(item=>item.id!=='tool-1'&&item.id!=='next');f.turn.status='error';
  const timeline=buildExecutionTimeline(f.turn,f.details),batches=buildExecutionBatches(f.turn,f.details);
  const final=executionBatchAt(timeline,batches,timeline.events.length-1)!;
  assert.equal(final.calls[1].status,'unexecuted');assert.equal(final.complete,false);assert.equal(final.returned,1);
});

test('explicit tool call identities can recover an omitted parent field without using timestamps',()=>{
  const f=fixture();for(const id of ['tool-0','tool-1']){delete f.details[id].parent_id;delete f.details[id].origin;const item=f.turn.activity!.find(item=>item.id===id)!;delete item.parent_id;delete item.origin;}
  const batches=buildExecutionBatches(f.turn,f.details);assert.equal(batches.length,1);assert.equal(batches[0].origin,'model');assert.equal(batches[0].parent_id,'request');
});

test('host batches with different recorded stages are not merged under the same preparation request',()=>{
  const f=fixture({planned:true});f.details['tool-1'].stage='retrieve_selected';f.turn.activity!.find(item=>item.id==='tool-1')!.stage='retrieve_selected';
  const batches=buildExecutionBatches(f.turn,f.details);assert.equal(batches.length,2);assert.notEqual(batches[0].id,batches[1].id);
  assert.equal(batches.find(batch=>batch.stage==='retrieve_selected')!.declared.length,0);
});

test('host records with no stage remain standalone even if their parent request matches',()=>{
  const f=fixture({planned:true});for(const id of ['tool-0','tool-1']){f.details[id].stage='';f.turn.activity!.find(item=>item.id===id)!.stage='';}
  const batches=buildExecutionBatches(f.turn,f.details);assert.equal(batches.length,2);assert.ok(batches.every(batch=>!batch.linked));
});
