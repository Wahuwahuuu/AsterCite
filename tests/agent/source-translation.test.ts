import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,mkdir,readFile,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../agent/config.ts";
import { SourceTranslation } from "../../agent/source-translation.ts";

test("Chinese source translations use one bounded request, cache results and omit hidden reasoning and credentials",async()=>{
  let calls=0,fail=false;const key="fixture-translation-key-in-memory",root=await mkdtemp(join(tmpdir(),"astercite-translation-")),directory=join(root,"session");await mkdir(directory);
  const server=createServer(async(req,res)=>{calls++;assert.equal(req.headers.authorization,"Bearer "+key);let body="";for await(const part of req)body+=part;
    if(fail){res.writeHead(503);res.end("private upstream body");return;}
    const request=JSON.parse(body),content=request.messages.at(-1).content,sources=JSON.parse(typeof content==="string"?content:content.map((part:{text:string})=>part.text).join("\n")).excerpts;
    const text=JSON.stringify({translations:sources.map((source:{chunk_id:string})=>({chunk_id:source.chunk_id,text:"这是忠实的中文译文。"}))});
    res.writeHead(200,{"Content-Type":"text/event-stream"});res.end('data: '+JSON.stringify({id:"translation",choices:[{index:0,delta:{role:"assistant",reasoning_content:"HIDDEN_TRANSLATION_THINKING",content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:"translation",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}})+'\n\ndata: [DONE]\n\n');
  });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address&&typeof address==="object");
  const raw=JSON.parse(await readFile("configs/model.example.json","utf8"));raw.model.base_url=`http://127.0.0.1:${address.port}/v1`;raw.model.model_id="translation-fixture";raw.model.reasoning=false;raw.model.thinking_level="off";
  const translator=new SourceTranslation(root,parseConfig(raw),key),sources=[{chunk_id:"source-one",text:"The original states one fact."},{chunk_id:"source-two",text:"The original states another fact."}];
  try{
    const first=await translator.translate(sources,directory,"turn-one");assert.equal(calls,1);assert.equal(first.items.length,2);assert.equal(first.cached,false);assert.ok(first.request?.input);assert.ok(!JSON.stringify(first).includes("HIDDEN"));assert.ok(!JSON.stringify(first).includes(key));
    const cached=await translator.translate(sources,directory,"turn-two");assert.equal(calls,1);assert.equal(cached.cached,true);assert.equal(cached.request?.id,first.request?.id);
    fail=true;await assert.rejects(translator.translate([{chunk_id:"new-source",text:"New excerpt."}],directory,"turn-three"));assert.equal(calls,2);
    const budget=JSON.parse(await readFile(join(directory,"reading-budget.json"),"utf8"));assert.equal(budget.total,2);assert.equal(budget.turns["turn-three"],1);
    for(const file of await readdir(join(root,".cache/translations"))){const saved=await readFile(join(root,".cache/translations",file),"utf8");assert.ok(!saved.includes(key));assert.ok(!saved.includes("HIDDEN"));}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
