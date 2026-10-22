import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { desktopConfig, saveDesktopConfig } from "../../desktop/configuration.ts";

const input={base_url:"https://model.example.com/v1",model_id:"user-model",context_window:32768,max_output_tokens:4096,protocol:"openai",thinking_level:"off"};
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"astercite-desktop-"));
  await mkdir(join(root,"configs"));await mkdir(join(root,"desktop/resources"),{recursive:true});
  await writeFile(join(root,"configs/model.example.json"),await readFile(new URL("../../configs/model.example.json",import.meta.url)));
  await writeFile(join(root,"desktop/resources/manifest.json"),JSON.stringify({index_dir:"artifacts/bundled-cpu/pipaper-full-index-v1-0123456789abcdef"}));
  return {root,async close(){await rm(root,{recursive:true,force:true});}};
}
test("desktop config uses bundled CPU hybrid retrieval and keeps user capacity settings",async()=>{
  const f=await fixture();try{
    const c=await saveDesktopConfig(f.root,input);
    assert.equal(c.retrieval.device,"cpu");assert.equal(c.retrieval.profile,"rrf_rerank");
    assert.match(c.retrieval.index_dir,/^artifacts\/bundled-cpu\//);
    assert.equal(c.model.base_url,input.base_url);assert.equal(c.session.max_turns,100);
    const stored=JSON.parse(await readFile(join(f.root,"configs/model.local.json"),"utf8"));assert.deepEqual(stored,c);
    const zai=await desktopConfig(f.root,{...input,protocol:"zai",thinking_level:"low"});
    assert.equal(zai.model.compat.zaiToolStream,true);assert.equal(zai.model.compat.thinkingFormat,"zai");assert.equal(zai.model.thinking_level,"low");
    await assert.rejects(desktopConfig(f.root,{...input,protocol:"zai",model_id:"glm-5.3-flash",thinking_level:"off"}));
  }finally{await f.close();}
});
test("invalid model settings and credentials cannot replace a saved config",async()=>{
  const f=await fixture();const previous=process.env.PIPAPER_API_KEY;try{
    await saveDesktopConfig(f.root,input);const before=await readFile(join(f.root,"configs/model.local.json"),"utf8");
    process.env.PIPAPER_API_KEY="test-only-private-value";
    for(const bad of [{...input,api_key:"test-only-private-value"},{...input,base_url:"http://external.example.com/v1"},
      {...input,base_url:"https://model.example.com/v1?credential=private"},{...input,context_window:2000},
      {...input,max_output_tokens:32768},{...input,model_id:"test-only-private-value"},{...input,protocol:"arbitrary"}]){
      await assert.rejects(saveDesktopConfig(f.root,bad));assert.equal(await readFile(join(f.root,"configs/model.local.json"),"utf8"),before);
    }
    await writeFile(join(f.root,"desktop/resources/manifest.json"),JSON.stringify({index_dir:"../private"}));
    await assert.rejects(desktopConfig(f.root,input));
  }finally{if(previous===undefined)delete process.env.PIPAPER_API_KEY;else process.env.PIPAPER_API_KEY=previous;await f.close();}
});
