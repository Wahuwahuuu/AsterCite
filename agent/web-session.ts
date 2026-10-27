import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionBudget } from "./budget.ts";
import { createUserRuntime, sha, type AppConfig } from "./config.ts";
import { RuntimeFailure, redactText, type Paper, type WorkerTransport, type Chunk } from "./contracts.ts";
import { MainPaperHarness, type MainHarnessOptions } from "./session-main-v2.ts";
import { unwrapSnapshot, type ControlledSnapshot, type ControlledTurnRecord, type RuntimeControls } from "./main-controls.ts";
import { visibleTurn } from "./cli.ts";
import type { Assets } from "./assets.ts";

export interface WebSource { chunk_id:string; paper_id:string; title:string; section:string; text:string }
export interface WebActivity { id:string; kind:"model"|"tool"|"memory"|"compaction"; status:"running"|"completed"|"error"; label:string; detail:string; elapsed_ms:number; tool?:"search_papers"|"retrieve_chunks" }
export type ProgressListener=(activity:WebActivity)=>void;
export interface WebTurn { question:string; answer:string; status:string; sources:WebSource[]; elapsed_ms:number; requests:number; tokens:number|null; stages:Array<{stage:string;status:string}>; activity?:WebActivity[] }
export interface WebView {
  turns:WebTurn[]; scope:string[]; pending_compaction:boolean;
  budget:ReturnType<SessionBudget["summary"]>;
  memory:{paper_id:string|null;comparison:string[];dimensions:string[];preferences:Array<{key:string;value:string}>};
}
export interface WebSessionPort {
  view():Promise<WebView>;
  ask(question:string,onProgress?:ProgressListener):Promise<WebView>;
  configure(scope:string[],compact:boolean):Promise<WebView>;
  close():Promise<void>;
}
export type WebSessionFactory=(directory:string)=>Promise<WebSessionPort>;

export function webTurn(record:ControlledTurnRecord,question:string,papers:readonly Paper[],sources:ReadonlyMap<string,Chunk>):WebTurn {
  const citations=record.citation_validity.cited_ids;
  const total=record.requests.map(r=>r.usage.totalTokens);
  return {question,answer:record.final_answer,status:record.status,elapsed_ms:record.elapsed_ms,
    requests:record.requests.filter(r=>r.admitted).length,tokens:total.some(t=>t===null)?null:total.reduce<number>((a,t)=>a+(t??0),0),
    stages:record.pipeline_trace?.stages.map(s=>({stage:s.stage,status:s.status}))??[],
    sources:[...new Set(citations)].flatMap(id=>{const c=sources.get(id);return c?[{chunk_id:id,paper_id:c.paper_id,
      title:papers.find(p=>p.paper_id===c.paper_id)?.title??c.paper_id,section:c.section,text:c.text}]:[];})};
}

