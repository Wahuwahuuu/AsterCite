import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fauxAssistantMessage as reply } from "@earendil-works/pi-ai";
import { parseConfig, containedPath, createUserRuntime, sha } from "../../agent/config.ts";
import { parseArgs, visibleTurn } from "../../agent/cli.ts";
import { MainPaperHarness } from "../../agent/session-main-v2.ts";
import { mainFixture, preparation, final, PREPARED_INDEX } from "./main-fixture.ts";

async function config(){
  const v=JSON.parse(await readFile("configs/model.example.json","utf8"));
  v.model.base_url="https://example.invalid/v1";v.model.model_id="fixture";return v;
}
test("public template requires user model; keys, headers, URL credentials and invalid thinking are rejected",async()=>{
  const raw=JSON.parse(await readFile("configs/model.example.json","utf8"));assert.throws(()=>parseConfig(raw),/Fill model/);
  const v=await config();assert.equal(parseConfig(v).model.model_id,"fixture");
  for(const bad of [{...v,api_key:"fixture-secret"},{...v,model:{...v.model,apiKey:"fixture-secret"}},{...v,model:{...v.model,headers:{Authorization:"x"}}},
    {...v,model:{...v.model,base_url:"https://user:pass@example.invalid"}},{...v,model:{...v.model,base_url:"https://example.invalid?key=x"}},
    {...v,model:{...v.model,base_url:"http://remote.example.invalid"}},{...v,model:{...v.model,thinking_level:"low"}},{...v,version:2}])
    assert.throws(()=>parseConfig(bad));
});
test("CLI accepts arbitrary questions and rejects path-like session names",()=>{
  assert.equal(parseArgs(["--ask","This is a new question, not a frozen plan row"]).ask,"This is a new question, not a frozen plan row");
  for(const name of ["../outside","a/b","a\\b","",":drive"])assert.throws(()=>parseArgs(["--session",name]));
  assert.throws(()=>parseArgs(["--unknown"]));assert.equal(parseArgs(["--help"]).help,true);
});
test("model resource paths reject traversal and external symlink",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-path-")),outside=await mkdtemp(join(tmpdir(),"astercite-other-"));
  try{await mkdir(join(root,"inside"));assert.equal(await containedPath(root,"inside/missing"),join(root,"inside/missing"));
    await assert.rejects(containedPath(root,"../outside"));await symlink(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
    await assert.rejects(containedPath(root,"linked/weights"),/Linked path/);
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test("generic OpenAI compatible provider sends configured low on auxiliary and final, only two paper tools, no network catalog",async()=>{
  const bodies:Record<string,unknown>[]=[];const auth:string[]=[];
  const server=createServer(async(req,res)=>{
    let data="";for await(const chunk of req)data+=chunk;const body=JSON.parse(data);bodies.push(body);auth.push(req.headers.authorization??"");
    const response=bodies.length===1?preparation:final;
    res.writeHead(200,{"Content-Type":"text/event-stream"});
    const chunk={id:"fixture-response",object:"chat.completion.chunk",created:0,model:"fixture",choices:[{index:0,delta:{role:"assistant",content:JSON.stringify(response)},finish_reason:null}]};
    res.write("data: "+JSON.stringify(chunk)+"\n\n");
    res.write("data: "+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+"\n\n");
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address();assert.ok(address && typeof address==="object");
  const v=await config();v.model={...v.model,base_url:"http://127.0.0.1:"+address.port+"/v1",reasoning:true,thinking_level:"low",compat:{...v.model.compat,supportsReasoningEffort:true}};
  const cfg=parseConfig(v),key="fixture-memory-only-key";
  const runtime=await createUserRuntime(cfg.model,key),f=await mainFixture([]);
  const harness=await MainPaperHarness.create({cwd:process.cwd(),worker:{async request(){return {backend:"rrf_rerank",index_version:PREPARED_INDEX,chunks:[f.chunks[0]]};}},
    knownPaperIds:new Set(["p1"]),modelRuntime:runtime.runtime,model:runtime.model,secrets:[key],thinkingLevel:"low",questionPreparation:"light-v1",
    controls:{arm:"C",reflect:false,compaction:"off",reliability:"candidate",implementation_id:"7".repeat(64)},
    p2:{profile:"B",executionVersion:"full-v1",answerContract:"full-v1-json",indexVersion:PREPARED_INDEX,evidenceIndex:new Map(f.chunks.map(c=>[c.chunk_id,{...c,text_sha256:sha(c.text),index_version:PREPARED_INDEX}])),
      publicPapers:[{paper_id:"p1",title:"Paper One",abstract:"catalog"}],reflect:false,nlu:true,structuredMemory:true}});
  try{
    assert.deepEqual(harness.session.getCallableToolNames().sort(),["retrieve_chunks","search_papers"]);
    const result=await harness.runTurn("p1 requested fact",["p1"],"local-provider-contract");
    assert.equal(result.status,"completed",result.error??"");assert.equal(bodies.length,2);
    assert.ok(bodies.every(b=>b.reasoning_effort==="low" && b.model==="fixture"));
    assert.ok(auth.every(h=>h==="Bearer "+key));
    assert.deepEqual(harness.session.getAllTools().map(t=>t.name).sort(),["retrieve_chunks","search_papers"]);
    const visible=JSON.stringify(visibleTurn(result));assert.ok(!visible.includes(key));assert.ok(!visible.includes("internal_drafts"));
  }finally{harness.dispose();f.harness.dispose();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
