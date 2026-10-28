import {randomUUID} from 'node:crypto';
import {traceInput,type TraceInput} from './execution-trace.ts';
import type {ObservedUsage} from './ledger.ts';
import {normalizeContext,getCurrentSystemMessage,getCurrentSystemPrompt,getCurrentTools,type Message,type Context,type TranscriptContext} from '@earendil-works/pi-ai';

export const CONTEXT_POLICY='workbench-context-v3';
export function compactionPolicy(window:number){
  const threshold=Math.ceil(window*.7);
  return {version:CONTEXT_POLICY,threshold_percent:70,threshold_tokens:threshold,reserve_tokens:window-threshold,keep_recent_tokens:Math.min(8192,Math.max(256,Math.floor(window*.25)))};
}
/** Output allocation is per request, rather than the cumulative billed token count. */
export function requestCapacity(inputTokens:number,window:number,requestedOutput:number,modelOutput=requestedOutput){
  const safety=Math.min(4096,Math.max(256,Math.ceil(window*.125)));
  const output=Math.max(1,Math.floor(Math.min(requestedOutput,modelOutput)));
  const available=Math.max(0,Math.floor(window-inputTokens-safety));
  return {input_tokens:inputTokens,requested_output_tokens:output,safety_tokens:safety,
    input_limit:Math.max(0,window-output-safety),max_output_tokens:Math.min(output,available),
    fits:inputTokens+output+safety<=window};
}
/** A replaced evidence workspace invalidates the SDK's old prefix-usage shortcut. */
export function providerContext(context:TranscriptContext):TranscriptContext{
  return {...context,messages:context.messages.map(message=>message.role==='assistant'?{...message,
    usage:{...message.usage,input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0}}:message)};
}
export interface ContextSample {tokens:number;basis:'provider'|'estimate';stage:string;updated_at:string;input_tokens?:number;output_tokens?:number}
export interface CompressionRecord {id:string;reason:string;status:'completed'|'unchanged'|'error';started_at:string;finished_at:string;before_tokens:number;after_tokens:number;before_messages:number;after_messages:number;summary:string;note:string}
export interface ContextState {latest?:ContextSample;last_request?:ContextSample;compressions:CompressionRecord[]}
export interface ContextView {window_tokens:number;used_tokens:number|null;remaining_tokens:number|null;percent:number|null;basis:'provider'|'estimate'|'unknown';stage:string|null;updated_at:string|null;auto_enabled:boolean;policy:ReturnType<typeof compactionPolicy>;compressions:CompressionRecord[]}
const textTokens=(text:string)=>{const wide=[...text].filter(ch=>(ch.codePointAt(0)??0)>255).length;return Math.ceil((text.length-wide)/4+wide);};
/** Visible request fields only; hidden reasoning and credentials never enter telemetry. */
export function estimateVisibleContext(value:unknown):number{
  const source=value as Partial<TraceInput>;
  let input:TraceInput;
  if(source.format&&source.messages?.every(message=>typeof message.text==='string'))input=source as TraceInput;
  else{
    const context=normalizeContext(value as Context),system=getCurrentSystemMessage(context.messages);
    input=traceInput({messages:[...(system?[{...system,content:getCurrentSystemPrompt(context.messages)}]:[]),...context.messages.filter(message=>message.role!=='system')],tools:getCurrentTools(context.messages)},'sdk_context');
  }
  return input.messages.reduce((n,m)=>n+6+textTokens(m.text)+textTokens(JSON.stringify(m.tool_calls??[])),0)+textTokens(JSON.stringify(input.tools));
}
/** One projection supplies both the actual main request and the session meter. */
export function sessionContextInput(messages:readonly Message[],memory?:unknown,instruction=''){
  return normalizeContext({messages:[...messages,...(memory?[{role:'system' as const,content:JSON.stringify(memory),timestamp:0}]:[]),...(instruction?[{role:'system' as const,content:instruction,timestamp:0}]:[])]});
}
export function reachedContextThreshold(tokens:number,window:number):boolean{return tokens>=compactionPolicy(window).threshold_tokens;}
export class ContextTracker {
  readonly state:ContextState;
  private active?:{reason:string;started_at:string;tokens:number;messages:number};
  constructor(saved?:ContextState){this.state=structuredClone(saved??{compressions:[]});}
  request(input:TraceInput,stage:string){this.state.last_request={tokens:estimateVisibleContext(input),basis:'estimate',stage,updated_at:new Date().toISOString()};}
  retain(input:unknown,stage='session'){this.state.latest={tokens:estimateVisibleContext(input),basis:'estimate',stage,updated_at:new Date().toISOString()};}
  response(usage:ObservedUsage,stage:string){
    if(usage.input===null||usage.output===null)return;
    const input=usage.input+(usage.cacheRead??0)+(usage.cacheWrite??0);
    this.state.last_request={tokens:input+usage.output,basis:'provider',stage,updated_at:new Date().toISOString(),input_tokens:input,output_tokens:usage.output};
  }
  begin(reason:string,tokens:number,messages:number){this.active={reason,started_at:new Date().toISOString(),tokens,messages};}
  end(tokens:number,messages:number,summary:string,status:CompressionRecord['status'],note:string){
    const before=this.active;if(!before)return;this.active=undefined;
    this.state.compressions.push({id:randomUUID(),reason:before.reason,status,started_at:before.started_at,finished_at:new Date().toISOString(),before_tokens:before.tokens,after_tokens:tokens,before_messages:before.messages,after_messages:messages,summary,note});
    this.state.compressions=this.state.compressions.slice(-30);
    this.state.latest={tokens,basis:'estimate',stage:'compaction',updated_at:new Date().toISOString()};
  }
  view(window:number,enabled:boolean):ContextView{
    const sample=this.state.latest,tokens=sample?.tokens??null;
    return {window_tokens:window,used_tokens:tokens,remaining_tokens:tokens===null?null:Math.max(0,window-tokens),percent:tokens===null?null:tokens/window*100,basis:sample?.basis??'unknown',stage:sample?.stage??null,updated_at:sample?.updated_at??null,auto_enabled:enabled,policy:compactionPolicy(window),compressions:structuredClone(this.state.compressions)};
  }
}
