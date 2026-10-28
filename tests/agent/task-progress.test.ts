import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskProgressTracker} from '../../agent/task-progress.ts';
import {parseTurnExecution} from '../../agent/turn-execution.ts';
import type {Chunk} from '../../agent/contracts.ts';
import {taskSummary} from '../../web/task-progress.js';

const visible=new Map([['s1',{chunk_id:'s1',paper_id:'p1'} as Chunk],['s2',{chunk_id:'s2',paper_id:'p2'} as Chunk]]);
test('retrieved sources do not finish unrelated user goals; updates require actual visible citations',()=>{
  const tracker=new TaskProgressTracker('解释方法并报告结果');tracker.plan('问题',[{need_id:'n1',text:'whole'},{need_id:'n2',text:'解释方法'},{need_id:'n3',text:'报告结果'}],['p1']);
  tracker.event({id:'t',kind:'tool',tool:'retrieve_chunks',status:'running',stage:'retrieve',phase:'agent',input:{paper_ids:['p1']}});
  tracker.event({id:'t',kind:'tool',tool:'retrieve_chunks',status:'completed',stage:'retrieve',phase:'agent',output:{text:JSON.stringify({chunks:[visible.get('s1')]}),tool_calls:[]}});
  assert.equal(tracker.snapshot().items.find(item=>item.id==='source:p1')?.state,'retrieved');
  assert.ok(tracker.goals().every(goal=>tracker.snapshot().items.find(item=>item.id===goal.need_id)?.state==='pending'));
  tracker.update([{need_id:'n2',status:'supported',source_ids:['invented']}],visible);assert.equal(tracker.snapshot().items.find(item=>item.id==='n2')?.state,'pending');
  tracker.update([{need_id:'n2',status:'supported',source_ids:['s1'],note:'方法已说明'}],visible);
  const final=tracker.finish({state:'complete',remaining_needs:[],needs_sources:true},'方法回答',['s1']);
  assert.equal(final.items.find(item=>item.id==='n2')?.state,'answered');assert.equal(final.items.find(item=>item.id==='n3')?.state,'unconfirmed');assert.equal(taskSummary(final).done,1);
});
test('cancelled and multi-paper tasks preserve each individual source gap and completed items',()=>{
  const tracker=new TaskProgressTracker('比较两篇论文');tracker.plan('比较',[{need_id:'n2',text:'对比结果'}],['p1','p2']);
  tracker.comparison({papers:['p1','p2'],dimensions:['方法'],budget:{requests:12,retrievals:6,searches:2,checks:3},checks:1,cells:[{paper_id:'p1',dimension:'方法',status:'supported',summary:'方法说明',citations:['s1']},{paper_id:'p2',dimension:'方法',status:'missing',summary:'缺少方法原文',citations:[]}],unique_chunks:1,duplicate_chunks:0,duplicate_queries:0,stop_reason:null});
  tracker.update([{need_id:'cell:1',paper_id:'p2',status:'supported',source_ids:['s1']}],visible);
  const stopped=tracker.finish(undefined,'部分回答',['s1'],true);
  assert.equal(stopped.phase,'stopped');assert.equal(stopped.items.find(item=>item.id==='cell:0')?.state,'supported');assert.equal(stopped.items.find(item=>item.id==='cell:1')?.state,'gap');assert.equal(stopped.items.find(item=>item.id==='n2')?.state,'stopped');
  assert.deepEqual(JSON.parse(JSON.stringify(stopped)),stopped);
});
test('malformed optional progress updates are ignored without invalidating the answer state',()=>{
  const execution=parseTurnExecution({state:'complete',remaining_needs:[],goal_updates:[{need_id:'n2',status:'supported',source_ids:'bad'},{need_id:'n3',status:'gap',source_ids:[],note:'缺少依据'}]});
  assert.equal(execution?.state,'complete');assert.deepEqual(execution.goal_updates,[{need_id:'n3',status:'gap',source_ids:[],note:'缺少依据'}]);
});
