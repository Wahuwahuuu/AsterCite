import assert from 'node:assert/strict';
import test from 'node:test';
import {fauxAssistantMessage as reply,fauxToolCall as call} from '@earendil-works/pi-ai';
import {corpusAbstracts,groundedGenerationMessages,abstractReadingSection,withAbstractReading} from '../../agent/paper-reading.ts';
import {inspectCitationAttribution} from '../../agent/citation-attribution.ts';
import {prepareWorkbenchAnswer} from '../../agent/workbench-answer.ts';
import {mainFixture,preparation,PREPARED_INDEX,SOURCE_IDS} from './main-fixture.ts';
import type {Chunk,Paper,P2HarnessConfig} from '../../agent/contracts.ts';

const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
const fullAbstract='公开背景信息。'.repeat(440)+' Classification accuracy reaches 43.88% on a five-point scale and 49.80% on a three-point scale.';
const paper:Paper={paper_id:'p1',title:'Learning Representations in Speech',abstract:fullAbstract};
const abstract=corpusAbstracts([paper],PREPARED_INDEX).get('p1')!;
const method={paper_id:'p1',chunk_id:'method',text:'The proposed model uses adversarial and multitask learning.',section:'Methods'} as Chunk;
const result={paper_id:'p1',chunk_id:'result',text:'The reported classification accuracy is 43.88%.',section:'Results'} as Chunk;

test('full abstracts are separate corpus-backed reading sources without modifying the ranked index',()=>{
  const base:P2HarnessConfig={profile:'B',indexVersion:PREPARED_INDEX,evidenceIndex:new Map(),publicPapers:[paper]},copy=withAbstractReading(base);
  assert.equal(base.evidenceIndex.size,0);assert.equal(base.abstractSources,undefined);
  assert.equal(copy.abstractSources?.get('p1')?.text,fullAbstract);assert.ok(fullAbstract.length>2000);
  assert.equal(abstract.section,'Abstract');assert.equal(abstract.end,Array.from(fullAbstract).length);assert.ok(abstract.chunk_id.includes(':abstract-v1:'));
  assert.equal(copy.evidenceIndex.get(abstract.chunk_id)?.end,abstract.end);
  assert.equal(withAbstractReading(copy).evidenceIndex.size,copy.evidenceIndex.size);
  assert.equal(corpusAbstracts([{...paper,abstract:''}],PREPARED_INDEX).size,0);
});

test('generation excludes catalog previews and intermediate drafts while preserving actual excerpts and prior replies',()=>{
  const messages=[
    {role:'user',content:[{type:'text',text:'请解释论文'}]},
    {role:'assistant',content:[{type:'text',text:'unverified intermediate draft'},{type:'toolCall',name:'search_papers',id:'search',arguments:{query:'learning'}}]},
    {role:'toolResult',toolName:'search_papers',toolCallId:'search',content:[{type:'text',text:JSON.stringify({papers:[{...paper,abstract:fullAbstract.slice(0,1200)}],index_version:PREPARED_INDEX})}]},
    {role:'toolResult',toolName:'retrieve_chunks',toolCallId:'read',content:[{type:'text',text:JSON.stringify({chunks:[abstract]})}]},
    {role:'assistant',content:[{type:'text',text:'accepted previous reply'}]}
  ];
  const original=structuredClone(messages),clean=groundedGenerationMessages(messages,m=>m.content.some(block=>block.text==='accepted previous reply'));
  assert.deepEqual(messages,original);assert.equal(clean[1].content.length,1);assert.equal(clean[1].content[0].type,'toolCall');
  const catalog=JSON.parse(clean[2].content[0].text!);assert.equal(catalog.papers[0].abstract,undefined);assert.equal(catalog.papers[0].title,paper.title);
  assert.equal(clean[3].content[0].text,messages[3].content[0].text);assert.equal(clean[4].content[0].text,'accepted previous reply');
});

