import test from 'node:test';
import assert from 'node:assert/strict';
import {ReaderFollow,lastCitedPaper} from '../../web/reader-follow.js';
import type {WebSource,WebView} from '../../agent/web-session.ts';

const sources:WebSource[]=['a','b'].map(id=>({chunk_id:'chunk-'+id,paper_id:id,title:'Paper '+id,section:'abstract',text:'Original '+id}));
const view=(answer:string,refs=sources,paper:string|null=null):Pick<WebView,'turns'|'memory'>=>({turns:[{question:'Discuss these papers',answer,sources:refs,status:'completed',elapsed_ms:0,requests:0,tokens:0,stages:[],turn_id:'turn-one'}],memory:{paper_id:paper,comparison:[],dimensions:[],preferences:[],object_source_turn:'turn-one'}});
function reader(){let current:string|null=null;const opened:string[]=[];const follow=new ReaderFollow({open:id=>{opened.push(id);current=id;},current:()=>current});follow.setPapers([{paper_id:'a'},{paper_id:'b'}]);return {follow,opened,setCurrent:(id:string)=>{current=id;}};}

test('reader follows complete visible citations from known papers, excluding unknown and quoted markers',()=>{
  const known=new Set(['a','b']);
  assert.equal(lastCitedPaper('A [cite:chunk-a]\nB [cite:chunk-b]',sources,known),'b');
  assert.equal(lastCitedPaper('A [cite:chunk-a] partial [cite:chunk-b',sources,known),'a');
  assert.equal(lastCitedPaper('A [cite:chunk-a] [cite:unknown] `example [cite:chunk-b]`',sources,known),'a');
  assert.equal(lastCitedPaper('```\n[cite:chunk-b]\n```',sources,known),null);
  assert.equal(lastCitedPaper('[cite:chunk-b]',sources,new Set(['a'])),null);
});

test('retrieval opens a real returned paper once; each completed citation can move a multi-paper answer',()=>{
  const {follow,opened}=reader();
  follow.activity({kind:'tool',tool:'search_papers',status:'completed',paper_ids:['a']});
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'running',paper_ids:['a']});
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'error',paper_ids:['a']});
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'completed',paper_ids:['unknown']});assert.deepEqual(opened,[]);
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'completed',paper_ids:['a','b']});
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'completed',paper_ids:['b']});assert.deepEqual(opened,['a']);
  follow.answer({text:'A [cite:chunk-a]',sources});follow.answer({text:'A [cite:chunk-a] more text',sources});
  follow.answer({text:'A [cite:chunk-a] B [cite:chunk-b',sources});assert.deepEqual(opened,['a']);
  follow.answer({text:'A [cite:chunk-a] B [cite:chunk-b]',sources});
  follow.finish(view('A [cite:chunk-a] B [cite:chunk-b]'));assert.deepEqual(opened,['a','b']);
});

test('manual reading stays selected throughout the reply and follows again at the next question',()=>{
  const {follow,opened,setCurrent}=reader();
  follow.activity({kind:'tool',tool:'retrieve_chunks',status:'completed',paper_ids:['a']});
  setCurrent('b');follow.manual();follow.answer({text:'A [cite:chunk-a]',sources});follow.finish(view('A [cite:chunk-a]'));assert.deepEqual(opened,['a']);
  follow.beginTurn();follow.answer({text:'A [cite:chunk-a]',sources});assert.deepEqual(opened,['a','a']);
  follow.setEnabled(false);follow.beginTurn();follow.finish(view('B [cite:chunk-b]'));assert.deepEqual(opened,['a','a']);
  follow.setEnabled(true);follow.finish(view('B [cite:chunk-b]'));assert.deepEqual(opened,['a','a','b']);
});

test('restored conversations locate their cited paper or current-turn memory while empty results preserve the reader',()=>{
  const {follow,opened}=reader();
  follow.finish(view('B [cite:chunk-b]',sources,'a'));assert.deepEqual(opened,['b']);
  follow.beginTurn();follow.finish(view('Read the abstract',[], 'a'));assert.deepEqual(opened,['b','a']);
  follow.beginTurn();follow.finish(view('No evidence',[],null));assert.deepEqual(opened,['b','a']);
  const oldMemory=view('Hello',[],'b');oldMemory.memory.object_source_turn='old-turn';follow.finish(oldMemory);assert.deepEqual(opened,['b','a']);
});
