import type {Chunk} from './contracts.ts';
import {citationIds} from './p2-r2.ts';

export interface ClaimAttribution {
  claim:string;citations:string[];values:string[];unmatched_values:string[];
  assessment:'value_present'|'missing_citation'|'value_not_in_cited_source';
  candidate_sources:Record<string,string[]>;
}
const percentagePattern=/\d+(?:,\d{3})*(?:\.\d+)?\s*\\?[%％]/gu;
const percentages=(text:string)=>[...text.matchAll(percentagePattern)].map(match=>match[0]);
const numberValue=(text:string)=>Number.parseFloat(text.replace(/[\s,\\]/gu,''));
const valueKey=(text:string)=>String(numberValue(text));
const reportedMetric=/准确率|精确率|召回率|错误率|误差率|分类|F1|F-score|实验|结果|提升|提高|降低|达到|achiev|accurac|precision|recall|error rate|improv|result|report/iu;
const qualification=/例如|假设|假定|举例|示例|打个比方|推算|换算|计算得|相减|差值|无法(?:确认|证实)|不能(?:确认|证实)|未(?:给出|报告|提供)|没有(?:给出|报告|提供)|\b(?:example|hypothetical|suppose|assuming|calculated|derived|not reported|not provided|cannot confirm|cannot verify)\b/iu;

/** Split readable claims while keeping citation markers attached after sentence punctuation. */
function claims(paragraph:string):string[]{
  const result:string[]=[];let start=0;
  for(let i=0;i<paragraph.length;i++){
    const ch=paragraph[i],decimal=ch==='.'&&/\d/u.test(paragraph[i-1]??'')&&/\d/u.test(paragraph[i+1]??'');
    const ordinal=/^\s*\d+$/u.test(paragraph.slice(start,i));
    const following=paragraph[i+1]??'';
    const end=/[。！？；;]/u.test(ch)||ch==='.'&&!decimal&&!ordinal&&(following===''||/\s/u.test(following));
    const nextBullet=ch==='\n'&&/^\s*(?:\d+[.)、]|[-*•])\s/u.test(paragraph.slice(i+1));
    if(!end&&!nextBullet)continue;let cursor=i+1;
    if(end){
      while(cursor<paragraph.length&&/[”’"')）]/u.test(paragraph[cursor]))cursor++;
      let matched:RegExpExecArray|null;
      while((matched=/^\s*\[cite:[^\]\n]+\]/u.exec(paragraph.slice(cursor))))cursor+=matched[0].length;
    }
    result.push(paragraph.slice(start,cursor));start=cursor;i=cursor-1;
  }
  if(start<paragraph.length)result.push(paragraph.slice(start));return result;
}

/** Metric presence is a bounded check, not a semantic-entailment verdict. */
export function inspectCitationAttribution(answer:string,evidence:ReadonlyMap<string,Chunk>):{answer:string;checks:ClaimAttribution[];issues:string[]}{
  const checks:ClaimAttribution[]=[],issues:string[]=[];
  const result=answer.split(/(\r?\n[ \t]*\r?\n)/u).map(paragraph=>{
    if(/^\r?\n[ \t]*\r?\n$/u.test(paragraph))return paragraph;
    const inherited=citationIds(paragraph).filter(id=>evidence.has(id));
    return claims(paragraph).map(claim=>{
      const values=[...new Set(percentages(claim))];
      if(!values.length||!reportedMetric.test(claim)||qualification.test(claim))return claim;
      const direct=citationIds(claim).filter(id=>evidence.has(id)),ids=direct.length?direct:inherited;
      const sourceValues=ids.flatMap(id=>percentages(evidence.get(id)!.text));
      const present=new Set(sourceValues.map(valueKey));
      const approximate=/约|大概|接近|\b(?:about|around|roughly|approximately)\b/iu.test(claim);
      const unmatched=values.filter(value=>!present.has(valueKey(value))&&!(approximate&&sourceValues.some(found=>{
        const decimals=value.match(/\.(\d+)/u)?.[1].length??0;
        return decimals<=12&&Number(numberValue(found).toFixed(decimals))===numberValue(value);
      })));
      const candidates=Object.fromEntries(unmatched.map(value=>[value,[...evidence].filter(([,source])=>percentages(source.text).some(found=>valueKey(found)===valueKey(value))).map(([id])=>id)]));
      checks.push({claim:claim.trim(),citations:ids,values,unmatched_values:unmatched,assessment:unmatched.length?ids.length?'value_not_in_cited_source':'missing_citation':'value_present',candidate_sources:candidates});
      if(!unmatched.length)return claim;
      for(const value of unmatched)issues.push(`metric_source_mismatch:${value}`);
      let visible=claim;
      if(direct.length&&unmatched.length===values.length)visible=visible.replace(/\[cite:([^\]]+)\]/gu,(marker,id:string)=>direct.includes(id)?'〔此处引用未支持该数值〕':marker);
      return visible.replace(percentagePattern,(value:string,offset:number,text:string)=>unmatched.includes(value)&&!text.slice(offset+value.length).startsWith('〔该数值依据待核对〕')?value+'〔该数值依据待核对〕':value);
    }).join('');
  }).join('');
  return {answer:result,checks,issues:[...new Set(issues)]};
}
