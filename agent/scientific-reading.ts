import {readFile} from 'node:fs/promises';
import {containedPath,sha} from './config.ts';
import {RuntimeFailure,codepoints,type Chunk,type EvidenceIdentity,type ScientificReadingPort,type ScientificParams,type RetrieveResult,type WorkerTransport,type P2HarnessConfig} from './contracts.ts';

export function scientificContentType(question:string,query=''):'table'|'equation'|'all'|undefined{
  const text=(question+' '+query).replace(/(?:用|以)(?:一个|一张)?表格(?:的形式|形式)?(?:总结|整理|展示|回答|呈现|对比|比较|说明)?|(?:输出|生成|整理成|做成)(?:一个|一张)?表格|(?:不要|不用|不需要)(?:表格|公式)|(?:answer|present|summari[sz]e|output)\s+(?:in|as|with)\s+(?:a\s+)?table/giu,'');
  const equation=/公式|方程|数学表达|\b(?:equations?|formulae?|formulas?|objective function|loss function)\b/iu.test(text),table=/表格|(?:表|table)\s*\d+|\b(?:tables?|tabular)\b/iu.test(text);
  return equation&&table?'all':equation?'equation':table?'table':undefined;
}

/** Runtime-only source registry. The base corpus and retrieval artifacts stay immutable. */
export class ScientificReading implements ScientificReadingPort {
  readonly sources=new Map<string,Chunk>();readonly identities=new Map<string,EvidenceIdentity>();
  private root:string;private index:string;private papers:ReadonlySet<string>;private worker:WorkerTransport;
  private constructor(root:string,index:string,papers:ReadonlySet<string>,worker:WorkerTransport){this.root=root;this.index=index;this.papers=papers;this.worker=worker;}
  static async open(root:string,index:string,papers:ReadonlySet<string>,worker:WorkerTransport):Promise<ScientificReading>{
    const reader=new ScientificReading(root,index,papers,worker);
    await Promise.all([...papers].filter(id=>/^\d{4}\.\d{4,5}$/u.test(id)).map(id=>reader.cached(id).catch(error=>{if(!(error instanceof RuntimeFailure&&error.code==='INVALID_INDEX')&&!(error instanceof SyntaxError))throw error;})));return reader;
  }
  private async cached(paper:string):Promise<void>{
    const directory=`.cache/scientific-reading/${sha(this.index).slice(0,16)}`;
    try{
      const manifestPath=await containedPath(this.root,`${directory}/${paper}.json`),originalPath=await containedPath(this.root,`${directory}/${paper}.html`);
      const bytes=await readFile(manifestPath);if(bytes.length>8*1024*1024)throw new RuntimeFailure('INVALID_INDEX','Scientific source cache is oversized');
      const data=JSON.parse(bytes.toString()),original=await readFile(originalPath);
      if(data.version!=='scientific-html-v1'||data.index_version!==this.index||data.paper_id!==paper||!Array.isArray(data.blocks)||data.blocks.length>512||original.length>8*1024*1024||sha(original)!==data.original_sha256)throw new RuntimeFailure('INVALID_INDEX','Scientific source cache is inconsistent');
      if(sha(JSON.stringify(data.blocks))!==data.blocks_sha256)throw new RuntimeFailure('INVALID_INDEX','Scientific source blocks changed');
      let url:URL;try{url=new URL(data.source_url);}catch{throw new RuntimeFailure('INVALID_INDEX','Scientific source URL is invalid');}
      if(url.protocol!=='https:'||url.username||url.password||url.port||!['arxiv.org','ar5iv.labs.arxiv.org'].includes(url.hostname)||!url.pathname.includes(paper+'v1'))throw new RuntimeFailure('INVALID_INDEX','Scientific source URL differs');
      const parsed:Chunk[]=[];
      for(const [position,block] of data.blocks.entries()){
        if(typeof block.text!=='string'||!block.text.trim()||codepoints(block.text)>16000||!['table','equation'].includes(block.kind)||typeof block.section!=='string'||typeof block.locator!=='string'||block.locator.length>300)throw new RuntimeFailure('INVALID_INDEX','Invalid structured source block');
        const end=codepoints(block.text),base=`${paper}:scientific-v1:${data.original_sha256.slice(0,16)}:${position}`,chunk_id=`${this.index}:scientific-v1:${paper}:${data.original_sha256.slice(0,16)}:${position}:c0-${end}`;
        parsed.push({paper_id:paper,paragraph_id:base,chunk_id,section:block.section,text:block.text,start:0,end,index_version:this.index,citation:`[${chunk_id}]`,truncated:false,format:'markdown',content_type:block.kind,source_url:data.source_url+(block.locator?'#'+block.locator:'')});
      }
      for(const chunk of parsed){this.sources.set(chunk.chunk_id,chunk);this.identities.set(chunk.chunk_id,{paper_id:paper,paragraph_id:chunk.paragraph_id,chunk_id:chunk.chunk_id,start:0,end:chunk.end,index_version:this.index,text_sha256:sha(chunk.text)});}
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  }
  async retrieve(params:ScientificParams,signal?:AbortSignal):Promise<RetrieveResult>{
    if(params.paper_ids.some(id=>!this.papers.has(id)))throw new RuntimeFailure('INVALID_SCOPE','Unknown structured-reading paper');
    if(!this.worker.readScientificSources)return {backend:'scientific-html-v1',index_version:this.index,chunks:[],reading_note:'结构化原文阅读暂不可用，请使用已取得的文本并说明表格或公式缺口。'};
    const raw=await this.worker.readScientificSources(params,signal) as RetrieveResult;
    if(raw.index_version!==this.index||raw.backend!=='scientific-html-v1'||!Array.isArray(raw.chunks)||raw.chunks.length>params.top_k)throw new RuntimeFailure('INVALID_RESPONSE','Invalid structured-reading result');
    await Promise.all(params.paper_ids.map(id=>this.cached(id)));
    const chunks=raw.chunks.map(chunk=>{const source=this.sources.get(chunk.chunk_id);if(!source||source.text!==chunk.text||source.paper_id!==chunk.paper_id||!params.paper_ids.includes(source.paper_id)||source.content_type!==chunk.content_type)throw new RuntimeFailure('INVALID_RESPONSE','Structured reading is not backed by its original source');return {...source};});
    return {...raw,chunks,reading_note:'原始表格与公式的独立阅读来源；长表按整行分组并保留表头。selection.has_more 为 true 时可用 next_offset 继续读取，缺失的来源不能据此补造。'};
  }
}

export function withScientificReading(config:P2HarnessConfig):P2HarnessConfig{
  if(!config.scientificSources)return config;const index=new Map(config.evidenceIndex);
  for(const [id,identity] of config.scientificSources.identities){const existing=index.get(id);if(existing&&JSON.stringify(existing)!==JSON.stringify(identity))throw new RuntimeFailure('INVALID_INDEX','Scientific source collides with the corpus');index.set(id,identity);}
  return {...config,evidenceIndex:index};
}
