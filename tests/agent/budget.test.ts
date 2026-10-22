import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionBudget } from "../../agent/budget.ts";
const identity="a".repeat(64);
test("failed/reserved turns are charged; persisted attempts stay capped at 12 after reopening",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-budget-"));let b:SessionBudget|undefined;
  try{
    b=await SessionBudget.open(root,identity,2);await b.reserve("first","question");
    for(let i=0;i<12;i++)await b.admit("first","req-"+i);
    await assert.rejects(b.admit("first","req-13"),/admission/);await b.close();b=undefined;
    b=await SessionBudget.open(root,identity,2);assert.equal(b.summary().model_attempts,12);
    await b.reserve("second","different");await b.finish("second","b".repeat(64));
    await assert.rejects(b.reserve("third","no"),/exhausted/);assert.equal(b.summary().remaining_turns,0);
  }finally{await b?.close();await rm(root,{recursive:true,force:true});}
});
test("exclusive session lock, configuration binding and ledger tampering prevent provider admission",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-lock-"));let b:SessionBudget|undefined;
  try{
    b=await SessionBudget.open(root,identity,4);await assert.rejects(SessionBudget.open(root,identity,4),/Session is open/);
    await b.reserve("t1","question");await b.admit("t1","r1");await b.close();b=undefined;
    await assert.rejects(SessionBudget.open(root,"c".repeat(64),4),/identity/);
    const files=(await readdir(join(root,"ledger"))).sort(),path=join(root,"ledger",files.at(-1)!);const v=JSON.parse(await readFile(path,"utf8"));
    v.previous_sha256="wrong";await writeFile(path,JSON.stringify(v));
    await assert.rejects(SessionBudget.open(root,identity,4),/chain/);
  }finally{await b?.close();await rm(root,{recursive:true,force:true});}
});
test("scope and scheduled compaction persist between ordinary CLI opens",async()=>{
  const root=await mkdtemp(join(tmpdir(),"astercite-controls-"));let b:SessionBudget|undefined;
  try{b=await SessionBudget.open(root,identity,2);await b.setScope(["paper1"]);await b.compact(true);await b.close();b=undefined;
    b=await SessionBudget.open(root,identity,2);assert.deepEqual(b.state.scope,["paper1"]);assert.equal(b.state.pending_compaction,true);}
  finally{await b?.close();await rm(root,{recursive:true,force:true});}
});
