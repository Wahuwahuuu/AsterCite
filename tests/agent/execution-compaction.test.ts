import assert from 'node:assert/strict';
import test from 'node:test';
import {buildExecutionTimeline,buildExecutionBatches,buildExecutionGraph,executionCompactionAt,executionNodeIndex,type ReplayTurn} from '../../web/activity.js';
import type {WebActivity,WebExecutionDetail} from '../../agent/web-session.ts';

function fixture(reason='threshold',kind:'model'|'compaction'='compaction'){
  const activities:WebActivity[]=[],details:Record<string,WebExecutionDetail>={};
  const add=(id:string,type:'model'|'compaction',stage:string,phase:string,start:number,end:number,extra:Partial<WebExecutionDetail>={})=>{
    const detail:WebExecutionDetail={id,kind:type,status:'completed',stage,phase,turn_id:'sample',cycle:1,started_at:new Date(1000+start).toISOString(),elapsed_ms:end-start,turn_elapsed_ms:end,input:{},output:{text:'Visible text',tool_calls:[]},...extra};
    details[id]=detail;activities.push({id,kind:type,status:detail.status,stage,phase,label:type==='compaction'?'上下文压缩':id,detail:'',elapsed_ms:end,has_details:true,started_at:detail.started_at,request_elapsed_ms:detail.elapsed_ms});
  };
  add('prepare','model','question_preparation','auxiliary',5,20);
  add('compact',kind,'compaction','compaction',25,50,{input:{reason,tokens_before:25000,threshold_tokens:22938},output:{text:JSON.stringify({reason,before_tokens:25000,after_tokens:14000,summary:'保留当前论文与比较维度。',note:'已整理早期上下文。'}),tool_calls:[]}});
  add('answer','model','generate','agent',55,80,{input:{format:'provider_payload',messages:[],tools:[{name:'retrieve_chunks',description:'read originals',parameters:{}}],settings:{}}});
  const turn:ReplayTurn={question:'Explain the paper',status:'completed',elapsed_ms:90,activity:activities};
  const timeline=buildExecutionTimeline(turn,details),batches=buildExecutionBatches(turn,details),graph=buildExecutionGraph(timeline,batches);
  const at=(key:string)=>timeline.events.findIndex(event=>event.key===key);
  return {turn,details,timeline,graph,at};
}

test('compression is separate maintenance and never question preparation or a fabricated decision',()=>{
  for(const kind of ['compaction','model'] as const){
    const f=fixture('threshold',kind),before=structuredClone(f.timeline);
    for(const event of f.timeline.events.filter(event=>event.id==='compact'))assert.equal(event.node,'compaction');
    for(const event of f.graph.events.filter(event=>event.id==='compact')){assert.equal(event.maintenance,true);assert.equal(event.edge,undefined);}
    assert.equal(executionNodeIndex(f.graph,'understand',f.at('prepare:end')),f.at('prepare:start'),'preparation navigation skips maintenance');
    assert.ok(f.graph.events.filter(event=>event.node==='decision'&&!event.maintenance).every(event=>event.id==='answer'));
    assert.deepEqual(f.timeline,before);
  }
});

test('in-progress compression reads start metadata but not the future summary, tokens or result',()=>{
  const f=fixture(),none=executionCompactionAt(f.timeline,f.at('prepare:end'));
  assert.equal(none.state,'none');assert.equal(none.key,null);
  const active=executionCompactionAt(f.timeline,f.at('compact:start'));
  assert.equal(active.state,'running');assert.equal(active.before_tokens,25000);assert.equal(active.threshold_tokens,22938);
  assert.equal(active.after_tokens,null);assert.equal(active.summary,null);assert.equal(active.note,null);
});

test('completed compression keeps its actual reason and recorded before/after values',()=>{
  for(const reason of ['threshold','overflow','manual']){
    const f=fixture(reason),result=executionCompactionAt(f.timeline,f.at('compact:end'));
    assert.equal(result.reason,reason);assert.equal(result.state,'completed');assert.equal(result.before_tokens,25000);assert.equal(result.after_tokens,14000);
    assert.equal(result.summary,'保留当前论文与比较维度。');
  }
});

test('no reduction, failed compression and missing result fields are kept distinct',()=>{
  const f=fixture();f.details.compact.output!.text=JSON.stringify({reason:'manual',before_tokens:25000,after_tokens:25000,summary:''});
  assert.equal(executionCompactionAt(f.timeline,f.at('compact:end')).state,'unchanged');
  f.turn.activity!.find(item=>item.id==='compact')!.status='error';f.details.compact.status='error';
  const failed=buildExecutionTimeline(f.turn,f.details);assert.equal(executionCompactionAt(failed,f.at('compact:end')).state,'error');
  f.details.compact.output!.text='null';delete f.details.compact.input;
  const missing=executionCompactionAt(buildExecutionTimeline(f.turn,f.details),f.at('compact:end'));
  assert.equal(missing.reason,null);assert.equal(missing.before_tokens,null);assert.equal(missing.after_tokens,null);assert.equal(missing.summary,null);
});

test('legacy compression labels are classified as maintenance without guessing a trigger',()=>{
  const f=fixture('threshold','model'),item=f.turn.activity!.find(item=>item.id==='compact')!;
  delete f.details.compact;delete item.stage;delete item.phase;delete item.started_at;delete item.request_elapsed_ms;item.label='压缩上下文';
  const timeline=buildExecutionTimeline(f.turn,f.details),event=timeline.events.find(event=>event.id==='compact')!;
  assert.equal(event.node,'compaction');assert.equal(executionCompactionAt(timeline,timeline.events.indexOf(event)).reason,null);
});
