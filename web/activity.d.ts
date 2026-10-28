import type {WebTurn,WebActivity,WebExecutionDetail} from '../agent/web-session.ts';
export type ReplayTurn=Pick<WebTurn,'question'|'status'|'elapsed_ms'>&Partial<WebTurn>;
export interface ExecutionStep {
  key:string;at:number;node:string;kind:string;moment:'start'|'end'|'point';title:string;status:string;
  id?:string;edge?:string;legacy?:boolean;item?:WebActivity;detail?:WebExecutionDetail;
}
export interface ExecutionTimeline {events:ExecutionStep[];duration:number;hasRecords:boolean}
export function executionTime(ms:number):string;
export function buildExecutionTimeline(turn:ReplayTurn,details?:Record<string,WebExecutionDetail>):ExecutionTimeline;
export function executionIndexAt(timeline:ExecutionTimeline,at:number):number;
export function executionDetailAt(detail:WebExecutionDetail|undefined,event:ExecutionStep):(WebExecutionDetail&{playback_pending?:boolean})|null;
