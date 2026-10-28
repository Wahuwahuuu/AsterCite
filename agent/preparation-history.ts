import type {DialogueRecord} from './domain-memory.ts';

export const PREPARATION_HISTORY_POLICY='workbench-history-v1';
interface TextRange {start:number;end:number}
export interface PreparationDialogue {
  turn_id:string;turn_number:number;user_text:string;assistant_text:string;
  user_text_truncated?:boolean;assistant_text_truncated?:boolean;
  user_original_codepoints?:number;assistant_original_codepoints?:number;
  user_text_ranges?:TextRange[];assistant_text_ranges?:TextRange[];
}
export interface PreparationHistoryInfo {
  policy:typeof PREPARATION_HISTORY_POLICY;total_turns:number;included_turns:number;omitted_turns:number;
  excerpt_turn_ids:string[];focus_turn_ids:string[];focus_complete:boolean;instruction:string;
  reference_unavailable:boolean;
}
export interface PreparationHistoryResult {payload:Record<string,unknown>;info:PreparationHistoryInfo;fits:boolean;input_tokens:number;input_limit:number}

const ordinal=(text:string):number=>{
  if(/^\d+$/u.test(text))return Number(text);
  const digits:Record<string,number>={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
  if(text==='十')return 10;if(text.includes('十')){const [tens,ones]=text.split('十');return (digits[tens]??1)*10+(digits[ones]??0);}return digits[text]??0;
};
/** Explicit old-turn references outrank recency; list-item references refer to the last reply. */
function focusTurns(question:string,history:readonly DialogueRecord[]):{indices:number[];unavailable:boolean}{
  let explicit=false,unavailable=false;
  const selected=new Set<number>(),add=(i:number)=>{if(i>=0&&i<history.length)selected.add(i);else unavailable=true;};
  for(const [i,turn] of history.entries())if(question.includes(turn.turn_id))add(i);
  for(const match of question.matchAll(/(?<!倒数)第\s*(\d+|[一二两三四五六七八九十]+)\s*(?:轮|次(?:回答|回复|对话))/gu)){explicit=true;add(ordinal(match[1])-1);}
  const backwards=/倒数第\s*(\d+|[一二两三四五六七八九十]+)\s*轮/u.exec(question);
  if(backwards){explicit=true;add(history.length-ordinal(backwards[1]));}
  if(/最开始|最初|第一条回复|at the beginning|first reply/iu.test(question))add(0);
  if(/上上(?:轮|次)/u.test(question))add(history.length-2);
  else if(/刚才|上(?:一)?轮|上次|最后|末尾|结尾|前面|之前|继续|第\s*[\d一二三四五六七八九十]+\s*(?:个|项|点)|previous|last|earlier|continue/iu.test(question)&&!selected.size&&!explicit)add(history.length-1);
  const quotes=[...question.matchAll(/[“「『"]([^”」』"]{3,100})[”」』"]/gu)].map(match=>match[1]);
  for(const quote of quotes){for(let i=history.length-1;i>=0;i--)if(history[i].user_text.includes(quote)||history[i].final_answer.includes(quote)){add(i);break;}}
  return {indices:[...selected],unavailable};
}

/** Verbatim head/tail/relevant excerpts, with exact Unicode offsets; never an invented summary. */
function excerpt(text:string,limit:number,question:string):{text:string;ranges:TextRange[];truncated:boolean;length:number}{
  const chars=Array.from(text),length=chars.length;
  if(limit>=length)return {text,ranges:[{start:0,end:length}],truncated:false,length};
  if(limit<=0)return {text:'[…本轮未载入原文…]',ranges:[],truncated:length>0,length};
  const ranges:TextRange[]=[],head=Math.floor(limit*.2),tail=Math.floor(limit*.5);
  if(head)ranges.push({start:0,end:head});if(tail)ranges.push({start:Math.max(0,length-tail),end:length});
  const terms=[...new Set([...question.matchAll(/[“「『"]([^”」』"]{3,100})[”」』"]|[\p{Script=Han}]{2,}|[A-Za-z][A-Za-z0-9_-]{2,}/gu)].map(match=>match[1]??match[0]))].slice(0,8);
  const positions=terms.flatMap(term=>{const at=text.toLowerCase().indexOf(term.toLowerCase());return at<0?[]:[Array.from(text.slice(0,at)).length];});
  let remaining=limit-head-tail;
  for(const [i,at] of positions.entries()){const size=Math.floor(remaining/(positions.length-i));if(!size)break;const start=Math.max(0,Math.min(length-size,at-Math.floor(size/3)));ranges.push({start,end:Math.min(length,start+size)});remaining-=size;}
  if(remaining)ranges.push({start:Math.max(0,length-tail-remaining),end:length});
  const merged:TextRange[]=[];
  for(const range of ranges.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range});}
  const value=(merged[0]?.start?'[…已省略原文…]\n':'')+merged.map(range=>chars.slice(range.start,range.end).join('')).join('\n[…已省略原文…]\n')+(merged.at(-1)?.end!==length?'\n[…已省略原文…]':'');
  return {text:value,ranges:merged,truncated:true,length};
}
function full(turn:DialogueRecord,i:number):PreparationDialogue{return {turn_id:turn.turn_id,turn_number:i+1,user_text:turn.user_text,assistant_text:turn.final_answer};}
function partial(turn:DialogueRecord,i:number,characters:number,question:string):PreparationDialogue{
  const userLimit=Math.min(Array.from(turn.user_text).length,Math.floor(characters*.2)),user=excerpt(turn.user_text,userLimit,question),answer=excerpt(turn.final_answer,characters-userLimit,question);
  return {...full(turn,i),user_text:user.text,assistant_text:answer.text,user_text_truncated:user.truncated,assistant_text_truncated:answer.truncated,
    user_original_codepoints:user.length,assistant_original_codepoints:answer.length,user_text_ranges:user.ranges,assistant_text_ranges:answer.ranges};
}

/** The caller measures the complete request, including memory, catalog and system instructions. */
export function fitPreparationHistory(base:Record<string,unknown>,history:readonly DialogueRecord[],question:string,
  options:{maxInputTokens:number;measure:(payload:Record<string,unknown>)=>number}):PreparationHistoryResult{
  const inputLimit=Math.max(0,Math.floor(options.maxInputTokens)),reference=focusTurns(question,history),focus=reference.indices,selected=new Map<number,PreparationDialogue>();
  const build=()=>{
    const rows=[...selected.entries()].sort(([a],[b])=>a-b).map(([,row])=>row);
    const info:PreparationHistoryInfo={policy:PREPARATION_HISTORY_POLICY,total_turns:history.length,included_turns:rows.length,omitted_turns:history.length-rows.length,
      excerpt_turn_ids:rows.filter(row=>row.user_text_truncated||row.assistant_text_truncated).map(row=>row.turn_id),focus_turn_ids:focus.map(i=>history[i].turn_id),
      reference_unavailable:reference.unavailable,focus_complete:!reference.unavailable&&focus.every(i=>{const row=selected.get(i);return Boolean(row&&!row.user_text_truncated&&!row.assistant_text_truncated);}),
      instruction:'Listed rows contain the verbatim dialogue visible in this projection. Separate memory and summaries may be incomplete. Truncated entries are excerpts, not complete replies or semantic summaries; ranges use zero-based Unicode codepoints. Omitted history remains stored locally. Never assume an omitted list item or ending is visible. Preserve the original question if a reference cannot be resolved. Previous answers are conversation, not paper evidence.'};
    const payload={...base,recent_dialogue:rows,history_context:info},tokens=options.measure(payload);
    return {payload,info,fits:tokens<=inputLimit,input_tokens:tokens,input_limit:inputLimit};
  };
  for(const [i,turn] of history.entries())selected.set(i,full(turn,i));
  let result=build();if(result.fits)return result;
  selected.clear();result=build();if(!result.fits)return result;
  const fitFull=(i:number)=>{selected.set(i,full(history[i],i));if(build().fits)return true;selected.delete(i);return false;};
  const fitExcerpt=(i:number)=>{
    let low=0,high=Array.from(history[i].user_text).length+Array.from(history[i].final_answer).length,best:PreparationDialogue|undefined;
    while(low<=high){const mid=Math.floor((low+high)/2),row=partial(history[i],i,mid,question);selected.set(i,row);if(build().fits){best=row;low=mid+1;}else high=mid-1;}
    if(best)selected.set(i,best);else selected.delete(i);
  };
  for(const i of focus)if(!fitFull(i))fitExcerpt(i);
  for(let i=history.length-1;i>=0;i--)if(!selected.has(i))fitFull(i);
  for(let i=history.length-1;i>=0;i--)if(!selected.has(i))fitExcerpt(i);
  return build();
}
