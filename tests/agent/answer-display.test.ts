import assert from 'node:assert/strict';
import test from 'node:test';
import {fauxAssistantMessage as reply} from '@earendil-works/pi-ai';
import {AnswerStreamer,visibleAnswerPrefix} from '../../agent/answer-stream.ts';
import {markdownToHtml} from '../../web/markdown.js';
import {executionTime,readQuestionStream} from '../../web/activity.js';
import {mainFixture,preparation,SOURCE_IDS} from './main-fixture.ts';
import type {WebView,WebSource} from '../../agent/web-session.ts';

test('execution clocks use integer seconds without a frozen decimal digit',()=>{
  assert.equal(executionTime(100),'0 秒');assert.equal(executionTime(1900),'1 秒');assert.equal(executionTime(62300),'1 分 2 秒');assert.equal(executionTime(-1),'0 秒');
});
test('answer prefixes decode incomplete JSON escapes and wrappers without exposing auxiliary fields',()=>{
  assert.equal(visibleAnswerPrefix('{"status":"answer","answer":"第一行\\n第二'),'第一行\n第二');
  assert.equal(visibleAnswerPrefix('```json\n{"answer":"公式 \\u03b1'),'公式 α');
  assert.equal(visibleAnswerPrefix('{"answer":"a\\u03'),'a');
  assert.equal(visibleAnswerPrefix('{"final_answer":{"answer":"正文'),'正文');
  assert.equal(visibleAnswerPrefix('{"metadata":{"answer":"not a reply"}}'),'');
  assert.equal(visibleAnswerPrefix('## 原理\n\n$E=mc^2$'),'## 原理\n\n$E=mc^2$');
});
test('a credential split across answer chunks is withheld and redacted before transmission',()=>{
  const secret='fixture-stream-credential',updates:string[]=[];let now=1000;
  const stream=new AnswerStreamer(update=>updates.push(update.text),[secret],()=>now+=100);
  for(let i=1;i<=secret.length;i++)stream.update('request','正文 '+secret.slice(0,i),[]);
  assert.ok(updates.every(text=>!text.includes(secret)&&!text.includes('fixture-stream-')));assert.match(updates.at(-1)!,/REDACTED/u);
  const before=updates.at(-1);stream.update('correction','修正后的正文',[],true);assert.equal(updates.at(-1),before);
  stream.commit('correction','修正后的正文',[]);assert.equal(updates.at(-1),'修正后的正文');
});

test('later revisions retain the existing stream and commit the chosen answer once',()=>{
  const updates:Array<{request_id:string;text:string;phase?:string}>=[],stream=new AnswerStreamer(update=>updates.push(update),[],()=>1000);
  stream.update('first','完整的第一版回答',[],true);
  for(const prefix of ['修','修订','修订后的回答'])stream.update('repair',prefix,[],true);
  assert.deepEqual(updates.map(update=>update.text),['完整的第一版回答','完整的第一版回答']);assert.equal(updates.at(-1)?.phase,'reviewing');
  stream.commit('repair','修订后的回答',[]);assert.equal(updates.at(-1)?.phase,'final');assert.equal(updates.at(-1)?.text,'修订后的回答');
  stream.reset();stream.update('next-turn','下一轮从这里开始',[],true);assert.equal(updates.at(-1)?.phase,'writing');assert.equal(updates.at(-1)?.text,'下一轮从这里开始');
});

test('mixed Markdown streaming never emits a trailing runtime-control object',()=>{
  const prefix='## 论文方法\n\n这是回答。\n\n',json='```json\n{"status":"complete","answer_kind":"comparison","needs_sources":true}\n```';
  for(let i=1;i<=json.length;i++){const text=visibleAnswerPrefix(prefix+json.slice(0,i));assert.ok(!text.includes('"status"'));assert.ok(!text.includes('"needs_sources"'));}
  assert.equal(visibleAnswerPrefix(prefix+json,[],true),prefix.trimEnd());
});
test('headers, nested lists, tables, code and all common math delimiters produce structured markup',()=>{
  const html=markdownToHtml('# 标题\n\n## 方法\n\n- 第一项\n  - 第二层\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst value = "$literal$";\n```\n\n内联 $x^2$，以及 \\(\\alpha+1\\)。\n\n$$\\frac{a}{b}$$\n\n\\[E=mc^2\\]');
  for(const fragment of ['<h1>标题','<h2>方法','<ul>','<table>','<pre><code','katex','<math'])assert.ok(html.includes(fragment),fragment);
  assert.ok(html.includes('$literal$'));assert.equal((html.match(/class="katex"/gu)??[]).length,4);
});
test('raw HTML and dangerous links stay inert and citations retain real numbered identities',()=>{
  const source={chunk_id:'real-source'} as WebSource;
  const html=markdownToHtml('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))\n\n正常 [cite:real-source]，未知 [cite:missing]。\n\n`[cite:real-source]`',{sources:[source]});
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(html.includes('data-citation-index="0"'));assert.equal((html.match(/data-citation-index/gu)??[]).length,1);assert.ok(html.includes('<code>[cite:real-source]</code>'));
  assert.ok(markdownToHtml('半条 [cite:real-',{}).includes('半条'));assert.ok(!markdownToHtml('半条 [cite:real-',{}).includes('[cite:'));
});
test('answer transport delivers text frames before the final result across split UTF-8 chunks',async()=>{
  const received:string[]=[],encoder=new TextEncoder(),frames=[{type:'ready'},{type:'answer',update:{request_id:'r',text:'第一段',source_ids:[],sources:[]}},{type:'answer',update:{request_id:'r',text:'第一段，第二段',source_ids:[],sources:[]}},{type:'result',view:{turns:[]} as unknown as WebView}];
  const bytes=encoder.encode(frames.map(frame=>JSON.stringify(frame)+'\n').join(''));
  const body=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();}});
  const result=await readQuestionStream(new Response(body),()=>{},update=>received.push(update.text));assert.deepEqual(received,['第一段','第一段，第二段']);assert.deepEqual(result.turns,[]);
});
test('task progress is delivered independently from model text and survives UTF-8 frame splitting',async()=>{
  const events:unknown[]=[],progress={version:1,phase:'running',items:[{id:'n2',label:'比较实验',state:'running',source_ids:[],note:''}]},data=new TextEncoder().encode(JSON.stringify({type:'task_progress',progress})+'\n'+JSON.stringify({type:'result',view:{turns:[]}})+'\n');
  const body=new ReadableStream({start(controller){for(let i=0;i<data.length;i+=3)controller.enqueue(data.slice(i,i+3));controller.close();}});
  await readQuestionStream(new Response(body),()=>{},()=>{},value=>events.push(value));assert.deepEqual(events,[progress]);
});
test('Harness streams only visible final-answer text while retaining its normal source validation',async()=>{
  const updates:string[]=[],controls={arm:'C',reflect:false,compaction:'off',reliability:'candidate',implementation_id:'1'.repeat(64)} as const;
  const f=await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({status:'answer',answer:`## 方法\n原文解释 [cite:${SOURCE_IDS[0]}]。`}))],[[0]],{answerPolicy:'workbench-v1',controls,onAnswerUpdate:update=>updates.push(update.text)});
  try{const result=await f.harness.runTurn('解释论文方法',['p1'],'streaming');assert.equal(result.status,'completed',result.error??'');assert.equal(result.requests.length,2);assert.ok(updates.length>0);assert.equal(updates.at(-1),result.final_answer);assert.ok(updates.every(text=>!text.includes('"status"')&&!text.includes('"targets"')));}
  finally{f.harness.dispose();}
});
