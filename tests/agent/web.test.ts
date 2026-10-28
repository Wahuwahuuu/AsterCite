import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { createWebServer, parseWebArgs, type WebServerOptions } from "../../agent/web-server.ts";
import { PaperWebSession, type WebSessionPort, type WebView, type WebActivity } from "../../agent/web-session.ts";
import { parseConfig, sha } from "../../agent/config.ts";
import { RuntimeFailure } from "../../agent/contracts.ts";
import {SessionBudget} from '../../agent/budget.ts';
import {randomUUID} from 'node:crypto';
import type { Assets } from "../../agent/assets.ts";
import { mainFixture, preparation, final, PREPARED_INDEX } from "./main-fixture.ts";

const empty:WebView={turns:[],scope:[],pending_compaction:false,budget:{turns_reserved:0,max_turns:20,model_attempts:0,request_limit_per_turn:12,remaining_turns:20},memory:{paper_id:null,comparison:[],dimensions:[],preferences:[]}};
async function fixture(extra:Partial<WebServerOptions>={}){
  const root=await mkdtemp(join(tmpdir(),"astercite-web-"));await mkdir(join(root,"web"));await writeFile(join(root,"web/index.html"),"<html>AsterCite</html>");
  let calls=0;
  const factory=async():Promise<WebSessionPort>=>({async view(){return structuredClone(empty);},async ask(question){calls++;return {...structuredClone(empty),turns:[{question,answer:"Answer",sources:[],status:"completed",elapsed_ms:1,requests:1,tokens:null,stages:[]}]};},async configure(){return structuredClone(empty);},async close(){}});
  const server=await createWebServer({root,mode:"live",factory,...extra});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address==="object");
  const origin="http://127.0.0.1:"+address.port;
  const post=(path:string,v:unknown,headers:Record<string,string>={})=>fetch(origin+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-AsterCite-Request":"1",...headers},body:JSON.stringify(v)});
  const remove=(path:string,headers:Record<string,string>={})=>fetch(origin+path,{method:"DELETE",headers:{Origin:origin,"X-AsterCite-Request":"1",...headers}});
  return {root,server,origin,post,remove,calls:()=>calls,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}};
}

test('stop is authenticated and bound to the active request; stream saves progress and stale stops cannot cancel the next turn',async()=>{
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});let aborted=false;
  const f=await fixture({factory:async()=>({async view(){return structuredClone(empty);},async configure(){return structuredClone(empty);},async close(){},async ask(question,_progress,_answer,options){
    if(question==='first'){options?.onTasks?.({version:1,phase:'running',items:[]});started();await new Promise<void>(resolve=>{if(options?.signal?.aborted){aborted=true;resolve();}else options?.signal?.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});});}
    return {...structuredClone(empty),turns:[{question,answer:'保留回答',sources:[],status:question==='first'?'aborted':'completed',stopped:question==='first',elapsed_ms:1,requests:1,tokens:null,stages:[],tasks:{version:1,phase:question==='first'?'stopped':'completed',items:[]}}]};
  }})});
  try{
    const owner=await (await f.post('/api/sessions',{})).json(),path='/api/sessions/'+owner.id,headers={'X-AsterCite-Session':owner.token},id=randomUUID();
    const stream=await f.post(path+'/question/stream',{question:'first',request_id:id},headers);await ready;
    assert.equal((await f.post(path+'/stop',{request_id:id})).status,403);
    assert.equal((await (await f.post(path+'/stop',{request_id:randomUUID()},headers)).json()).stopped,false);assert.equal(aborted,false);
    assert.equal((await (await f.post(path+'/stop',{request_id:id},headers)).json()).stopped,true);
    const payload=await stream.text();assert.match(payload,/task_progress/);assert.match(payload,/"phase":"stopped"/);assert.equal(aborted,true);
    assert.equal((await (await f.post(path+'/stop',{request_id:id},headers)).json()).stopped,false);
    const next=await f.post(path+'/question',{question:'second',request_id:randomUUID()},headers);assert.equal(next.status,200);assert.equal((await next.json()).turns[0].status,'completed');
  }finally{await f.close();}
});
test('a stop sent before the question reaches the adapter cancels only its matching request',async()=>{
  let sawAbort=false;const f=await fixture({factory:async()=>({async view(){return structuredClone(empty);},async configure(){return structuredClone(empty);},async close(){},async ask(_question,_progress,_answer,options){sawAbort=Boolean(options?.signal?.aborted);return structuredClone(empty);}})});
  try{const owner=await (await f.post('/api/sessions',{})).json(),path='/api/sessions/'+owner.id,headers={'X-AsterCite-Session':owner.token},id=randomUUID();assert.equal((await f.post(path+'/stop',{request_id:id},headers)).status,200);assert.equal((await f.post(path+'/question',{question:'cancel early',request_id:id},headers)).status,200);assert.equal(sawAbort,true);}finally{await f.close();}
});

