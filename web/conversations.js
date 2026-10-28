const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const time=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const title=value=>Array.from(value.trim()).slice(0,80).join('')||'新对话';

/** Upgrade the browser's existing list without changing ownership tokens. */
export function normalizeConversations(value){
  if(!Array.isArray(value))return [];
  const seen=new Set(),items=[];
  for(const entry of value){
    if(!entry||!UUID.test(entry.id)||typeof entry.token!=='string'||!/^[a-f0-9]{64}$/u.test(entry.token)||typeof entry.label!=='string'||seen.has(entry.id))continue;
    seen.add(entry.id);items.push({id:entry.id,token:entry.token,label:title(entry.label),renamed:entry.renamed===true,pinned:entry.pinned===true,archived:entry.archived===true,created_at:time(entry.created_at),updated_at:time(entry.updated_at)});
    if(items.length>=100)break;
  }
  return items;
}
export function listConversations(items,archived=false){
  return items.filter(item=>item.archived===archived).sort((a,b)=>(archived?0:Number(b.pinned)-Number(a.pinned))||b.updated_at-a.updated_at);
}
export function renameConversation(item,label){
  if(typeof label!=='string'||!label.trim()||Array.from(label.trim()).length>80)throw new Error('请填写 1–80 个字的对话名称。');
  return {...item,label:title(label),renamed:true};
}
export function touchConversation(item,firstQuestion,now=Date.now()){
  return {...item,label:item.renamed?item.label:title(firstQuestion||item.label),updated_at:now};
}
