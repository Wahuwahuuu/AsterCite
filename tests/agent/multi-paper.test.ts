import test from 'node:test';
import assert from 'node:assert/strict';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {MultiPaperComparison,comparisonBudget} from '../../agent/multi-paper.ts';
import {sha} from '../../agent/config.ts';
import type {Chunk} from '../../agent/contracts.ts';
import type {MainHarnessOptions} from '../../agent/session-main-v2.ts';
import type {ExecutionEvent} from '../../agent/execution-trace.ts';
import {mainFixture,PREPARED_INDEX} from './main-fixture.ts';

const papers=Array.from({length:5},(_,i)=>({paper_id:`p${i+1}`,title:`Study ${i+1}`,abstract:'Navigation preview'}));
const ids=papers.map(p=>p.paper_id),dimensions=['实验设置','实验结果'];
const chunks:Chunk[]=[...ids,'p3'].map((paper,i)=>{const text=i===5?'A new results passage reports the missing comparison.':`${paper} experimental setup and results are described in this passage.`;
  const id=`${PREPARED_INDEX}:${paper}:s0:p${i}:c0-${text.length}`;return {paper_id:paper,paragraph_id:`${paper}:s0:p${i}`,chunk_id:id,citation:`[${id}]`,section:i===5?'Results':'Experiments',text,start:0,end:text.length,index_version:PREPARED_INDEX,truncated:false};});
const prep=reply(JSON.stringify({intent:'compare',targets:ids,rewrite:'比较选择的五篇论文的实验方法',queries:['experimental methods'],comparison_dimensions:dimensions}));
const retrieve=(paper:string,query=`${paper} experimental setup`)=>reply([call('retrieve_chunks',{paper_ids:[paper],query,top_k:5})],{stopReason:'toolUse'});

test('bounded evidence windows retain fresh material and expose omissions; continuation offsets are distinct queries',()=>{
  const workspace=new MultiPaperComparison('比较论文',['p1'],{requests:12,retrievals:6,searches:2,checks:3});
  const passages=[chunks[0],{...chunks[0],chunk_id:'new-source',text:'New result passage.'}];workspace.observe(['p1'],passages);
  const window=workspace.window(JSON.stringify(passages[1]).length+1);assert.deepEqual(window.map(c=>c.chunk_id),['new-source']);
  assert.equal(workspace.windowInfo(window).omitted_sources,1);
  assert.equal(workspace.claimQuery('results',['p1']),true);assert.equal(workspace.claimQuery('results',['p1'],{content_type:'text',offset:0}),false);
  assert.equal(workspace.claimQuery('results',['p1'],{offset:8}),true);assert.equal(workspace.claimQuery('results',['p1'],{content_type:'table'}),true);
});

test('an existing source-linked comparison survives empty supplement and final responses',async()=>{
  const draft=ids.map((id,i)=>`${id} 的方法说明 [cite:${chunks[i].chunk_id}]。`).join('\n');
  const setup=await fixture([prep,...ids.map(id=>retrieve(id)),reply(JSON.stringify(cells(true))),reply(draft),reply('',{stopReason:'length'}),reply('',{stopReason:'length'})]);
  try{const record=await setup.harness.runTurn('横向比较选择的五篇论文',ids,'comparison-empty-final');assert.equal(record.status,'completed',record.error??'');assert.ok(record.final_answer.startsWith(ids.map((id,i)=>`《Study ${i+1}》 的方法说明 [cite:${chunks[i].chunk_id}]。`).join('\n')));assert.equal(record.business_status,'partial');assert.ok(record.requests.length<20);assert.ok(record.citation_validity.cited_ids.length>=5);}
  finally{setup.harness.dispose();}
});
const cells=(missing=false)=>({cells:ids.flatMap((paper,i)=>dimensions.map(dimension=>({paper_id:paper,dimension,status:missing&&paper==='p3'&&dimension==='实验结果'?'missing':'supported',summary:missing&&paper==='p3'&&dimension==='实验结果'?'缺少结果原文':'有相关原文',citations:missing&&paper==='p3'&&dimension==='实验结果'?[]:[chunks[paper==='p3'&&dimension==='实验结果'&&!missing?5:i].chunk_id]})))});
const answer='|论文|实验设置|实验结果|\n|---|---|---|\n'+ids.map((paper,i)=>`|${paper}|设置 [cite:${chunks[i].chunk_id}]|结果 [cite:${chunks[paper==='p3'?5:i].chunk_id}]|`).join('\n');
const displayedAnswer='|论文|实验设置|实验结果|\n|---|---|---|\n'+ids.map((paper,i)=>`|《Study ${i+1}》|设置 [cite:${chunks[i].chunk_id}]|结果 [cite:${chunks[paper==='p3'?5:i].chunk_id}]|`).join('\n');
async function fixture(responses:Parameters<typeof mainFixture>[0],extra:Partial<MainHarnessOptions>={}){
  const actual:Array<{paper_ids:string[];query:string}>=[];
  const setup=await mainFixture(responses,[],{knownPaperIds:new Set(ids),selectedScopeCoverage:true,answerPolicy:'workbench-v1',
    controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)},
    p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,publicPapers:papers,nlu:true,reflect:false,structuredMemory:true,evidenceIndex:new Map(chunks.map(chunk=>[chunk.chunk_id,{...chunk,index_version:PREPARED_INDEX,text_sha256:sha(chunk.text)}]))},
    worker:{async request(method,params){if(method==='search_papers')return {papers,backend:'rrf_rerank',index_version:PREPARED_INDEX};
      const input=params as {paper_ids:string[];query:string};actual.push(input);
      return {chunks:input.paper_ids.flatMap(paper=>input.query.includes('missing results')&&paper==='p3'?[chunks[5]]:[chunks[ids.indexOf(paper)]]),backend:'rrf_rerank',index_version:PREPARED_INDEX};}},...extra});
  return {...setup,actual};
}