test("deleting an owned conversation removes its private files without opening an incompatible session",async()=>{
  let opened=0;
  const f=await fixture({factory:async()=>{opened++;throw new RuntimeFailure('INVALID_BUDGET','Old session');}});
  try{
    const a=await (await f.post('/api/sessions',{})).json(),b=await (await f.post('/api/sessions',{})).json();
    const path='/api/sessions/'+a.id,directory=join(f.root,'.local/web/sessions',a.id),own={'X-AsterCite-Session':a.token};
    for(const sub of ['turns','checkpoints','traces','translations','ledger']){await mkdir(join(directory,sub));await writeFile(join(directory,sub,'record.json'),'private conversation');}
    await mkdir(join(f.root,'.cache/papers'),{recursive:true});await writeFile(join(f.root,'.cache/papers/shared.pdf'),'shared paper');
    assert.equal((await f.remove(path)).status,403);
    assert.equal((await f.remove(path,{'X-AsterCite-Session':b.token})).status,403);
    assert.equal((await f.remove(path,{...own,Origin:'https://different.invalid'})).status,403);
    assert.equal((await f.remove(path,{...own,'X-AsterCite-Request':''})).status,403);
    assert.equal((await f.remove('/api/sessions/%2e%2e%2f'+a.id,own)).status,404);
    assert.equal((await readdir(directory)).length,6);
    const deleted=await f.remove(path,own);assert.equal(deleted.status,200);assert.deepEqual(await deleted.json(),{deleted:true,id:a.id});
    await assert.rejects(readFile(join(directory,'owner.json')),{code:'ENOENT'});
    assert.equal((await readFile(join(f.root,'.cache/papers/shared.pdf'),'utf8')),'shared paper');
    assert.ok(await readFile(join(f.root,'.local/web/sessions',b.id,'owner.json')));assert.equal(opened,0);
    assert.equal((await f.remove(path,own)).status,404);
  }finally{await f.close();}
});

test("conversation deletion rejects a junction to another session and preserves shared data behind nested links",async()=>{
  const f=await fixture();
  try{
    const a=await (await f.post('/api/sessions',{})).json(),b=await (await f.post('/api/sessions',{})).json();
    const base=join(f.root,'.local/web/sessions'),directory=join(base,a.id),other=join(base,b.id),path='/api/sessions/'+a.id;
    // These are freshly-created synthetic sessions in this test's temporary root.
    assert.equal(directory,join(f.root,'.local','web','sessions',a.id));await rm(directory,{recursive:true});
    await symlink(other,directory,'junction');
    assert.equal((await f.remove(path,{'X-AsterCite-Session':b.token})).status,403);assert.ok(await readFile(join(other,'owner.json')));
    await rm(directory);await mkdir(directory);await writeFile(join(directory,'owner.json'),await readFile(join(other,'owner.json')));
    await symlink(other,join(directory,'linked-cache'),'junction');
    assert.equal((await f.remove(path,{'X-AsterCite-Session':b.token})).status,200);assert.ok(await readFile(join(other,'owner.json')));
  }finally{await f.close();}
});

