import {parseEvidenceText,evidencePreview} from './evidence-format.js';
import {ActivityPanel,readQuestionStream} from './activity.js';
import {PaperReader} from './paper-reader.js';
import {TraceInspector} from './trace-inspector.js';
import {SessionPanel} from './session-panel.js';
import {LongMemoryPanel} from './long-memory.js';
import {renderMarkdown} from './markdown.js';
import {AnswerPreview} from './answer-preview.js';
import {displayPaperTitles,splitAnswerControl} from './answer-format.js';
import {ReaderFollow} from './reader-follow.js';
import {normalizeConversations,listConversations,renameConversation,touchConversation} from './conversations.js';
import {TaskProgressPanel} from './task-progress.js';

const $=id=>document.getElementById(id);
const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const state={mode:'demo',papers:[],sample:null,turns:[],scope:[],pending_compaction:false,memory:null,context:null,initialContext:null,budget:null,busy:false,active:null,accessToken:'',demoIndex:-1,sessions:[],showArchived:false,sourceTurn:-1,memorySupported:false,memoryCredential:'',longTermMemory:null};
let currentRequest=null;
const tasksPanel=new TaskProgressPanel({dialog:$('task-dialog'),content:$('task-content'),button:$('current-tasks'),papers:()=>state.papers,onPaper:id=>{void openPdf(id);}});
function requestControls(){const active=Boolean(currentRequest);$('stop-generation').hidden=!active;$('stop-generation').disabled=Boolean(currentRequest?.stopping);$('stop-generation').textContent=currentRequest?.stopping?'正在停止…':'■ 停止生成';$('send').hidden=active;}
const STORAGE='astercite.web.sessions.v1';
const MEMORY_STORAGE='astercite.web.memory-owner.v1';try{state.memoryCredential=localStorage.getItem(MEMORY_STORAGE)||'';}catch{}
const sessionMenu=$('session-menu');let menuTarget=null,menuAnchor=null,renameTarget=null;
const inspector=new TraceInspector();
function inspectTurn(turn,live=false){
  const owner=state.active,accessToken=state.accessToken;
  inspector.openRun(turn,async item=>{
    if(!owner||!item.turn_id)throw new Error('这条历史记录没有保存完整请求详情。');
    const headers={'X-AsterCite-Session':owner.token};if(accessToken)headers.Authorization='Bearer '+accessToken;
    const response=await fetch(`/api/sessions/${owner.id}/traces/${item.turn_id}/${item.id}`,{headers});if(!response.ok)throw new Error('详情暂不可用');return (await response.json()).detail;
  },{live});
}
const activity=new ActivityPanel($('agent-activity'),()=>inspectTurn(activity.snapshot(),true));
const sessionPanel=new SessionPanel({onSchedule:compact=>settings(state.scope,compact),onPaper:id=>openPdf(id),onJump:id=>{
  for(const name of ['memory-dialog','compression-dialog'])if($(name).open)$(name).close();
  const turn=[...document.querySelectorAll('[data-turn-id]')].find(item=>item.dataset.turnId===id);if(turn){turn.scrollIntoView({behavior:'smooth',block:'start'});turn.classList.add('memory-highlight');setTimeout(()=>turn.classList.remove('memory-highlight'),2000);}else notice('这条摘记来自更早的对话，当前记录中未找到对应回答。');
}});
const longMemoryPanel=new LongMemoryPanel({api,ensureProfile:ensureMemoryProfile,isBusy:()=>state.busy,onPaper:id=>openPdf(id),onSource:async(id,turn)=>{
  const owner=state.sessions.find(item=>item.id===id);if(!owner){notice('来源对话不在当前浏览器的列表中，摘记仍可在长期记忆中查看。');return;}if(state.busy)return;
  try{busy(true);const view=await api('/api/sessions/'+id,undefined,{session:owner});state.active=owner;applyView(view);$('memory-dialog').close();const target=[...document.querySelectorAll('[data-turn-id]')].find(item=>item.dataset.turnId===turn);target?.scrollIntoView({behavior:'smooth',block:'start'});}catch(error){notice(error.message,true);}finally{busy(false);}
}});
function renderSessionPanels(){sessionPanel.update({mode:state.mode,papers:state.papers,turns:state.turns,memory:state.memory,context:state.context,pending:state.pending_compaction,busy:state.busy});longMemoryPanel.update({mode:state.mode,supported:state.memorySupported,papers:state.papers,current:state.longTermMemory,session:state.active});}
const reader=new PaperReader({pages:$('pdf-pages'),status:$('pdf-status'),page:$('pdf-page'),previous:$('pdf-prev'),next:$('pdf-next'),zoom:$('pdf-zoom'),original:$('pdf-original'),retry:$('pdf-retry'),container:$('pdf-viewport'),highlightBar:$('pdf-highlight-bar'),highlightStatus:$('pdf-highlight-status'),highlightClear:$('pdf-highlight-clear')});
let readingPaper=null,showcase=[];
const readerFollow=new ReaderFollow({open:id=>openPdf(id,{automatic:true}),current:()=>readingPaper?.paper_id??null});
function renderReaderFollow(){$('reader-follow-state').textContent=!readerFollow.enabled?'已关闭自动切换':readerFollow.pinned?'本轮保持你的选择':'回答时自动切换论文';}
function pinReader(){readerFollow.manual();renderReaderFollow();}
function readerTab(name){for(const value of ['pdf','sources']){const selected=name===value;const tab=$('tab-'+value);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$(value==='pdf'?'pdf-panel':'source-panel').hidden=!selected;}if(name==='pdf'&&readingPaper)void reader.open(readingPaper,state.accessToken);}
function openPdf(id,{automatic=false}={}){const paper=state.papers.find(p=>p.paper_id===id);if(!paper)return;if(!automatic)pinReader();const changed=readingPaper?.paper_id!==id;readingPaper=paper;$('pdf-paper').value=id;$('pdf-title').textContent=paper.title;if(changed||$('tab-pdf').getAttribute('aria-selected')!=='true')readerTab('pdf');openEvidence();}
function highlightCitation(source){if(!source||!state.papers.some(paper=>paper.paper_id===source.paper_id))return;openPdf(source.paper_id);void reader.highlight(source,state.accessToken);}
function showCitation(sources,index){pinReader();showSources(sources,index);readerTab('sources');openEvidence();}
for(const name of ['pdf','sources'])$('tab-'+name).addEventListener('click',()=>{pinReader();readerTab(name);});
document.querySelector('.reader-tabs').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();pinReader();const name=$('tab-pdf').getAttribute('aria-selected')==='true'?'sources':'pdf';readerTab(name);$('tab-'+name).focus();}});
$('pdf-paper').addEventListener('change',()=>openPdf($('pdf-paper').value));
$('reader-follow').addEventListener('change',()=>{readerFollow.setEnabled($('reader-follow').checked);if(readerFollow.enabled)readerFollow.finish(state);renderReaderFollow();});
$('reader-open').addEventListener('click',openEvidence);
$('suggestions-open').addEventListener('click',()=>{$('welcome').hidden=false;$('chat-scroll').scrollTop=0;});
try{state.sessions=normalizeConversations(JSON.parse(localStorage.getItem(STORAGE)||'[]'));}catch{state.sessions=[];}
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(state.sessions));}catch{notice('浏览器没有允许保存会话列表；当前对话仍可继续。');}}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;}
function clearNotice(){$('notice').hidden=true;}
async function readJSON(path){const res=await fetch(path);if(!res.ok)throw new Error('读取失败');return res.json();}
async function api(path,body,{method=body===undefined?'GET':'POST',session=state.active}={}){
  const headers={'X-AsterCite-Request':'1'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(session)headers['X-AsterCite-Session']=session.token;
  if(state.memoryCredential)headers['X-AsterCite-Memory']=state.memoryCredential;
  if(state.accessToken)headers.Authorization='Bearer '+state.accessToken;
  const response=await fetch(path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if(!response.ok){if(response.status===401)$('access-dialog').showModal();const error=new Error(value.error||'操作未完成，请稍后再试。');error.status=response.status;throw error;}
  return value;
}
function busy(value){
  state.busy=value;$('busy-indicator').hidden=!value;
  if(value)closeSessionMenu();$('session-archive-toggle').disabled=value;
  for(const id of ['send','new-chat','compact','scope-all','question'])$(id).disabled=value;
  $('compact').disabled=value||state.mode!=='live';
  document.querySelectorAll('.paper-scope,.session-item,.session-more,.example-card').forEach(n=>n.disabled=value);
  $('send-label').textContent=value?'处理中':state.mode==='demo'?'播放下一问':'发送问题';
  requestControls();
  renderSessionPanels();
  if(value)$('chat-scroll').scrollTop=$('chat-scroll').scrollHeight;
}
function applyView(view,{follow=true}={}){state.turns=view.turns;state.scope=view.scope;state.pending_compaction=view.pending_compaction;state.memory=view.memory;state.longTermMemory=view.long_term_memory??null;state.context=view.context??state.initialContext;state.budget=view.budget;render();const last=state.turns.at(-1);if(last)inspector.updateRun(last);activity.reset();if(follow)readerFollow.finish(view);renderReaderFollow();}
function resetConversation(){
  tasksPanel.begin();if($('task-dialog').open)$('task-dialog').close();
  state.active=null;state.turns=[];state.scope=[];state.memory=null;state.context=state.initialContext;state.budget=null;state.pending_compaction=false;state.demoIndex=-1;state.sourceTurn=-1;state.showArchived=false;closeSessionMenu();
  state.longTermMemory=null;longMemoryPanel.override=null;
  inspector.reset();translationCache.clear();reader.clearHighlight();readerFollow.beginTurn();renderReaderFollow();
  for(const id of ['memory-dialog','compression-dialog'])if($(id).open)$(id).close();
  render();activity.reset({replay:state.mode==='demo'});if(state.mode==='live'){$('question').value='';$('question').focus();}
}
async function ensureSession(){
  if(state.active)return;
  await ensureMemoryProfile();
  const value=await api('/api/sessions',{}),now=Date.now();state.active=normalizeConversations([{...value,label:'新对话',created_at:now,updated_at:now}])[0];state.showArchived=false;
  state.sessions.unshift(state.active);persist();renderSessions();
}
let memoryProfilePending;
async function ensureMemoryProfile(){
  if(state.mode!=='live'||!state.memorySupported)return;
  if(memoryProfilePending)return memoryProfilePending;
  memoryProfilePending=(async()=>{
    if(state.memoryCredential){try{await api('/api/memory/profile');return;}catch(error){if(error.status!==403)throw error;state.memoryCredential='';}}
    const profile=await api('/api/memory/profiles',{});state.memoryCredential=profile.credential;try{localStorage.setItem(MEMORY_STORAGE,state.memoryCredential);}catch{notice('浏览器未允许保存记忆身份，关闭页面后可能无法恢复长期记忆。');}
  })();try{await memoryProfilePending;}finally{memoryProfilePending=null;}
}
function renderPapers(){
  const list=$('paper-list');list.replaceChildren();const term=$('paper-search').value.toLowerCase();
  const featured=new Set(showcase.flatMap(e=>e.paper_ids));
  const papers=state.papers.filter(p=>(p.title+' '+p.paper_id).toLowerCase().includes(term)).sort((a,b)=>Number(featured.has(b.paper_id))-Number(featured.has(a.paper_id)));
  $('paper-count').textContent=state.papers.length+' 篇';
  for(const p of papers){
    const row=make('div','paper-row'+(state.scope.includes(p.paper_id)?' selected':''));
    const scope=make('button','paper-scope',state.scope.includes(p.paper_id)?'✓':'');scope.setAttribute('aria-label','问答范围：'+p.title);scope.setAttribute('aria-pressed',String(state.scope.includes(p.paper_id)));scope.disabled=state.busy;
    scope.addEventListener('click',async()=>{const range=state.scope.includes(p.paper_id)?state.scope.filter(id=>id!==p.paper_id):[...state.scope,p.paper_id];if(state.mode==='demo'){state.scope=range;renderPapers();renderScope();}else await settings(range,state.pending_compaction);});
    const b=make('button','paper-item');b.title='阅读 PDF：'+p.title;b.setAttribute('aria-label',b.title);
    const details=make('div');details.append(make('div','paper-title',p.title),make('div','paper-id',p.paper_id+(featured.has(p.paper_id)?' · 推荐':'')));b.append(details);b.addEventListener('click',()=>openPdf(p.paper_id));row.append(scope,b);list.append(row);
  }
  if(!papers.length)list.append(make('p','sidebar-empty','没有匹配的论文'));
}
function renderSessions(){
  closeSessionMenu();$('session-list-title').textContent=state.showArchived?'已归档对话':'最近对话';
  const archived=state.sessions.filter(item=>item.archived).length,toggle=$('session-archive-toggle');toggle.hidden=state.mode!=='live';toggle.disabled=state.busy;toggle.textContent=state.showArchived?'最近对话':'归档'+(archived?' ('+archived+')':'');toggle.setAttribute('aria-pressed',String(state.showArchived));
  const list=$('session-list');list.replaceChildren();
  if(state.mode==='demo'){
    const b=make('button','session-item selected');b.append(make('span',null,'◷'),make('span',null,'情感分析与语音表示 · 示例'));b.addEventListener('click',()=>playDemo(0));list.append(b);return;
  }
  const visible=listConversations(state.sessions,state.showArchived);
  for(const item of visible){
    const row=make('div','session-row'+(state.active?.id===item.id?' selected':''));
    const b=make('button','session-item'+(state.active?.id===item.id?' selected':''));b.disabled=state.busy;
    b.append(make('span','session-label',item.label));b.title=item.label+(item.pinned?'（已置顶）':'');
    if(item.pinned){const pin=sessionMenu.querySelector('[data-session-action="pin"] svg').cloneNode(true);pin.classList.add('session-pin-indicator');b.append(pin);}
    b.addEventListener('click',async()=>{if(state.busy)return;clearNotice();busy(true);try{const view=await api('/api/sessions/'+item.id,undefined,{session:item});inspector.reset();readerFollow.beginTurn();state.active=item;applyView(view);notice('已恢复这个会话。');}catch(e){notice(e.message,true);}finally{busy(false);}});
    const more=make('button','session-more','⋯');more.disabled=state.busy;more.setAttribute('aria-label','更多操作：'+item.label);more.setAttribute('aria-haspopup','menu');more.setAttribute('aria-expanded','false');more.title='对话操作';
    more.addEventListener('click',()=>openSessionMenu(item,more));row.addEventListener('contextmenu',event=>{if(state.busy)return;event.preventDefault();openSessionMenu(item,more);});
    row.append(b,more);list.append(row);
  }
  if(!visible.length)list.append(make('p','sidebar-empty',state.showArchived?'没有归档的对话。':'你的对话会保存在这里。'));
}
function closeSessionMenu(restoreFocus=false){sessionMenu.hidden=true;menuAnchor?.setAttribute('aria-expanded','false');if(restoreFocus&&menuAnchor?.isConnected)menuAnchor.focus();menuTarget=null;menuAnchor=null;}
function openSessionMenu(item,anchor){
  if(state.busy)return;if(menuTarget?.id===item.id){closeSessionMenu(true);return;}closeSessionMenu();menuTarget=item;menuAnchor=anchor;anchor.setAttribute('aria-expanded','true');
  $('session-pin-label').textContent=item.pinned?'取消置顶':'置顶';$('session-archive-label').textContent=item.archived?'取消归档':'归档';sessionMenu.hidden=false;
  const rect=anchor.getBoundingClientRect(),width=sessionMenu.offsetWidth,height=sessionMenu.offsetHeight;
  sessionMenu.style.left=Math.max(12,Math.min(window.innerWidth-width-12,rect.right-24))+'px';sessionMenu.style.top=Math.max(12,Math.min(window.innerHeight-height-12,rect.bottom+6))+'px';sessionMenu.querySelector('button').focus();
}
$('session-archive-toggle').addEventListener('click',()=>{if(state.busy)return;state.showArchived=!state.showArchived;renderSessions();});
document.addEventListener('pointerdown',event=>{if(!sessionMenu.hidden&&!sessionMenu.contains(event.target)&&!menuAnchor?.contains(event.target))closeSessionMenu();});
window.addEventListener('resize',()=>closeSessionMenu());
document.addEventListener('scroll',event=>{if(!sessionMenu.hidden&&!sessionMenu.contains(event.target))closeSessionMenu();},true);
sessionMenu.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeSessionMenu(true);return;}
  if(event.key==='Tab'){closeSessionMenu(true);return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...sessionMenu.querySelectorAll('button')],at=buttons.indexOf(document.activeElement);
  buttons[event.key==='Home'?0:event.key==='End'?buttons.length-1:(at+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
});
sessionMenu.addEventListener('click',event=>{
  const action=event.target.closest('[data-session-action]')?.dataset.sessionAction,item=menuTarget;if(!action||!item||state.busy)return;closeSessionMenu(true);
  if(action==='rename'){renameTarget=item;$('rename-session-input').value=item.label;$('rename-session-error').hidden=true;$('rename-session-dialog').showModal();$('rename-session-input').focus();$('rename-session-input').select();}
  else if(action==='pin'){item.pinned=!item.pinned;persist();renderSessions();}
  else if(action==='archive'){item.archived=!item.archived;persist();if(item.archived&&state.active?.id===item.id)resetConversation();else{if(!item.archived)state.showArchived=false;renderSessions();}notice(item.archived?'对话已归档，可从“归档”入口找回。':'对话已移回最近对话。');}
  else if(action==='delete'){deleteTarget=item;$('delete-session-name').textContent=item.label;$('delete-session-dialog').showModal();}
});
$('rename-session-cancel').addEventListener('click',()=>$('rename-session-dialog').close());
$('rename-session-dialog').addEventListener('close',()=>{renameTarget=null;});
$('rename-session-form').addEventListener('submit',event=>{
  event.preventDefault();if(state.busy||!renameTarget)return;
  try{Object.assign(renameTarget,renameConversation(renameTarget,$('rename-session-input').value));persist();$('rename-session-dialog').close();renderSessions();}
  catch(error){$('rename-session-error').textContent=error.message;$('rename-session-error').hidden=false;}
});
let deleteTarget=null;
$('delete-session-cancel').addEventListener('click',()=>$('delete-session-dialog').close());
$('delete-session-dialog').addEventListener('close',()=>{deleteTarget=null;});
$('delete-session-confirm').addEventListener('click',async()=>{
  if(state.busy||!deleteTarget)return;const item=deleteTarget;$('delete-session-dialog').close();clearNotice();busy(true);
  try{
    try{await api('/api/sessions/'+item.id,undefined,{method:'DELETE',session:item});}catch(error){if(error.status!==404)throw error;}
    state.sessions=state.sessions.filter(session=>session.id!==item.id);persist();
    if(state.active?.id===item.id)resetConversation();else renderSessions();
    notice('对话已删除。');
  }catch(error){notice(error.message,true);}finally{busy(false);}
});
function renderScope(){
  $('scope-all').classList.toggle('selected',!state.scope.length);const box=$('selected-scope');box.replaceChildren();
  for(const id of state.scope){const n=make('span','scope-chip selected',id);box.append(n);}
  $('budget-hint').textContent=state.budget?'剩余 '+state.budget.remaining_turns+' 轮':'';
}
function inlineText(target,text,sources){
  renderMarkdown(target,text,{sources,onCitation:index=>showCitation(sources,index),onCitationHover:index=>highlightCitation(sources[index])});
}
function sourceContent(blocks){
  const content=make('div','source-content');
  for(const block of blocks){
    if(block.kind==='markdown'){
      const section=make('div','source-scientific');renderMarkdown(section,block.text);content.append(section);
    }else if(block.kind==='table'){
      const table=make('table','source-table');table.append(make('caption',null,block.caption));
      const head=make('thead'),header=make('tr');
      for(const label of block.headers){const th=make('th',null,label);th.scope='col';header.append(th);}head.append(header);table.append(head);
      const body=make('tbody');
      for(const row of block.rows){const tr=make('tr');for(const value of row)tr.append(make('td',null,value));body.append(tr);}table.append(body);content.append(table);
      if(block.omittedRows)content.append(make('p','source-more','还有 '+block.omittedRows+' 行，展开查看'));
    }else content.append(make(block.kind==='heading'?'h4':'p',/^(?:[•●]\s*|\d+[.)]\s+)/u.test(block.text)?'source-point':null,block.text));
  }
  return content;
}
let sourceVersion=0,translationQueue=[],translating=false;
const translationCache=new Map();
function translationContent(target,text){
  const blocks=parseEvidenceText(text),preview=evidencePreview(blocks);target.replaceChildren();target.append(sourceContent(preview.blocks));
  if(preview.hasMore){const details=make('details','source-details'),summary=make('summary',null,'展开完整译文');details.append(summary,sourceContent(blocks));target.append(details);}
}
function translatedView(target,text,request){translationContent(target,text);if(request){const button=make('button','translation-inspect','查看翻译请求');button.addEventListener('click',()=>inspector.show(request));target.append(button);}}
function queueTranslation(source,card,turn){
  const original=make('div','source-original');original.append(make('div','translation-heading','英文原文'));
  const blocks=parseEvidenceText(source.text),preview=evidencePreview(blocks);original.append(sourceContent(preview.blocks));
  if(preview.hasMore){const details=make('details','source-details');details.append(make('summary',null,'展开完整原文'),sourceContent(blocks));original.append(details);}card.append(original);
  const button=make('button','translation-toggle','翻译为中文');button.type='button';card.append(button);
  const view=make('div','translation-view');view.hidden=true;view.append(make('div','translation-heading','中文译文'));
  const content=make('div','translation-content'),status=make('p','translation-status');content.append(status);view.append(content);card.append(view);
  if(state.mode!=='live'||!turn?.turn_id||!state.active){button.disabled=true;button.title=state.mode==='live'?'本轮保存后可翻译':'完整问答模式下可请求中文翻译';return;}
  const key=turn.turn_id+':'+source.chunk_id,item={source,turn,owner:{...state.active},accessToken:state.accessToken,content,status,key,version:sourceVersion,queued:false,button,view};
  button.addEventListener('click',()=>{
    if(translationCache.has(key)){view.hidden=!view.hidden;if(!view.hidden){const value=translationCache.get(key);translatedView(content,value.text,value.request);}button.textContent=view.hidden?'显示中文译文':'收起中文译文';return;}
    if(item.queued)return;item.queued=true;button.disabled=true;button.textContent='翻译中…';view.hidden=false;translationQueue.push(item);void flushTranslations();
  });
}
async function flushTranslations(){
  if(translating)return;translating=true;
  try{while(translationQueue.length){
    const first=translationQueue.shift();if(first.version!==sourceVersion)continue;
    const batch=[first];for(let i=0;i<translationQueue.length&&batch.length<2;){const next=translationQueue[i];if(next.version===sourceVersion&&next.turn.turn_id===first.turn.turn_id&&next.owner.id===first.owner.id){batch.push(next);translationQueue.splice(i,1);}else i++;}
    for(const item of batch){item.status.textContent='正在翻译原文…';item.content.replaceChildren(item.status);}
    try{
      const headers={'Content-Type':'application/json','X-AsterCite-Request':'1','X-AsterCite-Session':first.owner.token};if(first.accessToken)headers.Authorization='Bearer '+first.accessToken;
      const response=await fetch(`/api/sessions/${first.owner.id}/translate`,{method:'POST',headers,body:JSON.stringify({turn_id:first.turn.turn_id,chunk_ids:batch.map(item=>item.source.chunk_id)})}),value=await response.json();
      if(!response.ok)throw new Error(value.error||'译文暂时未能生成。');
      for(const item of batch){const translated=value.items.find(row=>row.chunk_id===item.source.chunk_id);if(!translated)throw new Error('片段译文不完整。');translationCache.set(item.key,{text:translated.text,request:value.request});if(item.version===sourceVersion){translatedView(item.content,translated.text,value.request);item.button.disabled=false;item.button.textContent='收起中文译文';}item.queued=false;}
    }catch(error){for(const item of batch){if(item.version!==sourceVersion)continue;item.content.replaceChildren(make('p','translation-status',error.message));item.queued=false;item.button.disabled=false;item.button.textContent='重试中文翻译';}}
  }}finally{translating=false;}
}
function showSources(sources,active=-1){
  translationQueue=[];sourceVersion++;
  const box=$('sources');box.replaceChildren();$('source-count').textContent=String(sources.length);
  if(!sources.length){const n=make('div','empty-evidence');n.append(make('div',null,'❞'),make('h2',null,'证据就在这里'),make('p',null,'论文标题、章节和原文片段\n会随回答一起出现。'));box.append(n);return;}
  for(const [index,source] of sources.entries()){
    const card=make('article','source-card'+(active===index?' active':''));card.id='source-'+index;
    const top=make('div','source-top');top.append(make('span','source-number',String(index+1)),make('span',null,source.paper_id));
    card.append(top,make('h3',null,source.title),make('div','source-section','▤  '+source.section));
    if(source.source_url)try{const url=new URL(source.source_url);if(url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['arxiv.org','ar5iv.labs.arxiv.org'].includes(url.hostname)){const link=make('a','source-link',source.content_type==='table'?'查看表格原文':'查看公式原文');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}}catch{/* Older source records may not have a structured original. */}
    const turn=state.turns.findLast(t=>t.sources.some(s=>s.chunk_id===source.chunk_id));queueTranslation(source,card,turn);
    if(/^\d{4}\.\d{4,5}$/.test(source.paper_id)){const link=make('button','source-link','查看这篇论文的 PDF');link.addEventListener('click',()=>openPdf(source.paper_id));card.append(link);}
    box.append(card);
  }
  if(active>=0)$('source-'+active)?.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function openEvidence(){if(window.innerWidth<=950){document.querySelector('.sidebar').classList.remove('mobile-open');document.querySelector('.evidence-panel').classList.add('mobile-open');}}
function renderMessages(){
  const box=$('messages');box.replaceChildren();$('welcome').hidden=state.turns.length>0;
  for(const [index,turn] of state.turns.entries()){
    const user=make('article','message user'),head=make('div','message-heading');head.append(make('span','avatar','↗'),make('span',null,'你'));user.append(head,make('div','message-text',turn.question));box.append(user);
    const assistant=make('article','message assistant'),heading=make('div','message-heading');if(turn.turn_id)assistant.dataset.turnId=turn.turn_id;heading.append(make('span','avatar','✳'),make('span',null,'AsterCite'));assistant.append(heading);
    if(turn.coverage?.length){const chips=make('div','coverage-chips');for(const item of turn.coverage){const b=make('button','coverage-chip '+item.status,(state.papers.find(p=>p.paper_id===item.paper_id)?.title??item.paper_id)+' · '+(item.status==='addressed'?'已引用原文':'证据不足'));b.addEventListener('click',()=>openPdf(item.paper_id));chips.append(b);}assistant.append(chips);}
    const laidOut=turn.answer.replace(/(【\d{4}\.\d{4,5}[^】]*】)/gu,'\n\n### $1\n\n');
    const text=make('div','message-text');inlineText(text,displayPaperTitles(splitAnswerControl(laidOut).body,state.papers),turn.sources);assistant.append(text);
    if(turn.coverage?.length){const coverage=make('details','paper-coverage');coverage.open=true;coverage.append(make('summary',null,`本轮逐篇分析 · ${turn.coverage.length} 篇论文`));
      for(const item of turn.coverage){const row=make('div','coverage-row');row.append(make('strong',null,item.paper_id+' · '+(state.papers.find(p=>p.paper_id===item.paper_id)?.title??'')),make('span','coverage-state',item.status==='addressed'?'已引用原文':'证据不足'),make('p',null,item.summary));coverage.append(row);}assistant.append(coverage);}
    const foot=make('div','answer-footer');const sources=make('button',null,turn.sources.length+' 处原文引用');sources.addEventListener('click',()=>{pinReader();state.sourceTurn=index;showSources(turn.sources);readerTab('sources');openEvidence();});foot.append(sources);
    const process=make('button','execution-open','查看执行过程');process.addEventListener('click',()=>inspectTurn(turn));foot.append(process);
    if(turn.tasks){const progress=make('button','execution-open','查看任务进度');progress.addEventListener('click',()=>tasksPanel.open(turn.tasks));foot.append(progress);}
    if(turn.long_term_memory?.items?.length){const memory=make('button','execution-open',`使用了 ${turn.long_term_memory.items.length} 条长期记忆`);memory.addEventListener('click',()=>longMemoryPanel.open(turn.long_term_memory));foot.append(memory);}
    if(state.mode==='live')foot.append(make('span',null,'· '+Math.round(turn.elapsed_ms/1000)+' 秒'),make('span',null,'· '+(turn.tokens===null?'本轮用量未报告':'本轮累计用量 '+turn.tokens+' token')));
    else foot.append(make('span',null,'· 示例回放'));
    if(turn.stopped)foot.append(make('span','answer-status','已停止'));
    else if(turn.status!=='completed')foot.append(make('span','answer-status','本轮未完成'));
    else if(turn.execution?.state==='partial')foot.append(make('span','answer-status','部分完成'));
    else if(turn.execution?.state==='clarification')foot.append(make('span','answer-status','等待补充信息'));
    assistant.append(foot);box.append(assistant);
  }
  if(state.turns.length)showSources(state.turns.at(-1).sources);else showSources([]);
  $('export-chat').disabled=!state.turns.length;
  $('chat-scroll').scrollTop=state.turns.length?$('chat-scroll').scrollHeight:0;
}
function render(){renderPapers();renderSessions();renderScope();renderMessages();
  $('conversation-title').textContent=state.turns.length?'围绕论文，继续追问':'开始一次有依据的讨论';
  $('compact').textContent=state.pending_compaction?'压缩已安排':'查看与压缩';renderSessionPanels();
  if(state.mode==='demo'){
    const next=state.sample.turns[Math.min(state.demoIndex+1,state.sample.turns.length-1)];$('question').value=state.demoIndex>=state.sample.turns.length-1?'示例已播放完毕。点击新建对话可重新开始。':next.label;
    $('send').disabled=state.demoIndex>=state.sample.turns.length-1;
  }
}
function playDemo(index){
  if(state.busy)return;clearNotice();state.demoIndex=index;state.turns=state.sample.turns.slice(0,index+1);state.scope=[];render();
  activity.reset({replay:true});readerFollow.beginTurn();readerFollow.finish(state);renderReaderFollow();
  if(index===state.sample.turns.length-1)notice('多轮示例已播放完毕。完整问答可按使用指南部署。');
}
function openSidebar(){document.querySelector('.evidence-panel').classList.remove('mobile-open');document.querySelector('.sidebar').classList.add('mobile-open');}
async function settings(scope,compact){
  clearNotice();busy(true);try{await ensureSession();applyView(await api('/api/sessions/'+state.active.id+'/settings',{scope,compact}),{follow:false});if(compact)notice('下一次提问时执行压缩，计入该轮用量。');}
  catch(e){notice(e.message,true);}finally{busy(false);}
}
async function sendQuestion(){
  if(state.busy)return;
  if(state.mode==='demo'){if(state.demoIndex<state.sample.turns.length-1)playDemo(state.demoIndex+1);return;}
  const question=$('question').value.trim();if(!question)return;
  if(Array.from(question).length>12000){notice('问题最多 12000 字。',true);return;}
  clearNotice();busy(true);
  tasksPanel.begin();
  activity.reset({running:true,question});readerFollow.beginTurn();renderReaderFollow();
  let preview;
  try{
    await ensureMemoryProfile();await ensureSession();
    const pending=make('article','message user pending-question');pending.append(make('div','message-heading','你'),make('div','message-text',question));$('messages').append(pending);$('welcome').hidden=true;$('chat-scroll').scrollTop=$('chat-scroll').scrollHeight;
    preview=new AnswerPreview($('messages'),$('chat-scroll'),{onCitation:showCitation,onCitationHover:highlightCitation,papers:state.papers});
    const headers={'Content-Type':'application/json','X-AsterCite-Request':'1','X-AsterCite-Session':state.active.token};if(state.accessToken)headers.Authorization='Bearer '+state.accessToken;
    if(state.memoryCredential)headers['X-AsterCite-Memory']=state.memoryCredential;
    currentRequest={id:crypto.randomUUID(),session:{...state.active},stopping:false};requestControls();
    const response=await fetch('/api/sessions/'+state.active.id+'/question/stream',{method:'POST',headers,body:JSON.stringify({question,request_id:currentRequest.id})});
    if(response.status===401)$('access-dialog').showModal();
    const view=await readQuestionStream(response,event=>{if(event.context){state.context=event.context;renderSessionPanels();}readerFollow.activity(event);activity.update(event);inspector.updateRun(activity.snapshot(),{live:true});},update=>{if(update.context){state.context=update.context;renderSessionPanels();}readerFollow.answer(update);preview.update(update);},progress=>tasksPanel.update(progress));applyView(view);if(view.turns.at(-1)?.tasks)tasksPanel.update(view.turns.at(-1).tasks);activity.finish();$('question').value='';
    Object.assign(state.active,touchConversation(state.active,state.turns[0]?.question));persist();renderSessions();
    if(state.turns.at(-1)?.stopped)notice('已停止本轮，收到的回答和执行记录已保存，可以继续提问。');
    else if(state.turns.at(-1)?.status!=='completed')notice('本轮未完成，请查看执行过程中的请求结果。已发生的请求计入会话用量。',true);
  }catch(e){activity.finish(false);if(preview?.text){preview.interrupt();document.querySelector('.pending-question')?.classList.remove('pending-question');}else document.querySelector('.pending-question')?.remove();notice(e.message,true);}finally{currentRequest=null;busy(false);$('current-tasks').hidden=true;}
}
$('stop-generation').addEventListener('click',async()=>{const run=currentRequest;if(!run||run.stopping)return;run.stopping=true;requestControls();try{const result=await api('/api/sessions/'+run.session.id+'/stop',{request_id:run.id},{session:run.session});if(currentRequest===run&&!result.stopped)notice('这一轮已经完成，正在保存结果。');}catch(error){if(currentRequest===run){run.stopping=false;requestControls();notice(error.message,true);}}});
$('question-form').addEventListener('submit',e=>{e.preventDefault();void sendQuestion();});
$('question').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void sendQuestion();}});
$('paper-search').addEventListener('input',renderPapers);
$('scope-all').addEventListener('click',()=>{if(state.mode==='demo'){state.scope=[];renderScope();renderPapers();}else void settings([],state.pending_compaction);});
$('compact').addEventListener('click',()=>sessionPanel.openCompression());
$('new-chat').addEventListener('click',()=>{if(state.busy)return;clearNotice();resetConversation();busy(false);});
document.addEventListener('keydown',e=>{if(e.key==='n'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!document.querySelector('dialog[open]')&&sessionMenu.hidden)$('new-chat').click();if(e.key==='Escape'){document.querySelector('.evidence-panel').classList.remove('mobile-open');document.querySelector('.sidebar').classList.remove('mobile-open');}});
$('setup-open').addEventListener('click',()=>$('setup-dialog').showModal());
for(const [button,panel] of [['guide-demo','demo-guide'],['guide-live','live-guide']])$(button).addEventListener('click',()=>{for(const id of ['guide-demo','guide-live'])$(id).classList.toggle('selected',id===button);for(const id of ['demo-guide','live-guide'])$(id).hidden=id!==panel;});
$('memory-open').addEventListener('click',()=>{longMemoryPanel.override=null;longMemoryPanel.select('session');sessionPanel.openMemory();});
$('access-form').addEventListener('submit',e=>{e.preventDefault();state.accessToken=$('access-token').value;$('access-token').value='';$('access-dialog').close();if(readingPaper)void reader.open(readingPaper,state.accessToken,true);notice('已设置访问口令，可以开始问答。');});
$('export-chat').addEventListener('click',()=>{const blob=new Blob([JSON.stringify({application:'AsterCite',turns:state.turns},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=make('a');a.href=url;a.download='astercite-conversation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
const closeEvidence=make('button','icon-text-button','关闭');closeEvidence.setAttribute('aria-label','关闭论文阅读');closeEvidence.addEventListener('click',()=>document.querySelector('.evidence-panel').classList.remove('mobile-open'));document.querySelector('.evidence-heading').append(closeEvidence);
closeEvidence.classList.add('source-jump');
const paperMenu=make('button','icon-text-button paper-menu','论文 / 会话');paperMenu.addEventListener('click',openSidebar);document.querySelector('.conversation-actions').prepend(paperMenu);
const closeSidebar=make('button','icon-text-button close-sidebar','关闭');closeSidebar.addEventListener('click',()=>document.querySelector('.sidebar').classList.remove('mobile-open'));document.querySelector('.sidebar').prepend(closeSidebar);
async function init(){
  try{
    state.sample=await readJSON('/sample.json');
    let config;try{config=await readJSON('/api/config');if(!['demo','live'].includes(config.mode))throw new Error('模式无效');}catch{config=await readJSON('/config.json');}
    state.mode=config.mode;state.memorySupported=config.memory_supported===true;state.papers=config.papers?.length?config.papers:state.sample.papers;state.initialContext=config.context??null;state.context=state.initialContext;readerFollow.setPapers(state.papers);
    $('mode-badge').textContent=state.mode==='demo'?'示例回放':'完整问答';
    $('mode-note').textContent=state.mode==='demo'?'示例使用已保存的问答。部署后可自由提问。':'模型：'+config.model+' · 会话保存在当前问答服务';
    $('question').readOnly=state.mode==='demo';$('compact').disabled=state.mode!=='live';
    $('input-hint').textContent=state.mode==='demo'?'查看完整的多轮对话':'Enter 发送 · Shift + Enter 换行';
    const select=$('pdf-paper');for(const p of state.papers){const option=make('option',null,p.title);option.value=p.paper_id;select.append(option);}
    const examples=$('example-list');
    if(state.mode==='live'){
      showcase=(await readJSON('/showcase.json')).examples.filter(e=>e.paper_ids.every(id=>state.papers.some(p=>p.paper_id===id)));
      for(const example of showcase){const b=make('button','example-card'),copy=make('span');copy.append(make('span','example-topic',example.topic),make('span','example-title',example.title),make('span','example-paper',example.paper_ids.map(id=>state.papers.find(p=>p.paper_id===id).title).join(' + ')));b.append(copy,make('span','example-arrow','→'));
        b.addEventListener('click',async()=>{if(state.busy)return;await settings(example.paper_ids,state.pending_compaction);if(!example.paper_ids.every(id=>state.scope.includes(id)))return;$('question').value=example.question;openPdf(example.paper_ids[0]);$('question').focus();notice('已选择对应论文，点击“发送问题”开始。');});examples.append(b);}
    }else for(const index of [0,1,3]){
      const turn=state.sample.turns[index],b=make('button','example-card');
      const copy=make('span');copy.append(make('span','example-title',turn.label),make('span','example-topic',turn.topic));b.append(copy,make('span','example-arrow','↗'));
      b.addEventListener('click',()=>{if(state.mode==='demo')playDemo(index);else{$('question').value=turn.question;$('question').focus();}});examples.append(b);
    }
    render();busy(false);activity.reset({replay:state.mode==='demo'});
    const first=state.papers.find(p=>p.paper_id==='1611.09441')??state.papers[0];if(first){readingPaper=first;$('pdf-paper').value=first.paper_id;$('pdf-title').textContent=first.title;if(!config.access_token_required)readerTab('pdf');}
    if(state.mode==='live'){
      if(config.access_token_required)$('access-dialog').showModal();
      else if(listConversations(state.sessions).length){state.active=listConversations(state.sessions)[0];try{applyView(await api('/api/sessions/'+state.active.id));}catch(e){state.active=null;renderSessions();notice(e.message,true);}}
    }
  }catch{notice('页面资料未能加载，请刷新重试。',true);$('send').disabled=true;}
}
void init();