test('an already completed comparison is delivered without regenerating the table in another stage',async()=>{
  const text=ids.map((id,i)=>`${id} 的方法说明 [cite:${chunks[i].chunk_id}]。`).join('\n');
  const metadata={status:'partial',answer_kind:'comparison',execution:{state:'partial',remaining_needs:['原文尚未覆盖的结果表'],needs_sources:true}};
  const updates:Array<{text:string;phase?:string}>=[];
  const setup=await fixture([prep,...ids.map(id=>retrieve(id)),reply(JSON.stringify(cells(true))),reply(text+'\n\n```json\n'+JSON.stringify(metadata)+'\n```')],{completionPolicy:'turn-state-v1',onAnswerUpdate:update=>updates.push(update)});
  try{const result=await setup.harness.runTurn('横向比较论文，缺失原文请明确说明',ids,'comparison-deliver');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,8);assert.equal(result.requests.at(-1)?.stage,'compare_supplement');assert.ok(!result.requests.some(request=>['generate','citation_repair','turn_completion'].includes(request.stage??'')));assert.equal(result.execution?.state,'partial');assert.ok(result.final_answer.includes('《Study 1》'));assert.ok(!result.final_answer.includes('"execution"'));assert.ok(updates.some(update=>update.phase==='writing'));assert.equal(updates.at(-1)?.phase,'final');assert.equal(updates.at(-1)?.text,result.final_answer);}
  finally{setup.harness.dispose();}
});

test('five-paper comparison uses real model tool rounds, checks dimensions, and retrieves only the missing result',async()=>{
  const events:ExecutionEvent[]=[],admissions:string[]=[];
  const setup=await fixture([prep,reply([call('search_papers',{query:'Studies',limit:5})],{stopReason:'toolUse'}),...ids.map(id=>retrieve(id)),reply(JSON.stringify(cells(true))),retrieve('p3','p3 missing results'),reply(JSON.stringify(cells())),reply(answer)],{onExecutionEvent:event=>events.push(event),authorizeRequest:async request=>{admissions.push(request.request_id);}});
  try{
    const result=await setup.harness.runTurn('横向比较选择的五篇论文的实验方法',ids,'comparison-five');
    assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,displayedAnswer);
    assert.deepEqual(setup.actual.map(call=>call.paper_ids),[...ids.map(id=>[id]),['p3']]);
    assert.equal(result.tools.filter(tool=>tool.tool_name==='retrieve_chunks'&&tool.executed).length,6);
    assert.ok(result.tools.every(tool=>tool.execution_source==='model'));
    assert.equal(result.comparison?.budget.retrievals,15);assert.equal(result.comparison?.budget.requests,27);
    assert.deepEqual(result.comparison?.papers,ids);assert.equal(result.comparison?.checks,2);assert.ok(result.comparison?.cells.every(cell=>cell.status==='supported'));
    assert.equal(result.citation_validity.unknown_ids.length,0);assert.equal(admissions.length,result.requests.length);
    assert.ok(events.some(event=>event.stage==='compare_supplement'&&event.kind==='model'&&event.input));
    assert.equal(events.filter(event=>event.kind==='model'&&event.stage==='comparison_check'&&event.status==='completed').length,2);
    const finalInput=events.findLast(event=>event.kind==='model'&&event.stage==='generate'&&event.status==='running')?.input;
    const input=JSON.stringify(finalInput);for(const chunk of chunks)assert.ok(input.includes(chunk.chunk_id));
    assert.deepEqual(setup.harness.snapshot().state.domain_state?.comparison_order,ids);
  }finally{setup.harness.dispose();}
});

