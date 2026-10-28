import assert from 'node:assert/strict';
import test from 'node:test';
import {fauxAssistantMessage as reply} from '@earendil-works/pi-ai';
import {isConversationalInput,parseQuestionPreparation,rawQuestionFrame} from '../../agent/question-preparation.ts';
import {parseFinalAnswer} from '../../agent/final-answer.ts';
import {mainFixture,preparation,final} from './main-fixture.ts';

const controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
const greeting={status:'answer',answer:'你好！可以向我提问，也可以选论文阅读。',exact_quotes:[]};

test('pure conversation is distinct from greetings followed by research questions',()=>{
  for(const input of ['你好','您好！','谢谢你。','HELLO!','你能做什么？','使用帮助'])assert.equal(isConversationalInput(input),true,input);
  for(const input of ['你好，请介绍 p1 的方法','谢谢，p1 的结果是多少？','你好，这篇论文有什么贡献','hello, compare these papers','论文研究如何回答问候','怎么用'])assert.equal(isConversationalInput(input),false,input);
  assert.equal(rawQuestionFrame('你好','turn').intent,'session_control');
  const value=parseQuestionPreparation(JSON.stringify(preparation),{original:'你好',allowed:new Set(['p1']),publicPapers:[{paper_id:'p1',title:'Paper One',abstract:''}],frameId:'turn',history:[],activeConstraints:[]});
  assert.equal(value.frame.intent,'session_control');assert.deepEqual(value.frame.ordered_targets,[]);assert.deepEqual(value.frame.queries,[]);assert.equal(value.routing,'host_queries');
});

test('a known conversation/catalog kind is inherited when omitted, while research still requires visible citations',()=>{
  assert.equal(parseFinalAnswer(JSON.stringify(greeting),new Map(),true,false,'session_control').answer_kind,'session_control');
  assert.equal(parseFinalAnswer(JSON.stringify({status:'answer',answer:'可阅读 Paper One。'}),new Map(),true,false,'catalog').answer_kind,'catalog');
  assert.throws(()=>parseFinalAnswer(JSON.stringify(greeting),new Map(),true,false),/requires a visible/);
  assert.throws(()=>parseFinalAnswer(JSON.stringify({...greeting,answer_kind:'session_control'}),new Map(),true,false,'paper_fact'),/answer_kind/);
  assert.throws(()=>parseFinalAnswer(JSON.stringify({...greeting,answer:'你好 [cite:invented]'}),new Map(),true,false,'session_control'),/not currently visible/);
});

test('the original greeting regression finishes with the model answer and no retrieval or citation repair',async()=>{
  const f=await mainFixture([reply(JSON.stringify({intent:'answer',targets:[],rewrite:'你好',queries:[],constraints:[]})),reply(JSON.stringify(greeting))],[[]],{controls});
  try{const result=await f.harness.runTurn('你好',['p1'],'conversation/hello');assert.equal(result.status,'completed',result.error??'');assert.equal(result.final_answer,greeting.answer);assert.deepEqual(result.requests.map(request=>request.stage),['question_preparation','generate']);assert.equal(f.calls.length,0);assert.equal(result.final_structure?.answer_kind,'session_control');}
  finally{f.harness.dispose();}
});

test('malformed preparation cannot force an unambiguous greeting through factual retrieval',async()=>{
  const f=await mainFixture([reply('invalid preparation'),reply(JSON.stringify(greeting))],[[]],{controls});
  try{const result=await f.harness.runTurn('你好',['p1'],'conversation/fallback');assert.equal(result.status,'completed',result.error??'');assert.equal(result.question_preparation.status,'fallback');assert.equal(result.final_answer,greeting.answer);assert.equal(f.calls.length,0);assert.equal(result.requests.length,2);}
  finally{f.harness.dispose();}
});

test('a greeting followed by a paper question retains retrieval and citation validation',async()=>{
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify(final))],[[0]],{controls});
  try{const result=await f.harness.runTurn('你好，请介绍 p1 的方法',['p1'],'conversation/research');assert.equal(result.status,'completed',result.error??'');assert.equal(f.calls.length,1);assert.equal(result.final_structure?.answer_kind,'paper_fact');assert.ok(result.citation_validity.cited_ids.length);}
  finally{f.harness.dispose();}
});

test('citation correction may withdraw an unsupported claim into a bounded evidence-insufficient refusal',async()=>{
  const refusal={status:'refusal',answer:'当前没有找到支持该结论的论文原文，无法确认。',exact_quotes:[]};
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({status:'answer',answer:'不受支持的结论 [cite:missing]'})),reply(JSON.stringify(refusal))],[[]],{controls,maxRequests:3});
  try{const result=await f.harness.runTurn('p1 的实验结论是什么？',['p1'],'conversation/refusal');assert.equal(result.status,'completed',result.error??'');assert.equal(result.business_status,'refusal');assert.equal(result.final_answer,refusal.answer);assert.equal(result.requests.length,3);assert.equal(result.generation_failures?.length,1);}
  finally{f.harness.dispose();}
});