test('abstract reading handles explicit source requests without hijacking other section questions',()=>{
  assert.equal(abstractReadingSection('请说明标题以Learning开头的论文摘要'),'abstract');
  assert.equal(abstractReadingSection('Explain this paper abstract'),'abstract');
  assert.equal(abstractReadingSection('不要摘要，讲实验结果'),undefined);
  assert.equal(abstractReadingSection('摘要和方法章节都讲讲','method details'),undefined);
  assert.equal(abstractReadingSection('摘要和方法章节都讲讲','original abstract'),'abstract');
});

test('a valid ID from an unrelated section is not accepted as support for a reported percentage',()=>{
  const evidence=new Map([['method',method],['result',result]]),raw='实验分类准确率达到43.88% [cite:method]。';
  const checked=inspectCitationAttribution(raw,evidence);
  assert.deepEqual(checked.issues,['metric_source_mismatch:43.88%']);assert.ok(!checked.answer.includes('[cite:method]'));
  assert.match(checked.answer,/该数值依据待核对/);assert.deepEqual(checked.checks[0].candidate_sources['43.88%'],['result']);
  assert.ok(!checked.answer.includes('[cite:result]'),'a matching number must not silently reassign a claim to another source');
});

test('one citation at the end of an answer cannot hide an uncited result in an earlier paragraph',()=>{
  const raw='实验结果的准确率为43.88%。\n\n简单说是使用对抗网络。[cite:method]';
  const checked=inspectCitationAttribution(raw,new Map([['method',method]]));
  assert.equal(checked.checks[0].assessment,'missing_citation');assert.match(checked.answer,/43.88%〔该数值依据待核对〕/);assert.ok(checked.answer.includes('[cite:method]'));
});

test('percentage checks allow explicit rounding and escaped percent notation without changing exact figures',()=>{
  const evidence=new Map([['result',result]]);
  assert.deepEqual(inspectCitationAttribution('分类准确率约44% [cite:result]。',evidence).issues,[]);
  assert.deepEqual(inspectCitationAttribution('分类准确率43.88\\% [cite:result]。',evidence).issues,[]);
  assert.deepEqual(inspectCitationAttribution('分类准确率44% [cite:result]。',evidence).issues,['metric_source_mismatch:44%']);
});

test('reported values can share a real paragraph citation, while examples and explicit calculations remain distinct',()=>{
  const evidence=new Map([[abstract.chunk_id,abstract]]);
  const answer=`实验中五分类准确率43.88%，三分类49.8%。[cite:${abstract.chunk_id}]`;
  assert.deepEqual(inspectCitationAttribution(answer,evidence).issues,[]);
  assert.deepEqual(inspectCitationAttribution('假设分类准确率为50%，这里只是举例。',evidence).issues,[]);
  assert.deepEqual(inspectCitationAttribution('两者相减计算得提高5.92%，这是推算值。',evidence).issues,[]);
  const refusal=prepareWorkbenchAnswer(JSON.stringify({status:'refusal',answer:'现有原文不足以证实准确率43.88%。'}),{evidence,expectedKind:'paper_fact',allowAnswer:true})!;
  assert.deepEqual(refusal.attribution,[]);assert.equal(refusal.needsCitationRepair,false);
});

