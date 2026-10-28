import {createHash} from 'node:crypto';
import {RuntimeFailure,type Chunk,type Paper,type P2HarnessConfig} from './contracts.ts';

export function asksForAbstract(question:string):boolean{
  return /摘要|\babstract\b/iu.test(question)&&!/(?:不要|不用|无需|不是).{0,5}摘要/iu.test(question);
}
export function abstractReadingSection(question:string,query?:string):'abstract'|undefined{
  if(!asksForAbstract(question))return;
  const otherSections=/全文|正文|引言|表格|公式|(?:方法|实验|结果|结论)(?:章节|部分)|摘要.{0,12}(?:和|与|及).{0,8}(?:方法|实验|结果|结论)|\b(?:full text|introduction|methods? section|results? section|conclusion|tables?|equations?|formulas?)\b/iu.test(question);
  if(!otherSections||query!==undefined&&asksForAbstract(query))return 'abstract';
}

/** Corpus-backed reading sources do not enter the vector index or retrieval candidate pool. */
export function corpusAbstracts(papers:readonly Paper[],indexVersion:string):Map<string,Chunk>{
  const result=new Map<string,Chunk>();
  for(const paper of papers){
    if(!paper.abstract.trim())continue;const end=Array.from(paper.abstract).length;
    const id=`${indexVersion}:abstract-v1:${paper.paper_id}:c0-${end}`;
    result.set(paper.paper_id,{paper_id:paper.paper_id,paragraph_id:paper.paper_id+':abstract',chunk_id:id,section:'Abstract',text:paper.abstract,start:0,end,index_version:indexVersion,citation:`[${id}]`,truncated:false});
  }return result;
}

export function withAbstractReading(config:P2HarnessConfig):P2HarnessConfig{
  const abstracts=corpusAbstracts(config.publicPapers,config.indexVersion),index=new Map(config.evidenceIndex);
  for(const chunk of abstracts.values()){
    const identity={paper_id:chunk.paper_id,paragraph_id:chunk.paragraph_id,chunk_id:chunk.chunk_id,start:chunk.start,end:chunk.end,index_version:config.indexVersion,text_sha256:createHash('sha256').update(chunk.text).digest('hex')};
    const prior=index.get(chunk.chunk_id);
    if(prior&&Object.keys(identity).some(key=>prior[key as keyof typeof identity]!==identity[key as keyof typeof identity]))throw new RuntimeFailure('INVALID_INDEX','Reading source conflicts with an existing source identity');
    index.set(chunk.chunk_id,identity);
  }
  return {...config,evidenceIndex:index,abstractSources:abstracts};
}

/** Catalog previews help navigation; they are not evidence in final generation. */
export function groundedGenerationMessages<T extends {role:string}>(messages:readonly T[],isFinal:(message:T)=>boolean):T[]{
  const searches=new Set<string>();
  for(const message of messages){const value=message as T&{content?:unknown};if(message.role==='assistant'&&Array.isArray(value.content))for(const block of value.content)if(block.type==='toolCall'&&block.name==='search_papers')searches.add(block.id);}
  return messages.map(message=>{
    const value=message as T&{content?:unknown;toolName?:string;toolCallId?:string};
    if((message.role==='toolResult'||message.role==='tool')&&(value.toolName==='search_papers'||searches.has(value.toolCallId??''))&&Array.isArray(value.content)){
      return {...message,content:value.content.map(block=>{
        if(block.type!=='text'||typeof block.text!=='string')return block;
        try{const data=JSON.parse(block.text);if(!Array.isArray(data.papers))return block;
          return {...block,text:JSON.stringify({...data,papers:data.papers.map((paper:{paper_id:string;title:string})=>({paper_id:paper.paper_id,title:paper.title})),purpose:'catalog_navigation_only; retrieve original source text before making research claims'})};
        }catch{return block;}
      })} as T;
    }
    if(message.role==='assistant'&&!isFinal(message)&&Array.isArray(value.content))return {...message,content:value.content.filter(block=>block.type!=='text')} as T;
    return message;
  });
}
