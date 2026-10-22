import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PROJECT_ROOT, loadAssets, createWorker, fileHash } from "./assets.ts";
import { readConfig, containedPath, sha } from "./config.ts";
import { RuntimeFailure, type Paper, type Chunk } from "./contracts.ts";
import { PaperWebSession, type WebSessionFactory, type WebSessionPort } from "./web-session.ts";

export interface WebServerOptions {
  root:string; mode:"demo"|"live"; factory?:WebSessionFactory; papers?:readonly Paper[];
  modelLabel?:string; accessToken?:string; publicOrigin?:string; maxSessions?:number;
}
const STATIC_FILES:Record<string,{file:string;type:string}>={
  "/":{file:"index.html",type:"text/html; charset=utf-8"},
  "/index.html":{file:"index.html",type:"text/html; charset=utf-8"},
  "/app.js":{file:"app.js",type:"text/javascript; charset=utf-8"},
  "/evidence-format.js":{file:"evidence-format.js",type:"text/javascript; charset=utf-8"},
  "/styles.css":{file:"styles.css",type:"text/css; charset=utf-8"},
  "/favicon.svg":{file:"favicon.svg",type:"image/svg+xml"},
  "/sample.json":{file:"sample.json",type:"application/json; charset=utf-8"},
  "/config.json":{file:"config.json",type:"application/json; charset=utf-8"}
};
const safeEqual=(a:string,b:string)=>timingSafeEqual(Buffer.from(sha(a),"hex"),Buffer.from(sha(b),"hex"));
function failure(code:string):{status:number;message:string}{
  const known:Record<string,{status:number;message:string}>={
    UNAUTHORIZED:{status:401,message:"请填写网站访问口令。"},FORBIDDEN:{status:403,message:"无法访问这个会话，请重新选择或新建会话。"},
    INVALID_ORIGIN:{status:403,message:"请求来源不匹配，请从网站页面操作。"},INVALID_INPUT:{status:400,message:"请检查输入内容，问题最多 12000 字。"},
    INVALID_SCOPE:{status:400,message:"请选择论文库中的论文。"},INVALID_CONFIG:{status:400,message:"当前配置不支持此操作，请检查配置文件。"},
    NOT_FOUND:{status:404,message:"页面或会话不存在。"},SESSION_LOCKED:{status:409,message:"会话正在处理问题，请稍后再操作。"},
    SESSION_BUDGET_EXCEEDED:{status:429,message:"当前会话已达到轮数上限，请新建会话。"},CAPACITY:{status:429,message:"网站当前较忙，请稍后再试。"},
    TOO_LARGE:{status:413,message:"输入内容过长。"},DEMO_ONLY:{status:409,message:"这里提供示例回放，完整问答请自行部署。"},
    INVALID_SESSION:{status:409,message:"会话文件无法读取，请新建会话。"},INVALID_BUDGET:{status:409,message:"会话配置已经变化，请新建会话。"},
    INVALID_SNAPSHOT:{status:409,message:"会话配置已经变化，请新建会话。"}
  };
  return known[code]??{status:502,message:"问答未完成，请检查模型服务或稍后重试。"};
}
function headers(res:ServerResponse){
  res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader("Cache-Control","no-store");
}
function json(res:ServerResponse,status:number,value:unknown){res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(value));}
async function body(req:IncomingMessage):Promise<Record<string,unknown>>{
  if(!String(req.headers["content-type"]).startsWith("application/json"))throw new RuntimeFailure("INVALID_INPUT","JSON required");
  const parts:Buffer[]=[];let size=0;
  for await(const part of req){size+=Buffer.byteLength(part);if(size>60000)throw new RuntimeFailure("TOO_LARGE","Body too large");parts.push(Buffer.from(part));}
  let v:unknown;try{v=JSON.parse(Buffer.concat(parts).toString("utf8"));}catch{throw new RuntimeFailure("INVALID_INPUT","Invalid JSON");}
  if(!v||typeof v!=="object"||Array.isArray(v))throw new RuntimeFailure("INVALID_INPUT","Object required");return v as Record<string,unknown>;
}
function only(v:Record<string,unknown>,keys:string[]){if(Object.keys(v).some(k=>!keys.includes(k)))throw new RuntimeFailure("INVALID_INPUT","Unexpected fields");}

