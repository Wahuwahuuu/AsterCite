import type {Chunk} from './contracts.ts';
import type {ComparisonReport} from './multi-paper.ts';
import type {TurnExecution} from './turn-execution.ts';
import type {ExecutionEvent} from './execution-trace.ts';

export type TaskState='pending'|'running'|'retrieved'|'supported'|'answered'|'gap'|'stopped'|'unconfirmed';
export interface TaskItem {id:string;label:string;paper_id?:string;state:TaskState;source_ids:string[];note:string}
export interface TaskProgress {version:1;phase:'running'|'completed'|'partial'|'stopped'|'clarification';items:TaskItem[]}
export interface GoalUpdate {need_id:string;paper_id?:string;status:'working'|'supported'|'gap';source_ids:string[];note?:string}
const clip=(value:string,n=300)=>Array.from(value).slice(0,n).join('');
export const GOAL_PROGRESS_INSTRUCTION=`For the supplied task goals, execution may also include goal_updates:[{"need_id":"exact goal ID","paper_id":"exact ID if present in goal","status":"working|supported|gap","source_ids":["actual visible chunk ID"],"note":"short Chinese result or precise gap"}]. supported means the reply actually explains that goal using relevant visible original text, not merely that a retrieval returned something. Do not mark unaddressed goals supported. Conversation/catalog goals may be supported without paper sources only when needs_sources=false. Goal updates are optional, never a reason to suppress a readable answer.`;

