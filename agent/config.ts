import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type OpenAICompletionsCompat, type Model, type Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure, object } from "./contracts.ts";

export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface AppConfig {
  version: 1;
  model: { base_url: string; model_id: string; context_window: number; max_output_tokens: number;
    reasoning: boolean; thinking_level: ThinkingLevel; compat: OpenAICompletionsCompat };
  retrieval: { corpus_dir: string; index_dir: string; models_dir: string; profile: "dense"|"bm25"|"rrf"|"rrf_rerank"; device: "cuda"|"cpu" };
  session: { max_turns: number; request_timeout_ms: number; turn_timeout_ms: number; compaction: "native"|"off" };
}
function exact(v: Record<string, unknown>, keys: string[], label: string) {
  if (Object.keys(v).sort().join() !== keys.sort().join()) throw new RuntimeFailure("INVALID_CONFIG", label + " fields differ; credentials and arbitrary headers are forbidden");
}
function integer(v: unknown, min: number, max: number): v is number { return Number.isSafeInteger(v) && Number(v)>=min && Number(v)<=max; }
export function projectPath(root: string, path: string): string {
  const target=resolve(root,path), rel=relative(resolve(root),target);
  if (!path || isAbsolute(path) || rel===".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new RuntimeFailure("INVALID_PATH","Path must remain inside the project");
  return target;
}
/** Existing links must stay in the project; missing paths validate their nearest existing parent. */
export async function containedPath(root: string, path: string): Promise<string> {
  const target=projectPath(root,path), realRoot=await realpath(root);
  let probe=target;
  while (true) {
    try {
      const actual=await realpath(probe), rel=relative(realRoot,actual);
      if (rel===".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) throw new RuntimeFailure("INVALID_PATH","Linked path escapes the project");
      return target;
    } catch(e) {
      if ((e as NodeJS.ErrnoException).code!=="ENOENT") throw e;
      const parent=dirname(probe); if(parent===probe) throw e; probe=parent;
    }
  }
}
export function parseConfig(value: unknown): AppConfig {
  const v=object(value); exact(v,["version","model","retrieval","session"],"Config");
  if(v.version!==1)throw new RuntimeFailure("INVALID_CONFIG","Unsupported configuration version");
  const m=object(v.model),r=object(v.retrieval),s=object(v.session);
  exact(m,["base_url","model_id","context_window","max_output_tokens","reasoning","thinking_level","compat"],"Model");
  exact(r,["corpus_dir","index_dir","models_dir","profile","device"],"Retrieval");
  exact(s,["max_turns","request_timeout_ms","turn_timeout_ms","compaction"],"Session");
  let url: URL;
  try { url=new URL(m.base_url as string); } catch { throw new RuntimeFailure("INVALID_CONFIG","Fill model.base_url and model.model_id in configs/model.local.json"); }
  if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      url.protocol==="http:" && !["localhost","127.0.0.1","[::1]"].includes(url.hostname)) throw new RuntimeFailure("INVALID_CONFIG","Use HTTPS (HTTP only for localhost), without URL credentials/query/fragment");
  if (typeof m.model_id!=="string" || !m.model_id.trim() || m.model_id.length>200 || /[\r\n]/u.test(m.model_id) ||
      !integer(m.context_window,8192,2_000_000) || !integer(m.max_output_tokens,256,32768) || Number(m.max_output_tokens)>=Number(m.context_window) ||
      typeof m.reasoning!=="boolean" || !["off","minimal","low","medium","high","xhigh","max"].includes(m.thinking_level as string) ||
      !m.reasoning && m.thinking_level!=="off") throw new RuntimeFailure("INVALID_CONFIG","Invalid model capacity/reasoning; non-reasoning models require off");
  const compat=object(m.compat);
  const bools=["supportsStore","supportsDeveloperRole","supportsReasoningEffort","supportsUsageInStreaming","supportsFinishReason","requiresToolResultName","requiresAssistantAfterToolResult","zaiToolStream"];
  for(const [key,val] of Object.entries(compat)) {
    if(bools.includes(key) && typeof val==="boolean") continue;
    if(key==="maxTokensField" && ["max_tokens","max_completion_tokens"].includes(val as string)) continue;
    if(key==="thinkingFormat" && ["openai","openrouter","deepseek","together","baseten","zai","qwen","chat-template","qwen-chat-template","string-thinking","ant-ling"].includes(val as string)) continue;
    throw new RuntimeFailure("INVALID_CONFIG","Unsupported provider compatibility field");
  }
  if (m.reasoning && m.thinking_level!=="off" && compat.supportsReasoningEffort!==true) throw new RuntimeFailure("INVALID_CONFIG","Reasoning requires explicit provider support");
  if (![r.corpus_dir,r.index_dir,r.models_dir].every(p=>typeof p==="string" && !!p) ||
      !["dense","bm25","rrf","rrf_rerank"].includes(r.profile as string) || !["cuda","cpu"].includes(r.device as string) ||
      !integer(s.max_turns,1,1000) || !integer(s.request_timeout_ms,1000,300000) ||
      !integer(s.turn_timeout_ms,Number(s.request_timeout_ms),900000) || !["native","off"].includes(s.compaction as string)) throw new RuntimeFailure("INVALID_CONFIG","Invalid retrieval/session settings");
  return structuredClone(v) as unknown as AppConfig;
}
export async function readConfig(root: string, path="configs/model.local.json"): Promise<AppConfig> {
  return parseConfig(JSON.parse(await readFile(await containedPath(root,path),"utf8")));
}
export async function createUserRuntime(config: AppConfig["model"], apiKey: string): Promise<{runtime:ModelRuntime; model:Model<Api>}> {
  if (!apiKey.trim()) throw new RuntimeFailure("MISSING_KEY","Set PIPAPER_API_KEY in this terminal; do not put it in JSON");
  if(JSON.stringify(config).includes(apiKey))throw new RuntimeFailure("INVALID_CONFIG","Credentials must not appear in model configuration");
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerProvider("astercite-user", {baseUrl:config.base_url,api:"openai-completions",
    models:[{id:config.model_id,name:config.model_id,reasoning:config.reasoning && config.thinking_level!=="off",input:["text"],contextWindow:config.context_window,maxTokens:config.max_output_tokens,
      cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:config.compat}]});
  await runtime.setRuntimeApiKey("astercite-user",apiKey);
  const model=runtime.getModel("astercite-user",config.model_id);
  if(runtime.getError() || !model) throw new RuntimeFailure("MODEL_CONFIG_ERROR","Pi provider registration failed");
  return {runtime,model};
}
