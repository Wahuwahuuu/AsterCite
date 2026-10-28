import test from 'node:test';
import assert from 'node:assert/strict';
import {splitAnswerControl,displayPaperTitles} from '../../web/answer-format.js';
import {prepareWorkbenchAnswer} from '../../agent/workbench-answer.ts';
import {executionFromOutput} from '../../agent/turn-execution.ts';
import {mainFixture,preparation,SOURCE_IDS} from './main-fixture.ts';
import {fauxAssistantMessage as reply} from '@earendil-works/pi-ai';

const metadata={status:'complete',answer_kind:'comparison_table',execution:{state:'complete',remaining_needs:[],needs_sources:true}};
const papers=[{paper_id:'1705.02394',title:'Learning Representations of Emotional Speech'},{paper_id:'1611.09441',title:'Sentiment Analysis for Twitter'}];

test('runtime control footers are parsed separately from Markdown and historical host notices',()=>{
  for(const suffix of ['\n\n```json\n'+JSON.stringify(metadata)+'\n```','\n\n'+JSON.stringify(metadata),'\n\n```json\n'+JSON.stringify(metadata)]){
    const text='## 论文比较\n\n这是正文。'+suffix,parts=splitAnswerControl(text);
    assert.equal(parts.body,'## 论文比较\n\n这是正文。');assert.equal(executionFromOutput(text)?.state,'complete');
    const result=prepareWorkbenchAnswer(text,{evidence:new Map(),allowAnswer:true})!;assert.ok(result.value.answer.startsWith(parts.body));assert.ok(!result.value.answer.includes('"execution"'));
  }
  const history='正文\n\n```json\n'+JSON.stringify(metadata)+'\n```\n\n原文关联说明：部分依据仍需核对。';
  assert.equal(splitAnswerControl(history).body,'正文\n\n原文关联说明：部分依据仍需核对。');
  assert.equal(executionFromOutput('正文\n\n```json\n'+JSON.stringify({status:'complete',answer_kind:'comparison',needs_sources:true,paper_coverage:{paper:'partial'}})+'\n```')?.state,'complete');
});

test('scientific JSON, inline examples and code followed by an explanation are retained',()=>{
  const science='实验数据：\n\n```json\n{"status":"complete","accuracy":0.9,"rows":[1,2]}\n```';assert.equal(splitAnswerControl(science).body,science);
  const explanation='协议示例：\n\n```json\n'+JSON.stringify(metadata)+'\n```\n\n下面解释这些字段。';assert.equal(splitAnswerControl(explanation).body,explanation);
  assert.equal(splitAnswerControl('`'+JSON.stringify(metadata)+'`').body,'`'+JSON.stringify(metadata)+'`');
});

test('paper titles replace bare identifiers without altering evidence markers, code, links or formulas',()=>{
  const source='1705.02394 与 1611.09441 比较。\n[cite:index:1705.02394:s0:c0-20]\n`1705.02394`\nhttps://arxiv.org/abs/1705.02394\n$1705.02394$\n```json\n{"paper_id":"1705.02394"}\n```';
  const text=displayPaperTitles(source,papers);assert.ok(text.startsWith('《Learning Representations of Emotional Speech》 与 《Sentiment Analysis for Twitter》'));
  for(const fragment of ['[cite:index:1705.02394:s0:c0-20]','`1705.02394`','https://arxiv.org/abs/1705.02394','$1705.02394$','"paper_id":"1705.02394"'])assert.ok(text.includes(fragment));
  assert.equal(displayPaperTitles('Learning Representations of Emotional Speech（1705.02394）',papers),'Learning Representations of Emotional Speech（1705.02394）');
});

test('a footer-completed ordinary answer does not need another completion request',async()=>{
  const answer=`正文说明 [cite:${SOURCE_IDS[0]}]。`,raw=answer+'\n\n```json\n'+JSON.stringify(metadata)+'\n```';
  const setup=await mainFixture([reply(JSON.stringify(preparation)),reply(raw)],[[0]],{answerPolicy:'workbench-v1',completionPolicy:'turn-state-v1',controls:{arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)}});
  try{const result=await setup.harness.runTurn('解释论文方法',['p1'],'mixed-footer');assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,answer);assert.equal(result.requests.length,2);assert.equal(result.execution?.state,'complete');}
  finally{setup.harness.dispose();}
});
