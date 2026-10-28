import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionBudget } from "./budget.ts";
import { createUserRuntime, containedPath,sha, type AppConfig } from "./config.ts";
import { RuntimeFailure, redactText, type Paper, type WorkerTransport, type Chunk } from "./contracts.ts";
import { MainPaperHarness, type MainHarnessOptions } from "./session-main-v2.ts";
import { unwrapSnapshot, type ControlledSnapshot, type ControlledTurnRecord, type RuntimeControls } from "./main-controls.ts";
import { visibleTurn } from "./cli.ts";
import type { Assets } from "./assets.ts";
import type { ExecutionEvent } from "./execution-trace.ts";
import type { PaperCoverage } from "./selected-scope.ts";
import {corpusAbstracts} from './paper-reading.ts';
import {ContextTracker,type ContextView} from './workbench-context.ts';
import type {ReadingNote} from './domain-memory.ts';

export interface WebSource { chunk_id:string; paper_id:string; title:string; section:string; text:string }
export interface WebExecutionDetail extends ExecutionEvent {turn_id:string;cycle:number;elapsed_ms:number;turn_elapsed_ms:number;started_at:string}
export interface WebActivity { id:string; kind:"model"|"tool"|"memory"|"compaction"; status:"running"|"completed"|"error"; label:string; detail:string; elapsed_ms:number; tool?:"search_papers"|"retrieve_chunks";turn_id?:string;cycle?:number;parent_id?:string;origin?:"model"|"host_plan";has_details?:boolean;context?:ContextView }
export type ProgressListener=(activity:WebActivity)=>void;
export interface WebTurn { question:string; answer:string; status:string; sources:WebSource[]; elapsed_ms:number; requests:number; tokens:number|null; stages:Array<{stage:string;status:string}>; activity?:WebActivity[];turn_id?:string;coverage?:PaperCoverage[] }
export interface WebView {
  turns:WebTurn[]; scope:string[]; pending_compaction:boolean;
  budget:ReturnType<SessionBudget["summary"]>;
  memory:{paper_id:string|null;comparison:string[];dimensions:string[];preferences:Array<{key:string;value:string;source_turn?:string;source_quote?:string}>;notes?:ReadingNote[];unresolved?:Array<{text:string;gap:string;source_turn:string}>;findings?:Array<{text:string;source_turn:string}>;inferences?:Array<{text:string;source_turn:string}>;object_source_turn?:string|null};
  context?:ContextView;
}
export interface WebSessionPort {
  view():Promise<WebView>;
  ask(question:string,onProgress?:ProgressListener):Promise<WebView>;
  configure(scope:string[],compact:boolean):Promise<WebView>;
  close():Promise<void>;
  detail?(turnId:string,id:string):Promise<WebExecutionDetail|null>;
}
export type WebSessionFactory=(directory:string)=>Promise<WebSessionPort>;

export async function readSavedTrace(directory:string,turnId:string,id:string):Promise<WebExecutionDetail|null>{
  try{const saved=JSON.parse(await readFile(await containedPath(directory,`turns/${turnId}.json`),"utf8"));
    if(!saved.trace_sha256)return null;
    const bytes=await readFile(await containedPath(directory,`traces/${turnId}.json`));if(sha(bytes)!==saved.trace_sha256)throw new RuntimeFailure("INVALID_SESSION","Trace changed");
    return (JSON.parse(bytes.toString()) as WebExecutionDetail[]).find(item=>item.id===id)??null;
  }catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
}

