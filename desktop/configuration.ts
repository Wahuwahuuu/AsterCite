import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig, containedPath, type AppConfig, type ThinkingLevel } from "../agent/config.ts";
import { RuntimeFailure, object } from "../agent/contracts.ts";

/** This boundary deliberately accepts no credential or arbitrary header fields. */
export async function desktopConfig(root:string, input:unknown):Promise<AppConfig>{
  const value=object(input);
  const fields=["base_url","model_id","context_window","max_output_tokens","protocol","thinking_level"];
  if(Object.keys(value).sort().join()!==fields.sort().join()||!["openai","zai"].includes(String(value.protocol)))
    throw new RuntimeFailure("INVALID_CONFIG","请检查模型设置。密钥只能在启动时提供。");
  const resources=JSON.parse(await readFile(join(root,"desktop/resources/manifest.json"),"utf8"));
  if(!/^artifacts\/bundled-cpu\/pipaper-full-index-v1-[a-f0-9]{16}$/u.test(resources.index_dir))
    throw new RuntimeFailure("INVALID_INDEX","论文库未准备好，请重新安装。");
  const template=JSON.parse(await readFile(join(root,"configs/model.example.json"),"utf8")) as AppConfig;
  const thinking=value.thinking_level as ThinkingLevel;
  if(value.protocol==="zai"&&/^glm-5\.3(?:-|$)/iu.test(String(value.model_id))&&!["low","high","max"].includes(thinking))
    throw new RuntimeFailure("INVALID_CONFIG","GLM-5.3 的推理强度请选择 low、high 或 max。");
  template.model={base_url:String(value.base_url).trim(),model_id:String(value.model_id).trim(),
    context_window:Number(value.context_window),max_output_tokens:Number(value.max_output_tokens),
    reasoning:thinking!=="off",thinking_level:thinking,
    compat:{supportsStore:false,supportsDeveloperRole:false,supportsReasoningEffort:thinking!=="off",
      supportsUsageInStreaming:true,maxTokensField:"max_tokens",thinkingFormat:value.protocol==="zai"?"zai":"openai",
      ...(value.protocol==="zai"?{zaiToolStream:true}:{})}};
  template.retrieval={corpus_dir:"data/full-v1/corpus",index_dir:resources.index_dir,models_dir:".cache/models",profile:"rrf_rerank",device:"cpu"};
  template.session={max_turns:100,request_timeout_ms:120000,turn_timeout_ms:600000,compaction:"native"};
  return parseConfig(template);
}

export async function saveDesktopConfig(root:string,input:unknown){
  const config=await desktopConfig(root,input);
  const key=process.env.PIPAPER_API_KEY;
  if(key&&JSON.stringify(config).includes(key))throw new RuntimeFailure("INVALID_CONFIG","模型设置中不能包含密钥。");
  const path=await containedPath(root,"configs/model.local.json"),temporary=await containedPath(root,"configs/model.local.json.partial");
  await mkdir(join(root,"configs"),{recursive:true});
  await writeFile(temporary,JSON.stringify(config,null,2)+"\n",{mode:0o600});await rename(temporary,path);
  return config;
}