/** 进度只描述已经发生的动作；取得片段和完成回答使用不同状态。 */
export class TaskProgressTracker {
  private value:TaskProgress={version:1,phase:'running',items:[]};
  private tools=new Map<string,{papers:string[];tool:string}>();
  private publish?: (progress:TaskProgress)=>void;
  constructor(question:string,publish?:(progress:TaskProgress)=>void){this.publish=publish;this.value.items=[{id:'understand',label:'理解本轮问题',state:'running',source_ids:[],note:''},{id:'answer',label:clip(question),state:'pending',source_ids:[],note:'等待生成回答'}];this.emit();}
  private emit(){try{this.publish?.(this.snapshot());}catch{/* 展示不能影响问答。 */}}
  snapshot():TaskProgress{return structuredClone(this.value);}
  plan(question:string,needs:readonly {need_id:string;text:string}[],papers:readonly string[],nonFactual=false){
    const actual=needs.filter(need=>need.need_id!=='n1'&&!need.need_id.startsWith('selected_'));
    const goals=actual.length?actual:[{need_id:'n1',text:question}];
    this.value.items=[{id:'understand',label:'理解本轮问题',state:'answered',source_ids:[],note:'已形成任务范围'},
      ...(!nonFactual?papers.map(paper_id=>({id:'source:'+paper_id,paper_id,label:'读取相关原文',state:'pending' as const,source_ids:[],note:'尚未读取'})):[]),
      ...goals.map(need=>({id:need.need_id,label:clip(need.text),state:'pending' as const,source_ids:[],note:'尚未单独核对'})),
      {id:'answer',label:'整理并保存回答',state:'pending',source_ids:[],note:''}];this.emit();
  }
  goals(){return this.value.items.filter(item=>!['understand','answer'].includes(item.id)&&!item.id.startsWith('source:')).map(item=>({need_id:item.id,text:item.label,...(item.paper_id?{paper_id:item.paper_id}:{})}));}
  event(event:ExecutionEvent){
    if(event.kind==='tool'&&event.status==='running'){
      const input=event.input as {paper_ids?:unknown}|undefined;
      const papers=Array.isArray(input?.paper_ids)?input.paper_ids.filter((id):id is string=>typeof id==='string'):[];
      this.tools.set(event.id,{papers,tool:event.tool??''});
      if(event.tool==='retrieve_chunks')for(const item of this.value.items)if(item.id.startsWith('source:')&&papers.includes(item.paper_id!)){item.state='running';item.note='正在读取原文';}
    }else if(event.kind==='tool'){
      const call=this.tools.get(event.id);this.tools.delete(event.id);
      if(call?.tool==='retrieve_chunks'){
        let chunks:Chunk[]=[];try{const raw=JSON.parse(event.output?.text??'{}');if(Array.isArray(raw.chunks))chunks=raw.chunks.filter((row:unknown)=>row&&typeof row==='object'&&typeof (row as Chunk).paper_id==='string'&&typeof (row as Chunk).chunk_id==='string');}catch{/* 工具失败没有可用原文。 */}
        for(const paper of new Set([...call.papers,...chunks.map(chunk=>chunk.paper_id)])){
          let item=this.value.items.find(item=>item.id==='source:'+paper);
          if(!item&&chunks.some(chunk=>chunk.paper_id===paper)){item={id:'source:'+paper,paper_id:paper,label:'读取相关原文',state:'pending',source_ids:[],note:''};this.value.items.splice(1,0,item);}
          if(!item)continue;const ids=chunks.filter(chunk=>chunk.paper_id===paper&&typeof chunk.chunk_id==='string').map(chunk=>chunk.chunk_id);
          item.source_ids=[...new Set([...item.source_ids,...ids])];item.state=item.source_ids.length?'retrieved':'gap';item.note=item.source_ids.length?'已取得原文片段，等待逐项说明':event.status==='error'?'本次读取未成功':'本次检索未取得相关原文';
        }
      }
    }else if(event.kind==='model'&&event.phase==='agent'&&event.status==='running'){
      const answer=this.value.items.find(item=>item.id==='answer');if(answer){answer.state='running';answer.note='模型正在处理本轮任务';}
    }
    this.emit();
  }
  update(updates:readonly GoalUpdate[]|undefined,visible:ReadonlyMap<string,Chunk>,needsSources=true){
    for(const update of updates??[]){
      const item=this.value.items.find(item=>item.id===update.need_id&&item.paper_id===update.paper_id);if(!item||['understand','answer'].includes(item.id)||item.id.startsWith('source:'))continue;
      const ids=[...new Set(update.source_ids)].filter(id=>visible.has(id)&&(!item.paper_id||visible.get(id)?.paper_id===item.paper_id));
      if(update.status==='supported'&&needsSources&&!ids.length)continue;
      item.state=update.status==='working'?'running':update.status==='gap'?'gap':'answered';item.source_ids=ids;item.note=clip(update.note??'');
    }this.emit();
  }
  comparison(report:ComparisonReport){
    const previous=new Map(this.value.items.filter(item=>item.id.startsWith('cell:')).map(item=>[item.paper_id+'\n'+item.label,item]));
    this.value.items=this.value.items.filter(item=>!item.id.startsWith('cell:'));
    for(const [index,cell] of report.cells.entries()){const prior=previous.get(cell.paper_id+'\n'+cell.dimension),explained=cell.status==='supported'&&prior?.state==='answered'&&prior.source_ids.some(id=>cell.citations.includes(id));this.value.items.splice(this.value.items.length-1,0,{id:'cell:'+index,paper_id:cell.paper_id,label:cell.dimension,
      state:explained?'answered':cell.status==='supported'?'supported':cell.status==='partial'?'retrieved':cell.status==='missing'?'gap':'pending',source_ids:[...cell.citations],note:explained?prior!.note:cell.summary});}
    this.emit();
  }
  finish(execution:TurnExecution|undefined,answer:string,citedIds:readonly string[],stopped=false,failed=false){
    this.value.phase=stopped?'stopped':failed?'partial':execution?.state==='clarification'?'clarification':execution?.state==='complete'?'completed':'partial';
    const goals=this.value.items.filter(item=>!item.id.startsWith('source:')&&!item.id.startsWith('cell:')&&!['understand','answer'].includes(item.id));
    if(!stopped&&!failed&&execution?.state==='complete'&&goals.length===1){const goal=goals[0];if(execution.needs_sources===false||citedIds.length){goal.state='answered';goal.source_ids=[...citedIds];goal.note='本轮回答已说明；可点击回答中的引用核对原文';}}
    for(const item of this.value.items)if(item.state==='answered'&&item.source_ids.length&&!item.source_ids.some(id=>citedIds.includes(id))){item.state='supported';item.note='已有原文依据，最终回答未单独关联此项';}
    for(const item of this.value.items)if(item.state==='pending'||item.state==='running'){item.state=stopped?'stopped':'unconfirmed';item.note=stopped?'用户停止，本项尚未完成':'本轮未单独确认该项';}
    const final=this.value.items.find(item=>item.id==='answer');if(final){final.state=stopped?'stopped':answer?'answered':'unconfirmed';final.note=stopped?(answer?'已保留收到的回答':'已停止本轮请求'):answer?'回答已保存':'尚未形成回答';}
    this.emit();return this.snapshot();
  }
}
