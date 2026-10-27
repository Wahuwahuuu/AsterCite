import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { containedPath } from "./config.ts";
import { RuntimeFailure } from "./contracts.ts";

const MAX_PDF = 30 * 1024 * 1024;
export const isArxivId = (id:string) => /^\d{4}\.\d{4,5}$/u.test(id);
export const originalPdfUrl = (id:string) => isArxivId(id) ? `https://arxiv.org/pdf/${id}v1` : null;
const valid = (bytes:Buffer) => bytes.length > 5 && bytes.length <= MAX_PDF && bytes.subarray(0,5).toString() === "%PDF-";

/** Only catalog IDs can reach this fixed-origin cache; callers cannot supply URLs. */
export class PaperPdfCache {
  private pending = new Map<string,Promise<Buffer>>();
  private root:string;
  private ids:ReadonlySet<string>;
  private download:typeof fetch;
  constructor(root:string,ids:ReadonlySet<string>,download:typeof fetch=fetch){this.root=root;this.ids=ids;this.download=download;}
  get(id:string):Promise<Buffer>{
    if(!this.ids.has(id)||!isArxivId(id))return Promise.reject(new RuntimeFailure("NOT_FOUND","Unknown paper"));
    const existing=this.pending.get(id);if(existing)return existing;
    const promise=this.load(id).finally(()=>this.pending.delete(id));this.pending.set(id,promise);return promise;
  }
  private async load(id:string):Promise<Buffer>{
    const directory=await containedPath(this.root,".cache/papers");await mkdir(directory,{recursive:true});
    const target=await containedPath(this.root,`.cache/papers/${id}v1.pdf`);
    try{const saved=await readFile(target);if(valid(saved))return saved;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    const signal=AbortSignal.timeout(45000);let url=originalPdfUrl(id)!;
    let response:Response|undefined;
    for(let redirect=0;redirect<4;redirect++){
      response=await this.download(url,{redirect:"manual",signal,headers:{Accept:"application/pdf"}});
      if(![301,302,303,307,308].includes(response.status))break;
      const next=new URL(response.headers.get("location")??"",url);
      await response.body?.cancel();
      if(next.protocol!=="https:"||!["arxiv.org","export.arxiv.org"].includes(next.hostname)||next.username||next.password||next.port)throw new RuntimeFailure("PDF_UNAVAILABLE","Unexpected PDF source");
      url=next.href;
    }
    if(!response?.ok||Number(response.headers.get("content-length")??0)>MAX_PDF)throw new RuntimeFailure("PDF_UNAVAILABLE","PDF download failed");
    const chunks:Buffer[]=[];let size=0;
    if(!response.body)throw new RuntimeFailure("PDF_UNAVAILABLE","Missing PDF body");
    const reader=response.body.getReader();
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_PDF)throw new RuntimeFailure("PDF_UNAVAILABLE","PDF too large");chunks.push(Buffer.from(value));}}
    finally{await reader.cancel().catch(()=>{});}
    const bytes=Buffer.concat(chunks);if(!valid(bytes))throw new RuntimeFailure("PDF_UNAVAILABLE","Invalid PDF response");
    const temp=join(directory,`${id}.${randomUUID()}.partial`);
    try{await writeFile(temp,bytes,{flag:"wx"});await rename(temp,target);}finally{await rm(temp,{force:true});}
    return bytes;
  }
}