test('duplicate queries do not execute again, duplicate evidence occupies one source slot, and remaining gaps are reported',async()=>{
  const tracker=new MultiPaperComparison('比较实验方法',ids,comparisonBudget('比较实验方法',ids)!,dimensions);
  assert.equal(tracker.claimQuery(' setup  ',['p1']),true);assert.equal(tracker.claimQuery('setup',['p1']),false);
  const duplicate={...chunks[0],chunk_id:'same-text-second-id'};
  tracker.observe(['p1'],[chunks[0],duplicate]);tracker.observe(['p1'],[chunks[0]]);
  assert.equal(tracker.report().unique_chunks,1);assert.equal(tracker.report().duplicate_chunks,2);
  assert.deepEqual(tracker.baselineMissing,ids.slice(1));assert.deepEqual(tracker.window(10000).map(chunk=>chunk.chunk_id),[chunks[0].chunk_id]);
  tracker.applyCheck({cells:[{paper_id:'p2',dimension:'实验设置',status:'supported',summary:'incorrect cross-paper source',citations:[chunks[0].chunk_id]}]},new Map([[chunks[0].chunk_id,chunks[0]]]));
  assert.equal(tracker.report().cells.find(cell=>cell.paper_id==='p2'&&cell.dimension==='实验设置')?.status,'missing');
  assert.ok(tracker.queriesForGaps().every(query=>!query.paper_ids.includes('p1')));

  const missing=cells(true);const duplicateCalls=reply([call('retrieve_chunks',{paper_ids:['p3'],query:'p3 experimental setup'})],{stopReason:'toolUse'});
  const setup=await fixture([prep,...ids.map(id=>retrieve(id)),reply(JSON.stringify(missing)),duplicateCalls,retrieve('p3','different query same evidence'),reply('|论文|结论|\n|---|---|\n'+ids.map((id,i)=>`|${id}|设置见原文 [cite:${chunks[i].chunk_id}]${id==='p3'?'，实验结果证据不足':''}|`).join('\n'))]);
  try{const result=await setup.harness.runTurn('比较五篇论文的实验方法',ids,'comparison-duplicates');assert.equal(result.status,'completed',result.error??'');
    assert.equal(setup.actual.length,6);assert.equal(result.comparison?.duplicate_queries,1);assert.equal(result.comparison?.unique_chunks,5);assert.equal(result.comparison?.duplicate_chunks,1);
    assert.match(result.final_answer,/实验结果证据不足/);assert.equal(result.business_status,'partial');assert.equal(result.comparison?.stop_reason,'连续查找没有获得新证据');assert.deepEqual(result.citation_validity.unknown_ids,[]);
  }finally{setup.harness.dispose();}
});

test('strict research runs and ordinary small-scope questions retain their original allowances',()=>{
  assert.equal(comparisonBudget('介绍这几篇论文',ids.slice(0,3)),undefined);
  assert.equal(comparisonBudget('比较这个方法',['p1']),undefined);
  assert.equal(comparisonBudget('你好',ids),undefined);
  assert.equal(comparisonBudget('比较这两篇论文',ids.slice(0,2))?.retrievals,6);
  assert.equal(comparisonBudget('比较所有论文',Array.from({length:100},(_,i)=>String(i)))?.requests,64);
});

test('failed optional coverage parsing preserves evidence and allows a normal comparison answer',async()=>{
  const setup=await fixture([prep,...ids.map(id=>retrieve(id)),reply('This is not valid coverage JSON.'),retrieve('p3','p3 missing results'),reply(JSON.stringify(cells())),reply(answer)]);
  try{const result=await setup.harness.runTurn('比较五篇论文的实验方法',ids,'comparison-check-fallback');
    assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,displayedAnswer);assert.equal(result.comparison?.checks,2);
    assert.ok(result.reliability_adaptations.some(item=>item.kind==='comparison_check_unavailable'));assert.deepEqual(result.citation_validity.unknown_ids,[]);
  }finally{setup.harness.dispose();}
});

test('premature model replies cannot silently omit papers; baseline fallback is an actual host tool batch',async()=>{
  const setup=await fixture([prep,reply('让我先查找论文。'),reply('我将比较这五篇论文。'),reply(JSON.stringify(cells(true))),retrieve('p3','p3 missing results'),reply(JSON.stringify(cells())),reply(answer)]);
  try{const result=await setup.harness.runTurn('比较五篇论文的实验方法',ids,'comparison-baseline-fallback');
    assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,displayedAnswer);
    assert.deepEqual(setup.actual.slice(0,5).map(call=>call.paper_ids),ids.map(id=>[id]));
    assert.equal(result.tools.filter(tool=>tool.execution_source==='host_plan'&&tool.executed).length,5);
    assert.equal(result.tools.filter(tool=>tool.execution_source==='model'&&tool.executed).length,1);
  }finally{setup.harness.dispose();}
});
