import {findCutPoint,estimateTokens,convertToLlm,type SessionProjection,type SessionEntry} from '@earendil-works/pi-coding-agent';
import {estimateVisibleContext} from './workbench-context.ts';

/** Feed the SDK its edited, currently visible entries, retaining original source IDs. */
export function contextCut(projection:SessionProjection,keepRecentTokens:number):string|undefined{
  const entries:SessionEntry[]=projection.entries.flatMap(({sourceEntry,messages})=>messages.filter(message=>message.role!=='compactionSummary').map(message=>({...sourceEntry,type:'message' as const,message})));
  if(entries.length<2)return;
  let retained=0,cursor=entries.length;
  while(cursor>0&&retained<keepRecentTokens){cursor--;const entry=entries[cursor];if(entry.type==='message'&&entry.message.role!=='system')retained+=estimateVisibleContext({messages:convertToLlm([entry.message])});}
  const sdkBudget=entries.slice(cursor).reduce((sum,entry)=>sum+(entry.type==='message'?estimateTokens(entry.message):0),0);
  const cut=findCutPoint(entries,0,entries.length,Math.max(1,sdkBudget)).firstKeptEntryIndex;
  if(cut<=0||!entries.slice(0,cut).some(entry=>entry.type==='message'&&entry.message.role!=='system'))return;
  return entries[cut]?.id;
}
