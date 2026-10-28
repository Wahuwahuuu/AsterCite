const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const controls=new Set(['status','answer_kind','execution','needs_sources','remaining_needs','paper_coverage','exact_quotes']);
function control(value){
  if(!object(value)||Object.keys(value).some(key=>!controls.has(key)))return false;
  return object(value.execution)&&['working','complete','partial','clarification'].includes(value.execution.state)
    ||typeof value.answer_kind==='string'&&['complete','answer','partial','clarification','refusal'].includes(value.status)&&typeof value.needs_sources==='boolean';
}
const parse=value=>{try{return JSON.parse(value);}catch{return undefined;}};
const footer=text=>!text.trim()||/^(?:原文关联说明|本轮说明)：/u.test(text.trimStart());

/** Control framing is recognized by its schema, never by prose or completion keywords. */
export function splitAnswerControl(text,{streaming=false}={}){
  const whole=parse(text.trim().replace(/^```(?:json)?\s*\n/iu,'').replace(/\n```\s*$/u,''));
  if(control(whole))return {body:'',control:whole};
  for(const match of text.matchAll(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gmi)){
    const value=parse(match[1]),tail=text.slice(match.index+match[0].length);
    if(control(value)&&footer(tail))return {body:(text.slice(0,match.index).trimEnd()+(tail.trim()?'\n\n'+tail.trimStart():'')).trimEnd(),control:value};
  }
  const open=/^```(?:json)?[ \t]*\r?\n([^]*)$/gmi;
  for(const match of text.matchAll(open)){const value=parse(match[1]);if(control(value))return {body:text.slice(0,match.index).trimEnd(),control:value};}
  const start=text.lastIndexOf('\n{');
  if(start>=0){const value=parse(text.slice(start+1).trim());if(control(value))return {body:text.slice(0,start).trimEnd(),control:value};}
  if(streaming){
    const pending=/^```(?:json)?[ \t]*\r?\n\s*\{[^]*$/gmi;
    for(const match of text.matchAll(pending))if(!/^```/mu.test(match[0].slice(match[0].indexOf('\n')+1)))return {body:text.slice(0,match.index).trimEnd()};
    const unfinished=/\n`{1,3}(?:j(?:s(?:o(?:n)?)?)?)?$/iu.exec(text);if(unfinished)return {body:text.slice(0,unfinished.index).trimEnd()};
  }
  return {body:text,control:object(whole)?whole:undefined};
}

/** Only bare catalog identifiers are display names; source markers and science remain exact. */
export function displayPaperTitles(text,papers=[]){
  const entries=[...new Map(papers.filter(paper=>paper?.paper_id&&paper.title).map(paper=>[paper.paper_id,paper.title])).entries()];
  if(!entries.length)return text;
  const protectedParts=/```[^]*?```|~~~[^]*?~~~|`[^`\n]*`|\[cite:[^\]\n]*\]|\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/[^\s)]+|\$\$[^]*?\$\$|\$[^$\n]*\$|\\\[[^]*?\\\]|\\\([^]*?\\\)/gu;
  const replace=part=>{for(const [id,title] of entries){const pattern=new RegExp('(?<![\\w.:/-])'+id.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')+'(?![\\w.:/-])','gu');part=part.replace(pattern,(match,offset)=>{
    const before=part.slice(Math.max(0,offset-title.length-12),offset).replace(/[*_《》]/gu,'');
    return before.endsWith(title+'（')||before.endsWith(title+' (')||before.endsWith(title+'(')?match:'《'+title+'》';
  });}return part;};
  let result='',offset=0;for(const match of text.matchAll(protectedParts)){result+=replace(text.slice(offset,match.index))+match[0];offset=match.index+match[0].length;}return result+replace(text.slice(offset));
}
