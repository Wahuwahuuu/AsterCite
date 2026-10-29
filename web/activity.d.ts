import type {WebTurn,WebActivity,WebExecutionDetail} from '../agent/web-session.ts';
export type ReplayTurn=Pick<WebTurn,'question'|'status'|'elapsed_ms'>&Partial<WebTurn>;
export interface ExecutionStep {
  key:string;at:number;node:string;kind:string;moment:'start'|'end'|'point';title:string;status:string;
  id?:string;edge?:string;legacy?:boolean;item?:WebActivity;detail?:WebExecutionDetail;
}
export interface ExecutionTimeline {events:ExecutionStep[];duration:number;hasRecords:boolean}
export function executionTime(ms:number):string;
export function readQuestionStream(response:Response,onActivity:(event:WebActivity)=>void,onAnswer?:(update:import('../agent/answer-stream.ts').AnswerUpdate&{sources:import('../agent/web-session.ts').WebSource[];context?:import('../agent/workbench-context.ts').ContextView})=>void,onTasks?:(progress:import('../agent/task-progress.ts').TaskProgress)=>void):Promise<import('../agent/web-session.ts').WebView>;
export function buildExecutionTimeline(turn:ReplayTurn,details?:Record<string,WebExecutionDetail>):ExecutionTimeline;
export function executionIndexAt(timeline:ExecutionTimeline,at:number):number;
export function executionNodeIndex(timeline:ExecutionTimeline,node:string,after?:number):number;
export function revealExecutionEvent(list:Pick<HTMLElement,'scrollTop'|'clientTop'|'clientHeight'|'getBoundingClientRect'>,item:Pick<HTMLElement,'getBoundingClientRect'>|undefined):void;
export function executionDetailAt(detail:WebExecutionDetail|undefined,event:ExecutionStep):(WebExecutionDetail&{playback_pending?:boolean})|null;
export interface ExecutionBatchCall {key:string;id?:string;tool:string;query:string;identity:string|null}
export interface ExecutionBatch {id:string;origin:'model'|'host_plan'|'unknown';linked:boolean;parent_id?:string;stage:string;calls:ExecutionBatchCall[];declared:ExecutionBatchCall[]}
export interface ExecutionBatchView {
  batch:ExecutionBatch;calls:Array<Omit<ExecutionBatchCall,'identity'>&{status:'queued'|'running'|'completed'|'error'|'unexecuted';planned:boolean;start?:ExecutionStep;end?:ExecutionStep}>;
  known_total:boolean;total:number|null;returned:number;started:number;running:number;parallel:boolean;complete:boolean;failed:number;
}
export function buildExecutionBatches(turn:ReplayTurn,details?:Record<string,WebExecutionDetail>):ExecutionBatch[];
export function executionBatchAt(timeline:ExecutionTimeline,batches:ExecutionBatch[],index:number):ExecutionBatchView|null;
export function buildExecutionGraph(timeline:ExecutionTimeline,batches:ExecutionBatch[]):ExecutionTimeline;
