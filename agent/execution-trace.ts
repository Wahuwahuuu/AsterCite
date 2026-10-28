import { redactText } from "./contracts.ts";

export interface TraceMessage { role:string; text:string; tool_call_id?:string; tool_name?:string; tool_calls?:Array<{id:string;name:string;arguments:unknown}> }
export interface TraceInput { format:"provider_payload"|"sdk_context"; messages:TraceMessage[]; tools:Array<{name:string;description:string;parameters:unknown}>; settings:Record<string,string|number|boolean> }
export interface TraceOutput { text:string; tool_calls:Array<{id:string;name:string;arguments:unknown}>; stop_reason?:string }
export interface ExecutionEvent {
  id:string;kind:"model"|"tool"|"compaction";status:"running"|"completed"|"error";stage:string;phase:string;
  parent_id?:string;origin?:"model"|"host_plan";tool?:"search_papers"|"retrieve_chunks";
  input?:TraceInput|Record<string,unknown>;output?:TraceOutput;elapsed_ms?:number;
}
const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
const str=(v:unknown)=>typeof v==="string"?v:"";
export function traceArguments(value:unknown):Record<string,unknown>{
  let raw=value;if(typeof raw==="string")try{raw=JSON.parse(raw);}catch{return {invalid_json:true};}
  const source=obj(raw),result:Record<string,unknown>={};
  for(const key of ["query","paper_ids","top_k","limit","section","content_type","offset"]){if(Object.hasOwn(source,key))result[key]=source[key];}return result;
}
function calls(v:unknown):TraceOutput["tool_calls"]{
  return Array.isArray(v)?v.flatMap(raw=>{const b=obj(raw),f=obj(b.function);const name=str(f.name)||str(b.name);if(!["search_papers","retrieve_chunks"].includes(name))return [];
    return [{id:str(b.id),name,arguments:traceArguments(f.arguments??b.arguments??{})}];}):[];
}
function message(v:unknown):TraceMessage{
  const m=obj(v),content=m.content;
  const text=typeof content==="string"?content:Array.isArray(content)?content.flatMap(raw=>{const b=obj(raw);return ["text","input_text","output_text"].includes(str(b.type))?[str(b.text)]:[];}).join("\n"):"";
  const toolCalls=calls(m.tool_calls??(Array.isArray(content)?content.filter(b=>obj(b).type==="toolCall"):[]));
  return {role:str(m.role),text,...(typeof m.tool_call_id==="string"?{tool_call_id:m.tool_call_id}:typeof m.toolCallId==="string"?{tool_call_id:m.toolCallId}:{}),
    ...(typeof m.name==="string"?{tool_name:m.name}:typeof m.toolName==="string"?{tool_name:m.toolName}:{}),...(toolCalls.length?{tool_calls:toolCalls}:{})};
}
/** Explicit message fields only: no headers, reasoning blocks, signatures or provider frames. */
export function traceInput(value:unknown,format:TraceInput["format"],secrets:readonly string[]=[]):TraceInput{
  const v=obj(value),settings:TraceInput["settings"]={};
  for(const key of ["model","max_tokens","max_completion_tokens","temperature","reasoning_effort","stream"]){const x=v[key];if(["string","number","boolean"].includes(typeof x))settings[key]=x as string|number|boolean;}
  const tools=Array.isArray(v.tools)?v.tools.flatMap(raw=>{const b=obj(raw),f=obj(b.function??b),name=str(f.name);return ["search_papers","retrieve_chunks"].includes(name)?[{name,description:str(f.description),parameters:f.parameters??{}}]:[];}):[];
  const result={format,messages:Array.isArray(v.messages)?v.messages.map(message):[],tools,settings};
  return JSON.parse(redactText(JSON.stringify(result),secrets)) as TraceInput;
}
export function traceOutput(value:unknown,secrets:readonly string[]=[]):TraceOutput{
  const v=obj(value),projected=message(v);
  return JSON.parse(redactText(JSON.stringify({text:projected.text,tool_calls:projected.tool_calls??[],...(typeof v.stopReason==="string"?{stop_reason:v.stopReason}:{})}),secrets)) as TraceOutput;
}