test("conversation deletion waits for a source translation to finish",async()=>{
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const f=await fixture({translate:async()=>{started();await gate;return {cached:false,items:[{chunk_id:'source-one',text:'译文'}]};}});
  try{
    const owner=await (await f.post('/api/sessions',{})).json(),path='/api/sessions/'+owner.id,headers={'X-AsterCite-Session':owner.token};
    const turn='11111111-1111-4111-8111-111111111111',directory=join(f.root,'.local/web/sessions',owner.id);
    await mkdir(join(directory,'turns'));await writeFile(join(directory,'turns',turn+'.json'),JSON.stringify({web_turn:{sources:[{chunk_id:'source-one',text:'Original source.'}]}}));
    const pending=f.post(path+'/translate',{turn_id:turn,chunk_ids:['source-one']},headers);await ready;
    assert.equal((await f.remove(path,headers)).status,409);assert.ok(await readFile(join(directory,'owner.json')));
    release();assert.equal((await pending).status,200);assert.equal((await f.remove(path,headers)).status,200);
  }finally{release();await f.close();}
});
test("website defaults to demo on loopback and validates launch arguments",()=>{
  assert.deepEqual(parseWebArgs([]),{live:false,host:"127.0.0.1",port:4173,config:"configs/model.local.json",help:false});
  assert.equal(parseWebArgs(["--live","--port","4500"]).live,true);
  for(const args of [["--port","NaN"],["--port","0"],["--host","example.com"],["--unknown"],["--config"]])assert.throws(()=>parseWebArgs(args));
});

test("question stream delivers actual activities before the answer and retains owner/origin/concurrency gates",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
  const f=await fixture({factory:async()=>({async view(){return structuredClone(empty);},async configure(){return structuredClone(empty);},async close(){},async ask(question,onProgress){
    calls++;onProgress?.({id:"tool-1",kind:"tool",tool:"retrieve_chunks",status:"running",label:"检索原文",detail:"test query",elapsed_ms:1});
    await gate;onProgress?.({id:"tool-1",kind:"tool",tool:"retrieve_chunks",status:"completed",label:"检索原文",detail:"返回 1 段原文",elapsed_ms:2});
    return {...structuredClone(empty),turns:[{question,answer:"finished",sources:[],status:"completed",elapsed_ms:2,requests:1,tokens:null,stages:[]}]};
  }})});
  try{
    const owner=await (await f.post("/api/sessions",{})).json(),path="/api/sessions/"+owner.id+"/question/stream",headers={"X-AsterCite-Session":owner.token};
    assert.equal((await f.post(path,{question:"fact"})).status,403);
    assert.equal((await f.post(path,{question:"fact"},{...headers,Origin:"https://different.invalid"})).status,403);
    const response=await f.post(path,{question:"fact"},headers);assert.match(response.headers.get("content-type")??"",/x-ndjson/);
    const reader=response.body!.getReader(),first=await reader.read();const beginning=new TextDecoder().decode(first.value);assert.match(beginning,/activity/);assert.ok(!beginning.includes('"result"'));
    assert.equal((await f.post(path,{question:"second"},headers)).status,409);assert.equal(calls,1);
    assert.equal((await f.remove('/api/sessions/'+owner.id,headers)).status,409);
    release();let text=beginning;while(true){const item=await reader.read();if(item.done)break;text+=new TextDecoder().decode(item.value);}
    const lines=text.trim().split("\n").map(line=>JSON.parse(line));assert.equal(lines.at(-1).type,"result");assert.equal(lines.at(-1).view.turns[0].answer,"finished");assert.equal(lines.filter(l=>l.type==="activity").length,2);
  }finally{release();await f.close();}
});

