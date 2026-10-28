#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT, loadAssets, createWorker } from "./assets.ts";
import { readConfig, createUserRuntime, containedPath, sha } from "./config.ts";
import { RuntimeFailure, errorText, redactText } from "./contracts.ts";
import { SessionBudget } from "./budget.ts";
import { MainPaperHarness } from "./session-main-v2.ts";
import type { ControlledSnapshot, ControlledTurnRecord } from "./main-controls.ts";

export const HELP=`AsterCite — 固定论文库的多轮证据问答
npm run paper -- [--config configs/model.local.json] [--session 会话名] [--ask "问题"]
使用 --session 继续同名会话。
/help                帮助
/corpus [关键词]     列出论文
/scope [ID,...|all]   显示/设置本轮及后续轮的论文范围
/trace               上轮阶段、请求与检索记录
/memory              结构化记忆
/compact             在下一轮预算内执行原生压缩
/budget              会话轮数与请求尝试
/quit                保存后退出
安装与模型配置见 docs/environment.md 和 docs/configuration.md。`;
export function parseArgs(args:string[]){
  const out:{config:string;session?:string;ask?:string;help:boolean}={config:"configs/model.local.json",help:false};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==="--help"||key==="-h"){out.help=true;continue;}
    if(!["--config","--session","--ask"].includes(key)||!args[i+1]||args[i+1].startsWith("--"))throw new RuntimeFailure("INVALID_ARGUMENT","Use --help to see supported arguments");
    const value=args[++i];if(key==="--config")out.config=value;else if(key==="--session")out.session=value;else out.ask=value;
  }
  if(out.session && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(out.session))throw new RuntimeFailure("INVALID_ARGUMENT","Session name: 1..80 ASCII letters, digits, underscores or hyphens");
  if(out.ask!==undefined && (!out.ask.trim() || Array.from(out.ask).length>12000))throw new RuntimeFailure("INVALID_INPUT","Question must contain 1..12000 codepoints");
  return out;
}
/** Public action/usage log excludes internal drafts, thinking and provider streams. */
export function visibleTurn(record:ControlledTurnRecord){
  return {version:1,turn_id:record.user_turn_id,status:record.status,answer_policy:record.answer_policy,final_answer:record.final_answer,final_structure:record.final_structure,final_request_id:record.final_request_id,
    answer_adjustments:(record.reliability_adaptations??[]).map(({stage,request_id,kind})=>({stage,request_id,kind})),
    citation_attribution:record.citation_attribution,
    elapsed_ms:record.elapsed_ms,failure_code:record.failure_code,error:record.error,citation_validity:record.citation_validity,
    requests:record.requests.map(r=>({request_id:r.request_id,admitted:r.admitted,phase:r.phase,stage:r.stage,status:r.status,http_attempts:r.http_attempts,
      http_status:r.http_status,elapsed_ms:r.elapsed_ms,usage:r.usage,usage_status:r.usage_status,pricing_status:"unknown",tool_context:r.tool_context})),
    tools:record.tools,stages:record.pipeline_trace?.stages.map(s=>({stage:s.stage,status:s.status,elapsed_ms:s.elapsed_ms})),
    preparation:record.question_preparation.result,compaction_events:record.compaction_events,session_recovery:record.session_recovery,
    runtime_controls:record.runtime_controls,actual_billing:"unknown",server_weights_revision:"unknown"};
}
async function restoreLatest(directory:string,budget:SessionBudget):Promise<ControlledSnapshot|undefined>{
  let latest:ControlledSnapshot|undefined;
  for(const turn of budget.state.turns){
    if(turn.status!=="finished")continue;
    const bytes=await readFile(join(directory,"turns",turn.id+".json"));
    if(sha(bytes)!==turn.result_sha256)throw new RuntimeFailure("INVALID_SESSION","Saved turn hash differs");
    const value=JSON.parse(bytes.toString()),snapshotBytes=await readFile(join(directory,"checkpoints",turn.id+".json"));
    if(sha(snapshotBytes)!==value.snapshot_sha256)throw new RuntimeFailure("INVALID_SESSION","Saved snapshot hash differs");
    latest=JSON.parse(snapshotBytes.toString()) as ControlledSnapshot;
  }
  return latest;
}
export async function runCli(args:string[],root=PROJECT_ROOT):Promise<number>{
  const flags=parseArgs(args);if(flags.help){console.log(HELP);return 0;}
  const config=await readConfig(root,flags.config),key=process.env.PIPAPER_API_KEY ?? "";
  if(!key.trim())throw new RuntimeFailure("MISSING_KEY","请在终端设置 PIPAPER_API_KEY；无需密钥的演示使用 npm run demo");
  const assets=await loadAssets(root,config);
  const name=flags.session ?? "session-"+new Date().toISOString().replace(/[-:.]/gu,"")+"-"+randomUUID().slice(0,8);
  const directory=await containedPath(root,".local/sessions/"+name);
  const budget=await SessionBudget.open(directory,assets.implementationId,config.session.max_turns);
  let harness:MainPaperHarness|undefined,worker:Awaited<ReturnType<typeof createWorker>>|undefined,rl:ReturnType<typeof createInterface>|undefined;
  let activeTurn="";
  try{
    const snapshot=await restoreLatest(directory,budget);
    const {runtime,model}=await createUserRuntime(config.model,key);
    worker=await createWorker(assets,config);
    harness=await MainPaperHarness.create({cwd:root,modelRuntime:runtime,model,worker,knownPaperIds:new Set(assets.publicPapers.map(p=>p.paper_id)),
      secrets:[key],thinkingLevel:config.model.thinking_level,questionPreparation:"light-v1",answerPolicy:'workbench-v1',
      controls:{arm:"C",reflect:false,compaction:config.session.compaction,reliability:"candidate",implementation_id:assets.implementationId},
      p2:{profile:"B",executionVersion:"full-v1",indexVersion:assets.indexVersion,evidenceIndex:assets.evidenceIndex,publicPapers:assets.publicPapers,
        commonPrompt:assets.commonPrompt,nlu:true,reflect:false,structuredMemory:true,answerContract:"full-v1-json",
        stageOutputLimits:{question_frame:config.model.max_output_tokens,evidence_check:config.model.max_output_tokens,generation:config.model.max_output_tokens}},
      controlledSnapshot:snapshot,maxRequests:12,requestTimeoutMs:config.session.request_timeout_ms,turnTimeoutMs:config.session.turn_timeout_ms,
      authorizeRequest:async r=>{await budget.admit(activeTurn,r.request_id);}});
    let scope=[...budget.state.scope],last:ReturnType<typeof visibleTurn>|undefined;
    await mkdir(join(directory,"turns"),{recursive:true});await mkdir(join(directory,"checkpoints"),{recursive:true});
    const ask=async(question:string)=>{
      const id=randomUUID();await budget.reserve(id,question);activeTurn=id;
      if(budget.state.pending_compaction){harness!.requestCompaction();await budget.compact(false);}
      const result=await harness!.runTurn(question,scope,id),publicResult=visibleTurn(result);
      const snap=redactText(JSON.stringify(harness!.snapshot())+"\n",[key]);
      await writeFile(join(directory,"checkpoints",id+".json"),snap,{flag:"wx"});
      const saved=redactText(JSON.stringify({...publicResult,question,snapshot_sha256:sha(snap)})+"\n",[key]);
      await writeFile(join(directory,"turns",id+".json"),saved,{flag:"wx"});
      await budget.finish(id,sha(saved));last=publicResult;
      console.log("\n"+result.final_answer+"\n");
      const usage=result.requests.map(r=>r.usage.totalTokens);
      console.log(`状态 ${result.status} · 请求 ${result.requests.filter(r=>r.admitted).length}/12 · token ${usage.some(v=>v===null)?"unknown":usage.reduce<number>((n,v)=>n+(v??0),0)} · 费用 unknown`);
      return result.status==="completed"?0:1;
    };
    if(flags.ask!==undefined)return await ask(flags.ask);
    console.log(`AsterCite | 会话 ${name} | ${assets.publicPapers.length} 篇论文 | Reflect 关闭\n输入 /help 查看命令；退出后使用 --session ${name} 恢复。`);
    rl=createInterface({input:process.stdin,output:process.stdout});
    while(true){
      let line:string;try{line=(await rl.question("你> ")).trim();}catch{break;}
      if(!line)continue;
      try{
        if(!line.startsWith("/")){await ask(line);continue;}
        const [command,...parts]=line.split(/\s+/u),value=parts.join(" ");
        if(command==="/quit")break;
        if(command==="/help"){console.log(HELP);continue;}
        if(command==="/budget"){console.log(JSON.stringify(budget.summary(),null,2));continue;}
        if(command==="/corpus"){console.log(assets.publicPapers.filter(p=>!value || (p.paper_id+" "+p.title).toLowerCase().includes(value.toLowerCase())).map(p=>p.paper_id+"  "+p.title).join("\n") || "没有匹配的论文");continue;}
        if(command==="/scope"){
          if(value){const ids=value==="all"?[]:value.split(/[,，]/u).map(s=>s.trim());if(new Set(ids).size!==ids.length || ids.some(id=>!assets.publicPapers.some(p=>p.paper_id===id)))throw new RuntimeFailure("INVALID_SCOPE","请使用 /corpus 中的唯一论文 ID");
            scope=ids;await budget.setScope(ids);}
          console.log(scope.length?scope.join(", "):"全部论文");continue;
        }
        if(command==="/trace"){console.log(last?JSON.stringify({stages:last.stages,requests:last.requests,tools:last.tools},null,2):"本次打开后尚无问答");continue;}
        if(command==="/memory"){console.log(redactText(JSON.stringify(harness.memory.state,null,2),[key]));continue;}
        if(command==="/compact"){if(config.session.compaction!=="native")throw new RuntimeFailure("INVALID_CONFIG","当前配置关闭了原生压缩");await budget.compact(true);console.log("已登记；下一次提问时执行压缩，计入该轮请求预算。");continue;}
        console.log("未知命令，输入 /help。");
      }catch(e){console.error(errorText(e,[key]));}
    }
    return 0;
  }finally{rl?.close();harness?.dispose();worker?.close();await budget.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{process.exitCode=await runCli(process.argv.slice(2));}
  catch(e){console.error(errorText(e,[process.env.PIPAPER_API_KEY ?? ""]));process.exitCode=1;}
}
