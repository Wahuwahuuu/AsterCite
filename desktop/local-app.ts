import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT } from "../agent/assets.ts";
import { startWeb } from "../agent/web-server.ts";
import { RuntimeFailure } from "../agent/contracts.ts";
import { saveDesktopConfig } from "./configuration.ts";

export async function runLocal(args:string[],root=PROJECT_ROOT){
  if(args.length===1&&args[0]==="--configure"){
    let text="";for await(const part of process.stdin){text+=part;if(Buffer.byteLength(text)>16384)throw new RuntimeFailure("INVALID_CONFIG","设置内容过长。");}
    await saveDesktopConfig(root,JSON.parse(text));console.log("模型设置已保存。");return;
  }
  if(args.some(arg=>arg!=="--no-browser"))throw new RuntimeFailure("INVALID_INPUT","启动参数无效。");
  console.log("正在加载论文库、向量检索与重排模型…");
  const server=await startWeb(["--live"],root);
  if(!server)throw new RuntimeFailure("START_FAILED","本地服务未能启动。");
  const url="http://127.0.0.1:4173";
  console.log("可以自由提问了。关闭此窗口将停止服务；下次启动可继续对话。");
  if(!args.includes("--no-browser")&&process.platform==="win32"){
    const child=spawn("rundll32.exe",["url.dll,FileProtocolHandler",url],{shell:false,windowsHide:true,stdio:"ignore"});
    child.on("error",()=>console.log("请在浏览器打开 "+url));child.unref();
  }
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await runLocal(process.argv.slice(2));}
  catch(e){
    const code=e instanceof RuntimeFailure?e.code:(e as NodeJS.ErrnoException).code;
    const messages:Record<string,string>={MISSING_KEY:"请在启动窗口填写模型密钥。",INVALID_CONFIG:"模型设置有误，请检查服务地址、模型名称与容量。",EADDRINUSE:"4173 端口已被占用。请关闭另一份 AsterCite 后重试。",WORKER_START_ERROR:"检索环境无法启动，请重新安装。",WORKER_READY_TIMEOUT:"检索模型加载超时，请关闭占用内存的程序后重试。"};
    console.error(argsConfigure(process.argv.slice(2))&&e instanceof RuntimeFailure&&e.code==="INVALID_CONFIG"?e.message:messages[code??""]??"启动失败，请检查安装是否完整、模型是否已经下载。重新启动可以继续准备。");process.exitCode=1;
  }
}
function argsConfigure(args:string[]){return args.length===1&&args[0]==="--configure";}