test("PDF HTTP route is restricted to catalog papers and the website access token",async()=>{
  const bytes=Buffer.from("%PDF-1.4\noriginal\n%%EOF"),f=await fixture({papers:[{paper_id:"1611.09441",title:"Twitter",abstract:""}],accessToken:"owner-website-token",pdfFetch:(async()=>new Response(bytes)) as typeof fetch});
  try{
    assert.equal((await fetch(f.origin+"/api/papers/1611.09441/pdf")).status,401);
    const headers={Authorization:"Bearer owner-website-token"};assert.equal((await fetch(f.origin+"/api/papers/1705.02394/pdf",{headers})).status,404);
    const pdf=await fetch(f.origin+"/api/papers/1611.09441/pdf",{headers});assert.equal(pdf.status,200);assert.equal(pdf.headers.get("content-type"),"application/pdf");assert.deepEqual(Buffer.from(await pdf.arrayBuffer()),bytes);
    assert.ok(!(await (await fetch(f.origin+"/api/config")).text()).includes("owner-website-token"));
  }finally{await f.close();}
});

test("request details and Chinese translations belong to the owning session and cited source",async()=>{
  let translations=0;
  const f=await fixture({translate:async(sources)=>{translations++;assert.deepEqual(sources,[{chunk_id:"source-one",text:"Original source."}]);return {cached:false,items:[{chunk_id:"source-one",text:"原始依据。"}]};}});
  try{
    const a=await (await f.post("/api/sessions",{})).json(),b=await (await f.post("/api/sessions",{})).json();
    const turn="11111111-1111-4111-8111-111111111111",event="22222222-2222-4222-8222-222222222222",directory=join(f.root,".local/web/sessions",a.id);
    await mkdir(join(directory,"turns"));await mkdir(join(directory,"traces"));
    const bytes=JSON.stringify([{id:event,kind:"model",status:"completed",phase:"agent",stage:"generate",turn_id:turn,cycle:1,elapsed_ms:2,input:{format:"provider_payload",messages:[{role:"user",text:"user question"}],tools:[],settings:{}},output:{text:"visible answer",tool_calls:[]}}])+"\n";
    await writeFile(join(directory,"traces",turn+".json"),bytes);await writeFile(join(directory,"turns",turn+".json"),JSON.stringify({trace_sha256:sha(bytes),web_turn:{sources:[{chunk_id:"source-one",text:"Original source."}]}}));
    const detailPath=`/api/sessions/${a.id}/traces/${turn}/${event}`,own={"X-AsterCite-Session":a.token};
    assert.equal((await fetch(f.origin+detailPath)).status,403);assert.equal((await fetch(f.origin+detailPath,{headers:{"X-AsterCite-Session":b.token}})).status,403);
    const detail=await fetch(f.origin+detailPath,{headers:own});assert.equal(detail.status,200);assert.equal((await detail.json()).detail.input.messages[0].text,"user question");
    const path=`/api/sessions/${a.id}/translate`,request={turn_id:turn,chunk_ids:["source-one"]};
    assert.equal((await f.post(path,request,{"X-AsterCite-Session":b.token})).status,403);
    assert.equal((await f.post(path,request,{...own,Origin:"https://different.invalid"})).status,403);
    assert.equal((await f.post(path,{...request,text:"arbitrary prompt"},own)).status,400);
    assert.equal((await f.post(path,{turn_id:turn,chunk_ids:["not-cited"]},own)).status,400);assert.equal(translations,0);
    const translated=await f.post(path,request,own);assert.equal(translated.status,200);assert.equal((await translated.json()).items[0].text,"原始依据。");assert.equal(translations,1);
  }finally{await f.close();}
});
test("HTTP isolates browser sessions, requires same-origin changes, rejects credentials and private paths",async()=>{
  const f=await fixture();
  try{
    const a=await (await f.post("/api/sessions",{})).json() as {id:string;token:string};
    const b=await (await f.post("/api/sessions",{})).json() as {id:string;token:string};
    const path="/api/sessions/"+a.id;
    assert.equal((await fetch(f.origin+path)).status,403);
    assert.equal((await fetch(f.origin+path,{headers:{"X-AsterCite-Session":b.token}})).status,403);
    assert.equal((await f.post(path+"/question",{question:"new fact"},{"X-AsterCite-Session":a.token,Origin:"https://unrelated.invalid"})).status,403);
    assert.equal((await f.post(path+"/question",{question:"new fact",api_key:"never-save-this"},{"X-AsterCite-Session":a.token})).status,400);
    assert.equal((await f.post(path+"/question",{question:""},{"X-AsterCite-Session":a.token})).status,400);
    assert.equal((await f.post(path+"/question",{question:"😀".repeat(12001)},{"X-AsterCite-Session":a.token})).status,400);
    assert.equal(f.calls(),0);
    const answer=await f.post(path+"/question",{question:"an arbitrary new question"},{"X-AsterCite-Session":a.token});
    assert.equal(answer.status,200);assert.equal((await answer.json()).turns[0].question,"an arbitrary new question");assert.equal(f.calls(),1);
    assert.equal((await fetch(f.origin+"/agent/web-server.ts")).status,404);
    assert.equal((await fetch(f.origin+path+"/checkpoints")).status,404);
    const page=await fetch(f.origin);assert.equal(page.status,200);assert.match(page.headers.get("content-security-policy")??"",/script-src 'self'/);
    const owner=await readFile(join(f.root,".local/web/sessions",a.id,"owner.json"),"utf8");assert.ok(!owner.includes(a.token));
  }finally{await f.close();}
});
test("public access gate, demo mode, admission cap and generic errors never expose secrets",async()=>{
  const token="test-website-token-only-".repeat(2),f=await fixture({accessToken:token,maxSessions:1});
  try{
    assert.equal((await f.post("/api/sessions",{})).status,401);
    const allowed={Authorization:"Bearer "+token};assert.equal((await f.post("/api/sessions",{},allowed)).status,201);
    assert.equal((await f.post("/api/sessions",{},allowed)).status,429);
    assert.ok(!(await (await fetch(f.origin+"/api/config")).text()).includes(token));
  }finally{await f.close();}
  const demo=await fixture({mode:"demo"});try{assert.equal((await demo.post("/api/sessions",{})).status,409);assert.equal(demo.calls(),0);}finally{await demo.close();}
  const failed=await fixture({factory:async()=>{throw new Error("private-provider-key-and-hidden-draft");}});
  try{const owner=await (await failed.post("/api/sessions",{})).json();const res=await failed.post("/api/sessions/"+owner.id+"/question",{question:"fact"},{"X-AsterCite-Session":owner.token});
    assert.equal(res.status,502);assert.ok(!(await res.text()).includes("private-provider"));
  }finally{await failed.close();}
});
test("concurrent questions are rejected before invoking another model session",async()=>{
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>{started=r;}),gate=new Promise<void>(r=>{release=r;});let calls=0;
  const f=await fixture({factory:async()=>({async view(){return empty;},async ask(){calls++;started();await gate;return empty;},async configure(){return empty;},async close(){}})});
  try{
    const owner=await (await f.post("/api/sessions",{})).json(),path="/api/sessions/"+owner.id+"/question",headers={"X-AsterCite-Session":owner.token};
    const first=f.post(path,{question:"one"},headers);await ready;
    assert.equal((await f.post(path,{question:"two"},headers)).status,409);assert.equal(calls,1);release();assert.equal((await first).status,200);
  }finally{release();await f.close();}
});
test("website adapter runs the existing Harness, saves citations and restores memory and budget",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-web-session-")),seed=await mainFixture([]);
  const raw=JSON.parse(await readFile("configs/model.example.json","utf8"));raw.model.base_url="https://example.invalid/v1";raw.model.model_id="fixture";raw.session.compaction="off";
  const config=parseConfig(raw),assets:Assets={root,indexVersion:PREPARED_INDEX,publicPapers:[{paper_id:"p1",title:"Paper One",abstract:"catalog"}],
    evidenceIndex:new Map(seed.chunks.map(c=>[c.chunk_id,{...c,index_version:PREPARED_INDEX,text_sha256:sha(c.text)}])),implementationId:"8".repeat(64),commonPrompt:""};
  const sources=new Map(seed.chunks.map(c=>[c.chunk_id,c])),key="fixture-secret-kept-in-memory";
  const options={directory:root,assets,config,worker:{async request(){return {backend:"rrf_rerank",index_version:PREPARED_INDEX,chunks:[seed.chunks[0]]};}},sources,key,
    createHarness:async(params:Parameters<typeof import("../../agent/session-main-v2.ts").MainPaperHarness.create>[0])=>{
      const {modelRuntime,model,...extra}=params;
      return (await mainFixture([reply(JSON.stringify({...preparation,queries:["find "+key]})),reply(JSON.stringify({...final,execution:{state:'complete',remaining_needs:[],needs_sources:true}}))],[[0]],extra)).harness;
    }};
  try{
    const legacy=await SessionBudget.open(root,assets.implementationId,config.session.max_turns);await legacy.close();
    let session=await PaperWebSession.open(options);
    await session.configure(["p1"],false);
    await assert.rejects(session.configure(["not-in-corpus"],false),(e:unknown)=>e instanceof RuntimeFailure&&e.code==="INVALID_SCOPE");
    await assert.rejects(session.configure(["p1"],true),(e:unknown)=>e instanceof RuntimeFailure&&e.code==="INVALID_CONFIG");
    const events:WebActivity[]=[],tasks:unknown[]=[];
    const streamed:string[]=[];const first=await session.ask("p1 requested fact "+key,event=>events.push(event),update=>{assert.ok(update.sources.some(source=>source.chunk_id===seed.chunks[0].chunk_id));streamed.push(update.text);},{onTasks:progress=>tasks.push(progress)});assert.equal(first.turns[0].status,"completed");assert.ok(!JSON.stringify(first).includes(key));assert.equal(streamed.at(-1),first.turns[0].answer);assert.ok(first.turns[0].tasks);assert.ok(tasks.length>1);assert.ok(!JSON.stringify(tasks).includes(key));
    assert.ok(events.some(e=>e.kind==="model"&&e.status==="running"));
    assert.ok(events.some(e=>e.tool==="retrieve_chunks"&&e.status==="completed"&&e.paper_ids?.includes('p1')));
    assert.ok(events.filter(e=>e.status==='running').every(e=>e.paper_ids===undefined));
    assert.equal(events.at(-1)?.kind,"memory");assert.equal(events.at(-1)?.status,"completed");
    assert.ok(!JSON.stringify(events).includes(key));assert.ok(!JSON.stringify(events).includes('"response_text"'));
    assert.ok(events.some(e=>e.tool==="retrieve_chunks"&&e.detail.includes("[REDACTED]")));
    assert.ok(first.turns[0].activity?.every(e=>e.status!=="running"));
    const firstModel=events.find(e=>e.kind==="model")!;
    const detail=await session.detail(first.turns[0].turn_id!,firstModel.id);assert.ok(detail?.input);assert.ok(detail?.output);assert.ok(!JSON.stringify(detail).includes(key));
    assert.equal(first.turns[0].sources[0].text,seed.chunks[0].text);assert.equal(first.budget.model_attempts,2);assert.equal(first.memory.paper_id,"p1");
    assert.equal(first.memory.notes?.[0].source_turn,first.turns[0].turn_id);assert.ok(first.memory.notes?.[0].answer_excerpt.includes('source supports'));assert.equal(first.context?.policy.threshold_percent,70);assert.ok(events.some(event=>event.context?.used_tokens!==null&&event.context?.used_tokens!==undefined));
    await session.close();
    const savedCheckpoint=await readFile(join(root,'checkpoints',first.turns[0].turn_id+'.json'),'utf8'),beforeLedger=await readdir(join(root,'ledger'));
    const nextConfig=structuredClone(config);nextConfig.model.model_id='updated-model';nextConfig.session.max_turns=100;nextConfig.session.compaction='native';
    const upgraded={...options,config:nextConfig,assets:{...assets,implementationId:'e'.repeat(64)}};
    session=await PaperWebSession.open(upgraded);const restored=await session.view();
    assert.equal(restored.turns.length,1);assert.deepEqual(restored.scope,["p1"]);assert.equal(restored.memory.paper_id,"p1");
    assert.deepEqual(restored.memory.notes,first.memory.notes);assert.equal(restored.context?.basis,'estimate');assert.ok(restored.context!.used_tokens!>0);assert.equal(restored.context?.policy.version,'workbench-context-v3');
    assert.deepEqual(restored.turns[0].activity,first.turns[0].activity);
    assert.equal(restored.budget.model_attempts,2);assert.equal(restored.budget.max_turns,first.budget.max_turns);assert.deepEqual(await readdir(join(root,'ledger')),beforeLedger);
    assert.equal(await readFile(join(root,'checkpoints',first.turns[0].turn_id+'.json'),'utf8'),savedCheckpoint);
    const second=await session.ask("And the same fact?");assert.equal(second.turns.length,2);assert.equal(second.budget.turns_reserved,2);assert.equal(second.budget.model_attempts,4);
    await session.close();
    session=await PaperWebSession.open({...upgraded,assets:{...assets,implementationId:'f'.repeat(64)}});assert.equal((await session.view()).budget.model_attempts,4);await session.close();
    for(const name of await readdir(join(root,"turns"))){const text=await readFile(join(root,"turns",name),"utf8");assert.ok(!text.includes(key));assert.ok(!text.includes("internal_drafts"));assert.ok(!text.includes('"original_response"'));}
  }finally{seed.harness.dispose();await rm(root,{recursive:true,force:true});}
});
test("scheduled native compaction survives closing the web adapter and remains within the same turn budget",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-web-compact-")),seed=await mainFixture([]);
  const raw=JSON.parse(await readFile("configs/model.example.json","utf8"));raw.model.base_url="https://example.invalid/v1";raw.model.model_id="fixture";
  const config=parseConfig(raw),assets:Assets={root,indexVersion:PREPARED_INDEX,publicPapers:[{paper_id:"p1",title:"Paper One",abstract:"catalog"}],
    evidenceIndex:new Map(seed.chunks.map(c=>[c.chunk_id,{...c,index_version:PREPARED_INDEX,text_sha256:sha(c.text)}])),implementationId:"9".repeat(64),commonPrompt:""};
  const options={directory:root,assets,config,worker:{async request(){return {backend:"rrf_rerank",index_version:PREPARED_INDEX,chunks:[seed.chunks[0]]};}},
    sources:new Map(seed.chunks.map(c=>[c.chunk_id,c])),key:"fixture-memory-only",
    createHarness:async(params:Parameters<typeof import("../../agent/session-main-v2.ts").MainPaperHarness.create>[0])=>{
      const {modelRuntime,model,...extra}=params;return (await mainFixture([reply(JSON.stringify(preparation)),reply(JSON.stringify({...final,execution:{state:'complete',remaining_needs:[],needs_sources:true}}))],[[0]],extra)).harness;
    }};
  try{
    let session=await PaperWebSession.open(options);assert.equal((await session.ask("p1 fact")).turns[0].status,"completed");
    await session.configure(["p1"],true);await session.close();session=await PaperWebSession.open(options);
    assert.equal((await session.view()).pending_compaction,true);
    const view=await session.ask("And that same fact?");assert.equal(view.turns[1].status,"completed");assert.equal(view.pending_compaction,false);
    assert.equal(view.budget.turns_reserved,2);assert.ok(view.budget.model_attempts<=24);assert.equal(view.memory.paper_id,"p1");await session.close();
    const files=await readdir(join(root,"turns")),rows=await Promise.all(files.map(f=>readFile(join(root,"turns",f),"utf8")));
    assert.ok(rows.map(r=>JSON.parse(r)).some(r=>r.compaction_events.some((e:{type:string;reason:string})=>e.type==="end"&&e.reason==="manual")));
  }finally{seed.harness.dispose();await rm(root,{recursive:true,force:true});}
});