export async function createWebServer(options:WebServerOptions){
  const sessionPath=await containedPath(options.root,".local/web/sessions");
  if(options.mode==="live")await mkdir(sessionPath,{recursive:true});
  let processing=false,creating=false;
  const server=createServer(async(req,res)=>{
    headers(res);
    try{
      const host=String(req.headers.host??"");
      const address=server.address();
      const allowedHost=options.publicOrigin?new URL(options.publicOrigin).host:address&&typeof address==="object"?"127.0.0.1:"+address.port:"";
      if(![allowedHost,allowedHost.replace("127.0.0.1","localhost"),allowedHost.replace("127.0.0.1","[::1]")].includes(host))throw new RuntimeFailure("INVALID_ORIGIN","Host differs");
      const url=new URL(req.url??"/","http://"+host),method=req.method??"GET";
      if(url.search)throw new RuntimeFailure("INVALID_INPUT","Query not supported");
      if(method==="GET"&&url.pathname==="/healthz"){json(res,200,{status:"ok",mode:options.mode});return;}
      if(method==="GET"&&url.pathname==="/api/config"){
        json(res,200,{mode:options.mode,model:options.modelLabel??null,access_token_required:!!options.accessToken,
          papers:options.papers?.map(p=>({paper_id:p.paper_id,title:p.title}))??[]});return;
      }
      if(method==="GET"&&STATIC_FILES[url.pathname]){
        const asset=STATIC_FILES[url.pathname],bytes=await readFile(await containedPath(options.root,"web/"+asset.file));
        res.writeHead(200,{"Content-Type":asset.type});res.end(bytes);return;
      }
      if(!url.pathname.startsWith("/api/"))throw new RuntimeFailure("NOT_FOUND","No route");
      if(options.mode!=="live"||!options.factory)throw new RuntimeFailure("DEMO_ONLY","Replay only");
      if(options.accessToken&&!safeEqual(String(req.headers.authorization??""),"Bearer "+options.accessToken))throw new RuntimeFailure("UNAUTHORIZED","Missing access token");
      if(method!=="GET"){
        const origin=options.publicOrigin??"http://"+host;
        if(req.headers.origin!==origin||req.headers["x-astercite-request"]!=="1")throw new RuntimeFailure("INVALID_ORIGIN","Origin required");
      }
      if(method==="POST"&&url.pathname==="/api/sessions"){
        const v=await body(req);only(v,[]);
        if(creating)throw new RuntimeFailure("CAPACITY","Creation busy");creating=true;
        try{
          if((await readdir(sessionPath)).length>=(options.maxSessions??100))throw new RuntimeFailure("CAPACITY","Session limit");
          const id=randomUUID(),token=randomBytes(32).toString("hex"),dir=await containedPath(options.root,".local/web/sessions/"+id);
          await mkdir(dir);await writeFile(join(dir,"owner.json"),JSON.stringify({token_digest:sha(token),created_at:new Date().toISOString()}),{flag:"wx"});
          json(res,201,{id,token});return;
        }finally{creating=false;}
      }
      const match=/^\/api\/sessions\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:\/(question|settings))?$/u.exec(url.pathname);
      if(!match)throw new RuntimeFailure("NOT_FOUND","No session route");
      const dir=await containedPath(options.root,".local/web/sessions/"+match[1]);
      let owner:{token_digest:string};try{owner=JSON.parse(await readFile(await containedPath(dir,"owner.json"),"utf8"));}catch{throw new RuntimeFailure("NOT_FOUND","Missing session");}
      const token=String(req.headers["x-astercite-session"]??"");
      if(!token||!safeEqual(owner.token_digest,sha(token)))throw new RuntimeFailure("FORBIDDEN","Session owner differs");
      if(processing)throw new RuntimeFailure("SESSION_LOCKED","A question is running");
      let action:"view"|"ask"|"settings";
      if(method==="GET"&&!match[2])action="view";
      else if(method==="POST"&&match[2]==="question")action="ask";
      else if(method==="POST"&&match[2]==="settings")action="settings";
      else throw new RuntimeFailure("NOT_FOUND","Unsupported method");
      let input:Record<string,unknown>={};
      if(action!=="view"){
        input=await body(req);
        only(input,action==="ask"?["question"]:["scope","compact"]);
        if(action==="ask"&&(typeof input.question!=="string"||!input.question.trim()||Array.from(input.question).length>12000))throw new RuntimeFailure("INVALID_INPUT","Invalid question");
        if(action==="settings"&&(!Array.isArray(input.scope)||input.scope.length>1000||input.scope.some(id=>typeof id!=="string")||typeof input.compact!=="boolean"))throw new RuntimeFailure("INVALID_INPUT","Invalid settings");
      }
      // One inference at a time shares one retrieval worker without loading weights per visitor.
      if(processing)throw new RuntimeFailure("SESSION_LOCKED","A question is running");processing=true;
      let session:WebSessionPort|undefined;
      try{
        // Resolve all existing private subpaths too, before the adapter can open them.
        for(const sub of ["ledger","turns","checkpoints","session.lock"])await containedPath(dir,sub);
        session=await options.factory(dir);
        const value=action==="ask"?await session.ask(input.question as string):action==="settings"?await session.configure(input.scope as string[],input.compact as boolean):await session.view();
        json(res,200,value);
      }finally{try{await session?.close();}finally{processing=false;}}
    }catch(e){
      const code=e instanceof RuntimeFailure?e.code:(e as NodeJS.ErrnoException).code==="ENOENT"?"NOT_FOUND":"RUNTIME_ERROR";
      const f=failure(code);if(!res.headersSent)json(res,f.status,{error:f.message,code});else res.end();
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;
  return server;
}
export function parseWebArgs(args:string[]){
  const out={live:false,host:"127.0.0.1",port:4173,config:"configs/model.local.json",help:false};
  for(let i=0;i<args.length;i++){
    const key=args[i];if(key==="--live"){out.live=true;continue;}if(key==="--demo")continue;
    if(key==="--help"||key==="-h"){out.help=true;continue;}
    if(!["--host","--port","--config"].includes(key)||!args[i+1]||args[i+1].startsWith("--"))throw new RuntimeFailure("INVALID_INPUT","Use --help");
    const v=args[++i];if(key==="--host")out.host=v;else if(key==="--config")out.config=v;else out.port=Number(v);
  }
  if(!["127.0.0.1","0.0.0.0"].includes(out.host)||!Number.isInteger(out.port)||out.port<1||out.port>65535)throw new RuntimeFailure("INVALID_INPUT","Invalid host/port");
  return out;
}
export async function startWeb(args:string[],root=PROJECT_ROOT){
  const flags=parseWebArgs(args);if(flags.help){console.log("npm run web -- [--demo | --live] [--port 4173] [--config configs/model.local.json]\n本机默认 127.0.0.1；公网部署见 docs/web.md。");return;}
  const accessToken=process.env.ASTERCITE_WEB_TOKEN,publicOrigin=process.env.ASTERCITE_WEB_ORIGIN;
  if(flags.host!=="127.0.0.1"&&(!accessToken||accessToken.length<32||!publicOrigin))throw new RuntimeFailure("INVALID_CONFIG","Public binding requires ASTERCITE_WEB_TOKEN (32+ characters) and ASTERCITE_WEB_ORIGIN");
  if(publicOrigin){const url=new URL(publicOrigin);if(url.origin!==publicOrigin||url.protocol!=="https:")throw new RuntimeFailure("INVALID_CONFIG","Public origin must be an HTTPS origin");}
  let worker:Awaited<ReturnType<typeof createWorker>>|undefined;
  try{
    const options:WebServerOptions={root,mode:flags.live?"live":"demo",accessToken,publicOrigin};
    if(flags.live){
      const key=process.env.PIPAPER_API_KEY??"";if(!key.trim())throw new RuntimeFailure("MISSING_KEY","Set PIPAPER_API_KEY before starting live questions");
      const config=await readConfig(root,flags.config),assets=await loadAssets(root,config);
      // Isolate website sessions from existing CLI and evaluation identities.
      assets.implementationId=sha(JSON.stringify({base:assets.implementationId,web:[await fileHash(join(root,"agent/web-session.ts")),await fileHash(join(root,"agent/web-server.ts"))]}));
      worker=await createWorker(assets,config);
      const sourceRows=(await readFile(join(root,config.retrieval.index_dir,"chunks.jsonl"),"utf8")).split(/\r?\n/u).filter(Boolean).map(s=>JSON.parse(s) as Chunk);
      const sources=new Map(sourceRows.map(c=>[c.chunk_id,c]));
      options.factory=directory=>PaperWebSession.open({directory,assets,config,worker:worker!,sources,key});
      options.papers=assets.publicPapers;options.modelLabel=config.model.model_id;
    }
    const server=await createWebServer(options);
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(flags.port,flags.host,()=>resolve());});
    console.log(`AsterCite | ${flags.live?"完整问答":"示例回放"} | ${publicOrigin??"http://127.0.0.1:"+flags.port}`);
    const close=()=>{server.close(()=>{worker?.close();});server.closeIdleConnections();};
    process.once("SIGINT",close);process.once("SIGTERM",close);return server;
  }catch(e){worker?.close();throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{await startWeb(process.argv.slice(2));}catch(e){console.error(e instanceof RuntimeFailure?failure(e.code).message:"网页服务启动失败，请检查环境与配置。");process.exitCode=1;}
}