test('a title-fragment abstract request reads full source and cites the Abstract, not a method paragraph',async()=>{
  const f=await mainFixture([
    reply(JSON.stringify({intent:'find_papers',targets:['p1'],rewrite:'Explain the original abstract',queries:['abstract learning']})),
    context=>{assert.ok(JSON.stringify(context).includes('49.80%'));return reply(`五分类准确率43.88%，三分类49.80%。[cite:${abstract.chunk_id}]`);}
  ],[[0]],{answerPolicy:'workbench-v1',controls,
    p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,evidenceIndex:new Map(),publicPapers:[paper],reflect:false,structuredMemory:true}
  });let snapshot;
  try{
    const r=await f.harness.runTurn('请说明标题以Learning开头的论文摘要',['p1'],'reading/abstract');
    assert.equal(r.status,'completed',r.error??'');assert.equal(r.requests.length,2);assert.equal(f.calls.length,0);
    assert.equal(r.question_preparation.result?.frame.intent,'single_paper_qa');assert.equal(r.tools[0].backend,'corpus_abstract_v1');
    assert.deepEqual(r.citation_validity.cited_ids,[abstract.chunk_id]);assert.ok(r.final_answer.includes('49.80%'));assert.ok(!r.final_answer.includes('截断'));
    assert.ok(r.citation_attribution?.every(check=>check.assessment==='value_present'));snapshot=f.harness.snapshot();
  }finally{f.harness.dispose();}
  const restored=await mainFixture([reply(JSON.stringify({intent:'answer',targets:['p1'],queries:['abstract']})),reply(`三分类准确率49.80%。[cite:${abstract.chunk_id}]`)],[[0]],{answerPolicy:'workbench-v1',controls,controlledSnapshot:snapshot,
    p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,evidenceIndex:new Map(),publicPapers:[paper],reflect:false,structuredMemory:true}});
  try{const r=await restored.harness.runTurn('继续讲摘要的结果',['p1'],'reading/restored');assert.equal(r.status,'completed',r.error??'');assert.ok(r.final_answer.includes('49.80%'));}
  finally{restored.harness.dispose();}
});

test('autonomous lookup labels previews and removes them from final generation after original-source reading',async()=>{
  let checkedPreview=false;
  const f=await mainFixture([
    reply('malformed preparation'),reply([call('search_papers',{query:'learning'})],{stopReason:'toolUse'}),
    context=>{const serialized=JSON.stringify(context);assert.ok(serialized.includes('abstract_truncated'));checkedPreview=true;return reply([call('retrieve_chunks',{query:'abstract speech',paper_ids:['p1']})],{stopReason:'toolUse'});},
    context=>{
      const catalogs=context.messages.filter(message=>message.role==='toolResult'&&message.toolName==='search_papers');assert.equal(catalogs.length,1);
      const content=catalogs[0].content,data=JSON.parse(typeof content==='string'?content:content.filter(block=>block.type==='text').map(block=>block.text).join(''));
      assert.equal(data.papers[0].abstract,undefined);assert.ok(JSON.stringify(context).includes('49.80%'));return reply(`三分类准确率为49.80%。[cite:${abstract.chunk_id}]`);
    }
  ],[],{answerPolicy:'workbench-v1',controls,p2:{profile:'B',executionVersion:'full-v1',answerContract:'full-v1-json',indexVersion:PREPARED_INDEX,evidenceIndex:new Map(),publicPapers:[paper],reflect:false,structuredMemory:true},
    worker:{async request(method){assert.equal(method,'search_papers');return {backend:'rrf_rerank',index_version:PREPARED_INDEX,papers:[{...paper,abstract:fullAbstract.slice(0,1200)}]};}}});
  try{const r=await f.harness.runTurn('请解释以Learning开头的论文摘要',[],'reading/discover');assert.equal(r.status,'completed',r.error??'');assert.equal(r.requests.length,4);assert.equal(checkedPreview,true);assert.equal(r.tools.at(-1)?.backend,'corpus_abstract_v1');assert.ok(r.final_answer.includes('49.80%'));}
  finally{f.harness.dispose();}
});

test('other research questions also receive bounded source-attribution correction without erasing useful text',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(`实验准确率43.88% [cite:${SOURCE_IDS[0]}]。`),reply(`这段原文支持该方法的说明 [cite:${SOURCE_IDS[0]}]，但没有报告准确率。`)],[[0]],{answerPolicy:'workbench-v1',controls,maxRequests:3});
  try{const r=await f.harness.runTurn('p1 的实验准确率是多少？',['p1'],'reading/metric');assert.equal(r.status,'completed',r.error??'');assert.equal(r.requests.length,3);assert.ok(r.generation_failures?.[0].error.includes('metric_source_mismatch:43.88%'));assert.ok(!r.final_answer.includes('43.88%'));assert.ok(r.final_answer.includes('没有报告准确率'));}
  finally{f.harness.dispose();}
});
