import { mkdir, readFile, readdir, open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { sha } from "./config.ts";
import { RuntimeFailure } from "./contracts.ts";

export interface TurnAdmission {id:string;question_sha256:string;status:"reserved"|"finished";requests:string[];result_sha256?:string}
export interface BudgetState {version:1;implementation_id:string;max_turns:number;turns:TurnAdmission[];pending_compaction:boolean;scope:string[]}
interface Generation {sequence:number;previous_sha256:string|null;state:BudgetState}
export class SessionBudget {
  readonly directory:string;
  private lock:FileHandle;
  private generation=0;
  private previousHash:string|null=null;
  state:BudgetState;
  private constructor(directory:string,lock:FileHandle,state:BudgetState){this.directory=directory;this.lock=lock;this.state=state;}
  static async open(directory:string,implementationId:string,maxTurns:number):Promise<SessionBudget>{
    if(!Number.isInteger(maxTurns)||maxTurns<1||maxTurns>1000)throw new RuntimeFailure("INVALID_BUDGET","Invalid turn limit");
    await mkdir(join(directory,"ledger"),{recursive:true});
    let lock:FileHandle;
    try{lock=await open(join(directory,"session.lock"),"wx");}catch{throw new RuntimeFailure("SESSION_LOCKED","Session is open or interrupted; use a new session, or inspect and remove its stale lock");}
    const budget=new SessionBudget(directory,lock,{version:1,implementation_id:implementationId,max_turns:maxTurns,turns:[],pending_compaction:false,scope:[]});
    try{
      const files=(await readdir(join(directory,"ledger"))).sort();
      if(files.some(f=>!/^\d{6}\.json$/u.test(f)))throw new RuntimeFailure("INVALID_BUDGET","Unexpected ledger entry");
      for(const [seq,f] of files.entries()){
        const bytes=await readFile(join(directory,"ledger",f)),v=JSON.parse(bytes.toString()) as Generation;
        if(f!==String(seq).padStart(6,"0")+".json" || v.sequence!==seq || v.previous_sha256!==budget.previousHash ||
           v.state.implementation_id!==implementationId || v.state.max_turns!==maxTurns || v.state.version!==1 ||
           typeof v.state.pending_compaction!=="boolean" || !Array.isArray(v.state.scope) || v.state.scope.some(p=>typeof p!=="string") ||
           v.state.turns.length>maxTurns || new Set(v.state.turns.map(t=>t.id)).size!==v.state.turns.length ||
           v.state.turns.some(t=>!/^[-a-zA-Z0-9_]{1,100}$/u.test(t.id) || !/^[a-f0-9]{64}$/u.test(t.question_sha256) || t.requests.length>12 ||
             new Set(t.requests).size!==t.requests.length || !["reserved","finished"].includes(t.status)))
          throw new RuntimeFailure("INVALID_BUDGET","Ledger identity, count or chain differs");
        if(seq>0) {
          const old=budget.state;
          if(v.state.turns.length<old.turns.length || v.state.turns.length>old.turns.length+1)throw new RuntimeFailure("INVALID_BUDGET","Reserved turns cannot be refunded");
          for(const [i,before] of old.turns.entries()){const after=v.state.turns[i];
            if(before.id!==after.id || before.question_sha256!==after.question_sha256 || after.requests.length<before.requests.length ||
               before.requests.some((id,j)=>after.requests[j]!==id) || before.status==="finished" && JSON.stringify(before)!==JSON.stringify(after))
               throw new RuntimeFailure("INVALID_BUDGET","Finished turns/requests cannot change");}
        }
        budget.state=v.state;budget.previousHash=sha(bytes);budget.generation=seq+1;
      }
      if(!files.length)await budget.persist();
      return budget;
    }catch(e){await budget.close();throw e;}
  }
  private async persist():Promise<void>{
    const bytes=JSON.stringify({sequence:this.generation,previous_sha256:this.previousHash,state:this.state})+"\n";
    const handle=await open(join(this.directory,"ledger",String(this.generation).padStart(6,"0")+".json"),"wx");
    try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
    this.previousHash=sha(bytes);this.generation++;
  }
  async reserve(id:string,question:string):Promise<void>{
    if(!/^[-a-zA-Z0-9_]{1,100}$/u.test(id))throw new RuntimeFailure("INVALID_BUDGET","Invalid turn ID");
    if(this.state.turns.length>=this.state.max_turns)throw new RuntimeFailure("SESSION_BUDGET_EXCEEDED","Session turn budget exhausted; create a new session");
    if(this.state.turns.some(t=>t.id===id))throw new RuntimeFailure("DUPLICATE_TURN","Turn already reserved");
    this.state.turns.push({id,question_sha256:sha(question),status:"reserved",requests:[]});await this.persist();
  }
  async admit(id:string,requestId:string):Promise<void>{
    const t=this.state.turns.find(t=>t.id===id);
    if(!t || t.status!=="reserved" || t.requests.length>=12 || t.requests.includes(requestId))throw new RuntimeFailure("REQUEST_BUDGET_EXCEEDED","Request admission rejected");
    t.requests.push(requestId);await this.persist();
  }
  async finish(id:string,resultSha:string):Promise<void>{
    const t=this.state.turns.find(t=>t.id===id);if(!t || t.status!=="reserved")throw new RuntimeFailure("INVALID_BUDGET","Unreserved/already finished turn");
    t.status="finished";t.result_sha256=resultSha;await this.persist();
  }
  async compact(pending:boolean):Promise<void>{this.state.pending_compaction=pending;await this.persist();}
  async setScope(scope:string[]):Promise<void>{this.state.scope=[...scope];await this.persist();}
  summary(){return {turns_reserved:this.state.turns.length,max_turns:this.state.max_turns,model_attempts:this.state.turns.reduce((n,t)=>n+t.requests.length,0),request_limit_per_turn:12,remaining_turns:this.state.max_turns-this.state.turns.length};}
  async close():Promise<void>{await this.lock.close();await unlink(join(this.directory,"session.lock"));}
}
