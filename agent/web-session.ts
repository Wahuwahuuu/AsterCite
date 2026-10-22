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
export interface WebTurn { question:string; answer:string; status:string; sources:WebSource[]; elapsed_ms:number; requests:number; tokens:number|null; stages:Array<{stage:string;status:string}> }
export interface WebView {
  turns:WebTurn[]; scope:string[]; pending_compaction:boolean;
  budget:ReturnType<SessionBudget["summary"]>;
  memory:{paper_id:string|null;comparison:string[];dimensions:string[];preferences:Array<{key:string;value:string}>};
}
export interface WebSessionPort {
  view():Promise<WebView>;
  ask(question:string):Promise<WebView>;
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
    const options={cwd:this.assets.root,modelRuntime:provider?.runtime,model:provider?.model,worker:this.worker,
      knownPaperIds:new Set(this.assets.publicPapers.map(p=>p.paper_id)),secrets:[this.key],thinkingLevel:this.config.model.thinking_level,
      questionPreparation:"light-v1" as const,controls:this.controls,
      p2:{profile:"B" as const,executionVersion:"full-v1" as const,indexVersion:this.assets.indexVersion,evidenceIndex:this.assets.evidenceIndex,
        publicPapers:this.assets.publicPapers,commonPrompt:this.assets.commonPrompt,nlu:true,reflect:false,structuredMemory:true,answerContract:"full-v1-json" as const,
        stageOutputLimits:{question_frame:this.config.model.max_output_tokens,evidence_check:this.config.model.max_output_tokens,generation:this.config.model.max_output_tokens}},
      controlledSnapshot:this.snapshot,maxRequests:12,requestTimeoutMs:this.config.session.request_timeout_ms,turnTimeoutMs:this.config.session.turn_timeout_ms,
      authorizeRequest:async(r:{request_id:string})=>{await this.budget.admit(this.activeTurn,r.request_id);}};
    // Tests supply a local provider; production always uses the configured in-memory runtime.
    this.harness=await (this.createHarness??MainPaperHarness.create)(options as MainHarnessOptions);
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
  async ask(question:string):Promise<WebView>{
    if(!question.trim()||Array.from(question).length>12000)throw new RuntimeFailure("INVALID_INPUT","Question length must be 1..12000");
    if(this.busy||this.closed)throw new RuntimeFailure("SESSION_LOCKED","Session is busy");
    this.busy=true;
    try{
      const id=randomUUID();await this.budget.reserve(id,question);this.activeTurn=id;
      const harness=await this.getHarness();
      if(this.budget.state.pending_compaction){harness.requestCompaction();await this.budget.compact(false);}
      const record=await harness.runTurn(question,[...this.budget.state.scope],id),view=webTurn(record,question,this.assets.publicPapers,this.sources);
      const snap=redactText(JSON.stringify(harness.snapshot())+"\n",[this.key]);
      const saved=redactText(JSON.stringify({...visibleTurn(record),web_turn:view,snapshot_sha256:sha(snap)})+"\n",[this.key]);
      await writeFile(join(this.directory,"checkpoints",id+".json"),snap,{flag:"wx"});
      await writeFile(join(this.directory,"turns",id+".json"),saved,{flag:"wx"});
      await this.budget.finish(id,sha(saved));this.history.push(JSON.parse(saved).web_turn);
      this.snapshot=JSON.parse(snap);return this.view();
    }finally{this.busy=false;}
  }
  async close():Promise<void>{if(this.closed)return;this.closed=true;this.harness?.dispose();await this.budget.close();}
}
