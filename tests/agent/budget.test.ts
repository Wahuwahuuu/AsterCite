import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionBudget } from "../../agent/budget.ts";
const identity="a".repeat(64);
test('paper-count allowance is fixed at reservation and survives recovery without refunding attempts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-dynamic-budget-'));let budget:SessionBudget|undefined;
  try{budget=await SessionBudget.openWeb(root,3);await budget.reserve('five-papers','comparison',27);
    for(let i=0;i<14;i++)await budget.admit('five-papers','request-'+i);await budget.close();budget=undefined;
    budget=await SessionBudget.openWeb(root,3);assert.equal(budget.summary().request_limit_per_turn,27);assert.equal(budget.summary().model_attempts,14);
    for(let i=14;i<27;i++)await budget.admit('five-papers','request-'+i);await assert.rejects(budget.admit('five-papers','extra'),/admission/);
    await assert.rejects(budget.reserve('invalid','question',65),/limit/);
    await budget.reserve('ordinary','question');for(let i=0;i<12;i++)await budget.admit('ordinary','ordinary-'+i);await assert.rejects(budget.admit('ordinary','extra'),/admission/);
  }finally{await budget?.close();await rm(root,{recursive:true,force:true});}
});
test('a later ledger generation cannot raise an already reserved allowance',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-immutable-budget-'));let budget:SessionBudget|undefined;
  try{budget=await SessionBudget.openWeb(root,3);await budget.reserve('five-papers','comparison',27);
    budget.state.turns[0].request_limit=30;await budget.setScope(['p1']);await budget.close();budget=undefined;
    await assert.rejects(SessionBudget.openWeb(root,3),/cannot change/);
  }finally{await budget?.close();await rm(root,{recursive:true,force:true});}
});
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
test('web recovery keeps a legacy ledger identity, its original limit, and every admitted request after an update',async()=>{
  const root=await mkdtemp(join(tmpdir(),'astercite-web-budget-'));let b:SessionBudget|undefined;
  try{
    b=await SessionBudget.open(root,identity,4);await b.reserve('failed','old question');for(let i=0;i<12;i++)await b.admit('failed','request-'+i);await b.close();b=undefined;
    const before=await readdir(join(root,'ledger'));
    b=await SessionBudget.openWeb(root,100);assert.equal(b.state.implementation_id,identity);assert.equal(b.summary().max_turns,4);assert.equal(b.summary().model_attempts,12);
    assert.deepEqual(await readdir(join(root,'ledger')),before);await assert.rejects(b.admit('failed','extra'),/admission/);
    await b.reserve('next','new question');await b.admit('next','new-request');await b.close();b=undefined;
    b=await SessionBudget.openWeb(root,1);assert.equal(b.summary().turns_reserved,2);assert.equal(b.summary().remaining_turns,2);assert.equal(b.summary().model_attempts,13);await b.close();b=undefined;
    await assert.rejects(SessionBudget.open(root,'c'.repeat(64),4),/identity/);
    const files=(await readdir(join(root,'ledger'))).sort(),path=join(root,'ledger',files.at(-1)!);const value=JSON.parse(await readFile(path,'utf8'));value.previous_sha256='broken';await writeFile(path,JSON.stringify(value));
    await assert.rejects(SessionBudget.openWeb(root,100),/chain/);
  }finally{await b?.close();await rm(root,{recursive:true,force:true});}
});