export class PaperWebSession implements WebSessionPort {
  private harness?:MainPaperHarness;
  private activeTurn="";
  private snapshot?:ControlledSnapshot;
  private history:WebTurn[]=[];
  private busy=false;
  private closed=false;
  private readonly controls:RuntimeControls;
  private directory:string;
  private budget:SessionBudget;
  private assets:Assets;
  private config:AppConfig;
  private worker:WorkerTransport;
  private sources:ReadonlyMap<string,Chunk>;
  private key:string;
  private onProgress?:ProgressListener;
  private activity:WebActivity[]=[];
  private activityStarted=0;
  private modelActivity:string|null=null;
  private emit(value:Omit<WebActivity,"elapsed_ms">){
    const item=JSON.parse(redactText(JSON.stringify({...value,elapsed_ms:Date.now()-this.activityStarted}),[this.key])) as WebActivity;
    const index=this.activity.findIndex(e=>e.id===item.id);
    if(index>=0)this.activity[index]=item;else if(this.activity.length<100)this.activity.push(item);else return;
    try{this.onProgress?.(structuredClone(item));}catch{/* A closed viewer must not alter a model run. */}
  }
  private finishModel(status:"completed"|"error"="completed"){
    const item=this.activity.find(e=>e.id===this.modelActivity);
    if(item?.status==="running")this.emit({...item,status,detail:status==="error"?"模型请求未完成":item.detail.startsWith("模型")?"模型响应已返回":item.detail});
    this.modelActivity=null;
  }
  private createHarness?: (options:MainHarnessOptions)=>Promise<MainPaperHarness>;
  private constructor(directory:string,budget:SessionBudget,assets:Assets,config:AppConfig,
    worker:WorkerTransport,sources:ReadonlyMap<string,Chunk>,key:string,
    createHarness?:(options:MainHarnessOptions)=>Promise<MainPaperHarness>){
    this.directory=directory;this.budget=budget;this.assets=assets;this.config=config;this.worker=worker;
    this.sources=sources;this.key=key;this.createHarness=createHarness;
    this.controls={arm:"C",reflect:false,compaction:config.session.compaction,reliability:"candidate",implementation_id:assets.implementationId};
  }
  static async open(options:{directory:string;assets:Assets;config:AppConfig;worker:WorkerTransport;sources:ReadonlyMap<string,Chunk>;key:string;
    createHarness?:(options:MainHarnessOptions)=>Promise<MainPaperHarness>}):Promise<PaperWebSession>{
    const b=await SessionBudget.open(options.directory,options.assets.implementationId,options.config.session.max_turns);
    const s=new PaperWebSession(options.directory,b,options.assets,options.config,options.worker,options.sources,options.key,options.createHarness);
    try{
      await mkdir(join(options.directory,"turns"),{recursive:true});await mkdir(join(options.directory,"checkpoints"),{recursive:true});
      for(const turn of b.state.turns){
        if(turn.status!=="finished")continue;
        const bytes=await readFile(join(options.directory,"turns",turn.id+".json"));
        if(sha(bytes)!==turn.result_sha256)throw new RuntimeFailure("INVALID_SESSION","Saved answer differs");
        const saved=JSON.parse(bytes.toString()),snap=await readFile(join(options.directory,"checkpoints",turn.id+".json"));
        if(sha(snap)!==saved.snapshot_sha256)throw new RuntimeFailure("INVALID_SESSION","Saved checkpoint differs");
        const snapshot=JSON.parse(snap.toString()) as ControlledSnapshot;
        unwrapSnapshot(snapshot,s.controls,s.assets.indexVersion);
        s.snapshot=snapshot;s.history.push(saved.web_turn);
      }
      return s;
    }catch(e){await s.close();throw e;}
  }
  private async getHarness():Promise<MainPaperHarness>{
    if(this.harness)return this.harness;
    const provider=this.createHarness?undefined:await createUserRuntime(this.config.model,this.key);
    const observedWorker:WorkerTransport={request:async(method,params,signal)=>{
      this.finishModel();const id=randomUUID();
      const query=Array.from(params.query).slice(0,180).join("");
      const range="paper_ids" in params?params.paper_ids.join("、"):this.budget.state.scope.join("、")||"全部论文";
      const label=method==="search_papers"?"查找论文":"检索与重排原文";
      this.emit({id,kind:"tool",status:"running",tool:method,label,detail:`${query} · 范围：${range}`});
      try{
        const result=await this.worker.request(method,params,signal);
        const data=result as {papers?:unknown[];chunks?:unknown[]};
        const count=method==="search_papers"?data.papers?.length:data.chunks?.length;
        this.emit({id,kind:"tool",status:"completed",tool:method,label,detail:`${query} · 返回 ${count??0} ${method==="search_papers"?"篇论文":"段原文"}`});
        return result;
      }catch(e){this.emit({id,kind:"tool",status:"error",tool:method,label,detail:"工具调用未完成"});throw e;}
    }};
    const options={cwd:this.assets.root,modelRuntime:provider?.runtime,model:provider?.model,worker:observedWorker,
      knownPaperIds:new Set(this.assets.publicPapers.map(p=>p.paper_id)),secrets:[this.key],thinkingLevel:this.config.model.thinking_level,
      questionPreparation:"light-v1" as const,controls:this.controls,
      p2:{profile:"B" as const,executionVersion:"full-v1" as const,indexVersion:this.assets.indexVersion,evidenceIndex:this.assets.evidenceIndex,
        publicPapers:this.assets.publicPapers,commonPrompt:this.assets.commonPrompt,nlu:true,reflect:false,structuredMemory:true,answerContract:"full-v1-json" as const,
        stageOutputLimits:{question_frame:this.config.model.max_output_tokens,evidence_check:this.config.model.max_output_tokens,generation:this.config.model.max_output_tokens}},
      controlledSnapshot:this.snapshot,maxRequests:12,requestTimeoutMs:this.config.session.request_timeout_ms,turnTimeoutMs:this.config.session.turn_timeout_ms,
      authorizeRequest:async(r:{request_id:string;stage?:string|null;phase?:string})=>{
        await this.budget.admit(this.activeTurn,r.request_id);this.finishModel();this.modelActivity=r.request_id;
        const preparing=["question_preparation","question_frame"].includes(r.stage??"");
        this.emit({id:r.request_id,kind:"model",status:"running",label:preparing?"理解问题与改写查询":r.phase==="compaction"?"压缩会话上下文":["generate","closing","citation_repair"].includes(r.stage??"")?"依据原文整理回答":"分析证据与选择行动",detail:preparing?"结合当前论文和对话，确定本轮检索目标":"模型请求已发出，等待返回"});
      }};
    // Tests supply a local provider; production always uses the configured in-memory runtime.
    this.harness=await (this.createHarness??MainPaperHarness.create)(options as MainHarnessOptions);
    this.harness.session.subscribe(event=>{
      if(!this.busy)return;
      if(event.type==="message_update"&&event.assistantMessageEvent.type==="thinking_start"){
        const item=this.activity.find(e=>e.id===this.modelActivity);if(item)this.emit({...item,detail:"模型正在思考"});
      }
      if(event.type==="compaction_start")this.emit({id:"compaction",kind:"compaction",status:"running",label:"压缩会话上下文",detail:"保留对话目标与关键记忆"});
      if(event.type==="compaction_end")this.emit({id:"compaction",kind:"compaction",status:event.aborted||event.errorMessage?"error":"completed",label:"压缩会话上下文",detail:event.aborted||event.errorMessage?"压缩未完成":"上下文已整理"});
    });
    return this.harness;
  }
  async view():Promise<WebView>{
    const state=this.harness?.memory.state??this.snapshot?.state.domain_state;
    return {turns:structuredClone(this.history),scope:[...this.budget.state.scope],pending_compaction:this.budget.state.pending_compaction,
      budget:this.budget.summary(),memory:{paper_id:state?.current_paper?.paper_id??null,comparison:state?.comparison_order??[],dimensions:state?.comparison_dimensions??[],
        preferences:state?.user_constraints.filter(p=>p.superseded_by===null).map(p=>({key:p.key,value:p.value}))??[]}};
  }
  async configure(scope:string[],compact:boolean):Promise<WebView>{
    if(this.busy||this.closed)throw new RuntimeFailure("SESSION_LOCKED","Session is busy");
    const ids=new Set(this.assets.publicPapers.map(p=>p.paper_id));
    if(new Set(scope).size!==scope.length||scope.some(id=>!ids.has(id)))throw new RuntimeFailure("INVALID_SCOPE","Unknown paper");
    if(compact&&this.config.session.compaction!=="native")throw new RuntimeFailure("INVALID_CONFIG","Compaction is disabled");
    await this.budget.setScope(scope);await this.budget.compact(compact);return this.view();
  }
  async ask(question:string,onProgress?:ProgressListener):Promise<WebView>{
    if(!question.trim()||Array.from(question).length>12000)throw new RuntimeFailure("INVALID_INPUT","Question length must be 1..12000");
    if(this.busy||this.closed)throw new RuntimeFailure("SESSION_LOCKED","Session is busy");
    this.busy=true;
    this.onProgress=onProgress;this.activity=[];this.activityStarted=Date.now();this.modelActivity=null;
    try{
      const id=randomUUID();await this.budget.reserve(id,question);this.activeTurn=id;
      const harness=await this.getHarness();
      if(this.budget.state.pending_compaction){harness.requestCompaction();await this.budget.compact(false);}
      const record=await harness.runTurn(question,[...this.budget.state.scope],id),view=webTurn(record,question,this.assets.publicPapers,this.sources);
      this.finishModel(record.status==="completed"?"completed":"error");
      if(record.status!=="completed")for(const item of [...this.activity])if(item.status==="running")this.emit({...item,status:"error",detail:"本轮未完成"});
      this.emit({id:"memory",kind:"memory",status:"running",label:"保存会话与记忆",detail:"保存回答、引用和本轮执行过程"});
      view.activity=structuredClone(this.activity).map(item=>item.id==="memory"?{...item,status:"completed",detail:"会话与记忆已保存"}:item);
      const snap=redactText(JSON.stringify(harness.snapshot())+"\n",[this.key]);
      const saved=redactText(JSON.stringify({...visibleTurn(record),web_turn:view,snapshot_sha256:sha(snap)})+"\n",[this.key]);
      await writeFile(join(this.directory,"checkpoints",id+".json"),snap,{flag:"wx"});
      await writeFile(join(this.directory,"turns",id+".json"),saved,{flag:"wx"});
      await this.budget.finish(id,sha(saved));this.history.push(JSON.parse(saved).web_turn);
      this.emit({id:"memory",kind:"memory",status:"completed",label:"保存会话与记忆",detail:"会话与记忆已保存"});
      this.snapshot=JSON.parse(snap);return this.view();
    }finally{this.busy=false;this.onProgress=undefined;}
  }
  async close():Promise<void>{if(this.closed)return;this.closed=true;this.harness?.dispose();await this.budget.close();}
}