export function webTurn(record:ControlledTurnRecord,question:string,papers:readonly Paper[],sources:ReadonlyMap<string,Chunk>):WebTurn {
  const citations=record.citation_validity.cited_ids;
  const total=record.requests.map(r=>r.usage.totalTokens);
  return {question,answer:record.final_answer,status:record.status,elapsed_ms:record.elapsed_ms,turn_id:record.user_turn_id,coverage:record.final_structure?.paper_coverage,
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
  private traceDetails=new Map<string,WebExecutionDetail>();
  private cycles=0;
  private observe(event:ExecutionEvent){
    const previous=this.traceDetails.get(event.id);
    const cycle=previous?.cycle??(event.kind==="model"?++this.cycles:this.traceDetails.get(event.parent_id??"")?.cycle??this.cycles);
    const elapsed=Date.now()-this.activityStarted;
    const startedAt=previous?.started_at??new Date().toISOString();
    const value=JSON.parse(redactText(JSON.stringify({...previous,...event,turn_id:this.activeTurn,cycle,turn_elapsed_ms:elapsed,started_at:startedAt,elapsed_ms:event.elapsed_ms??Date.now()-Date.parse(startedAt)}),[this.key])) as WebExecutionDetail;
    this.traceDetails.set(event.id,value);
    const preparing=["question_preparation","question_frame"].includes(event.stage);
    const readingAbstract=(value.input as {section?:string}|undefined)?.section==='abstract'||value.output?.text.includes('"backend":"corpus_abstract_v1"');
    const label=event.kind==="tool"?event.tool==="search_papers"?"查找论文":readingAbstract?"读取摘要原文":"检索与重排原文":preparing?"理解问题与改写查询":event.stage==="citation_repair"?"修正回答与引用":event.phase==="compaction"?"压缩会话上下文":["generate","closing"].includes(event.stage)?"依据原文整理回答":"分析证据与选择行动";
    let detail=event.kind==="model"?event.status==="running"?"查看本轮模型上下文与请求内容":"查看模型可见输出与工具选择":"";
    if(event.kind==="tool"){
      const input=value.input as {query?:string;paper_ids?:string[]}|undefined;
      let count:string="";try{const result=JSON.parse(value.output?.text??"{}");count=Array.isArray(result.chunks)?`返回 ${result.chunks.length} 段原文`:Array.isArray(result.papers)?`返回 ${result.papers.length} 篇论文`:"";}catch{}
      detail=`${input?.query??""}${count?" · "+count:input?.paper_ids?" · "+input.paper_ids.join("、"):""}`;
    }
    this.emit({id:event.id,kind:event.kind,status:event.status,label,detail,tool:event.tool,turn_id:this.activeTurn,cycle,parent_id:event.parent_id,origin:event.origin,has_details:true});
  }
  async detail(turnId:string,id:string):Promise<WebExecutionDetail|null>{return turnId===this.activeTurn?structuredClone(this.traceDetails.get(id)??null):readSavedTrace(this.directory,turnId,id);}
  private emit(value:Omit<WebActivity,"elapsed_ms">){
    const item=JSON.parse(redactText(JSON.stringify({...value,elapsed_ms:Date.now()-this.activityStarted}),[this.key])) as WebActivity;
    const index=this.activity.findIndex(e=>e.id===item.id);
    if(index>=0)this.activity[index]=item;else if(this.activity.length<100)this.activity.push(item);else return;
    try{this.onProgress?.(JSON.parse(redactText(JSON.stringify({...item,context:this.harness?.contextView()}),[this.key])));}catch{/* A closed viewer must not alter a model run. */}
  }
  private createHarness?: (options:MainHarnessOptions)=>Promise<MainPaperHarness>;
  private constructor(directory:string,budget:SessionBudget,assets:Assets,config:AppConfig,
    worker:WorkerTransport,sources:ReadonlyMap<string,Chunk>,key:string,
    createHarness?:(options:MainHarnessOptions)=>Promise<MainPaperHarness>){
    this.directory=directory;this.budget=budget;this.assets=assets;this.config=config;this.worker=worker;
    this.sources=new Map([...sources,...[...corpusAbstracts(assets.publicPapers,assets.indexVersion).values()].map(source=>[source.chunk_id,source] as const)]);this.key=key;this.createHarness=createHarness;
    this.controls={arm:"C",reflect:false,compaction:config.session.compaction,reliability:"candidate",implementation_id:assets.implementationId};
  }
  static async open(options:{directory:string;assets:Assets;config:AppConfig;worker:WorkerTransport;sources:ReadonlyMap<string,Chunk>;key:string;
    createHarness?:(options:MainHarnessOptions)=>Promise<MainPaperHarness>}):Promise<PaperWebSession>{
    const b=await SessionBudget.open(options.directory,options.assets.implementationId,options.config.session.max_turns);
    const s=new PaperWebSession(options.directory,b,options.assets,options.config,options.worker,options.sources,options.key,options.createHarness);
    try{
      await mkdir(join(options.directory,"turns"),{recursive:true});await mkdir(join(options.directory,"checkpoints"),{recursive:true});await mkdir(join(options.directory,"traces"),{recursive:true});
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
    const options={cwd:this.assets.root,modelRuntime:provider?.runtime,model:provider?.model,worker:this.worker,
      knownPaperIds:new Set(this.assets.publicPapers.map(p=>p.paper_id)),secrets:[this.key],thinkingLevel:this.config.model.thinking_level,
      questionPreparation:"light-v1" as const,answerPolicy:'workbench-v1' as const,controls:this.controls,selectedScopeCoverage:true,onExecutionEvent:(event:ExecutionEvent)=>this.observe(event),
      p2:{profile:"B" as const,executionVersion:"full-v1" as const,indexVersion:this.assets.indexVersion,evidenceIndex:this.assets.evidenceIndex,
        publicPapers:this.assets.publicPapers,commonPrompt:this.assets.commonPrompt,nlu:true,reflect:false,structuredMemory:true,answerContract:"full-v1-json" as const,
        stageOutputLimits:{question_frame:this.config.model.max_output_tokens,evidence_check:this.config.model.max_output_tokens,generation:this.config.model.max_output_tokens}},
      controlledSnapshot:this.snapshot,maxRequests:12,requestTimeoutMs:this.config.session.request_timeout_ms,turnTimeoutMs:this.config.session.turn_timeout_ms,
      authorizeRequest:async(r:{request_id:string})=>{await this.budget.admit(this.activeTurn,r.request_id);}};
    // Tests supply a local provider; production always uses the configured in-memory runtime.
    this.harness=await (this.createHarness??MainPaperHarness.create)(options as MainHarnessOptions);
    this.harness.session.subscribe(event=>{
      if(!this.busy)return;
      if(event.type==="message_update"&&event.assistantMessageEvent.type==="thinking_start"){
        const item=[...this.activity].reverse().find(e=>e.kind==="model"&&e.status==="running");if(item)this.emit({...item,detail:"模型正在思考，可查看本次输入上下文"});
      }
      if(event.type==="compaction_start")this.emit({id:"compaction",kind:"compaction",status:"running",label:"压缩会话上下文",detail:"保留对话目标与关键记忆"});
      if(event.type==="compaction_end"){const record=this.harness?.contextView().compressions.at(-1);this.emit({id:"compaction",kind:"compaction",status:record?.status==='unchanged'?'completed':event.aborted||event.errorMessage?"error":"completed",label:"压缩会话上下文",detail:record?.note??'上下文已整理'});}
    });
    return this.harness;
  }
  async view():Promise<WebView>{
    const state=this.harness?.memory.state??this.snapshot?.state.domain_state;
    const view:WebView={turns:structuredClone(this.history),scope:[...this.budget.state.scope],pending_compaction:this.budget.state.pending_compaction,
      budget:this.budget.summary(),context:this.harness?.contextView()??new ContextTracker(this.snapshot?.state.context_state).view(this.config.model.context_window,this.config.session.compaction==='native'),memory:{paper_id:state?.current_paper?.paper_id??null,comparison:state?.comparison_order??[],dimensions:state?.comparison_dimensions??[],
        preferences:state?.user_constraints.filter(p=>p.superseded_by===null).map(p=>({key:p.key,value:p.value,source_turn:p.source_turn,source_quote:p.source_quote}))??[],notes:structuredClone(state?.reading_notes??[]),unresolved:structuredClone(state?.unresolved_questions??[]),findings:state?.conclusions.filter(item=>item.source_status==='verified').slice(-24).map(item=>({text:item.text,source_turn:item.source_turn}))??[],inferences:state?.pending_inferences.slice(-12).map(item=>({text:item.text,source_turn:item.source_turn}))??[],object_source_turn:state?.object_source_turn??null}};
    return JSON.parse(redactText(JSON.stringify(view),[this.key])) as WebView;
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
    this.onProgress=onProgress;this.activity=[];this.traceDetails.clear();this.cycles=0;this.activityStarted=Date.now();
    try{
      const id=randomUUID();await this.budget.reserve(id,question);this.activeTurn=id;
      const harness=await this.getHarness();
      if(this.budget.state.pending_compaction){harness.requestCompaction();await this.budget.compact(false);}
      const record=await harness.runTurn(question,[...this.budget.state.scope],id),view=webTurn(record,question,this.assets.publicPapers,this.sources);
      if(record.status!=="completed")for(const item of [...this.activity])if(item.status==="running")this.emit({...item,status:"error",detail:"本轮未完成"});
      this.emit({id:"memory",kind:"memory",status:"running",label:"保存会话与记忆",detail:"保存回答、引用和本轮执行过程"});
      view.activity=structuredClone(this.activity).map(item=>item.id==="memory"?{...item,status:"completed",detail:"会话与记忆已保存"}:item);
      const snap=redactText(JSON.stringify(harness.snapshot())+"\n",[this.key]);
      const trace=redactText(JSON.stringify([...this.traceDetails.values()])+"\n",[this.key]);
      const saved=redactText(JSON.stringify({...visibleTurn(record),web_turn:view,snapshot_sha256:sha(snap),trace_sha256:sha(trace)})+"\n",[this.key]);
      await writeFile(join(this.directory,"traces",id+".json"),trace,{flag:"wx"});
      await writeFile(join(this.directory,"checkpoints",id+".json"),snap,{flag:"wx"});
      await writeFile(join(this.directory,"turns",id+".json"),saved,{flag:"wx"});
      await this.budget.finish(id,sha(saved));this.history.push(JSON.parse(saved).web_turn);
      this.emit({id:"memory",kind:"memory",status:"completed",label:"保存会话与记忆",detail:"会话与记忆已保存"});
      this.snapshot=JSON.parse(snap);return this.view();
    }finally{this.busy=false;this.onProgress=undefined;}
  }
  async close():Promise<void>{if(this.closed)return;this.closed=true;this.harness?.dispose();await this.budget.close();}
}
