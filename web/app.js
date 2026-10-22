import {parseEvidenceText,evidencePreview} from './evidence-format.js';

const $=id=>document.getElementById(id);
const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const state={mode:'demo',papers:[],sample:null,turns:[],scope:[],pending_compaction:false,memory:null,budget:null,busy:false,active:null,accessToken:'',demoIndex:-1,sessions:[],sourceTurn:-1};
const STORAGE='astercite.web.sessions.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
try{state.sessions=JSON.parse(localStorage.getItem(STORAGE)||'[]').filter(s=>UUID.test(s.id)&&/^[a-f0-9]{64}$/.test(s.token)&&typeof s.label==='string').slice(0,100);}catch{state.sessions=[];}
function persist(){try{localStorage.setItem(STORAGE,JSON.stringify(state.sessions));}catch{notice('浏览器没有允许保存会话列表；当前对话仍可继续。');}}
function notice(text,error=false){$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;}
function clearNotice(){$('notice').hidden=true;}
async function readJSON(path){const res=await fetch(path);if(!res.ok)throw new Error('读取失败');return res.json();}
async function api(path,body){
  const headers={'X-AsterCite-Request':'1'};
  if(body!==undefined)headers['Content-Type']='application/json';
  if(state.active)headers['X-AsterCite-Session']=state.active.token;
  if(state.accessToken)headers.Authorization='Bearer '+state.accessToken;
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();
  if(!response.ok){if(response.status===401)$('access-dialog').showModal();throw new Error(value.error||'操作未完成，请稍后再试。');}
  return value;
}
function busy(value){
  state.busy=value;$('busy-indicator').hidden=!value;
  for(const id of ['send','new-chat','compact','scope-all','question'])$(id).disabled=value;
  $('compact').disabled=value||state.mode!=='live';
  document.querySelectorAll('.paper-item,.session-item,.example-card').forEach(n=>n.disabled=value);
  $('send-label').textContent=value?'处理中':state.mode==='demo'?'播放下一问':'发送问题';
  if(value)$('chat-scroll').scrollTop=$('chat-scroll').scrollHeight;
}
function applyView(view){state.turns=view.turns;state.scope=view.scope;state.pending_compaction=view.pending_compaction;state.memory=view.memory;state.budget=view.budget;render();}
async function ensureSession(){
  if(state.active)return;
  const value=await api('/api/sessions',{});state.active={...value,label:'新对话'};
  state.sessions.unshift(state.active);persist();renderSessions();
}
function renderPapers(){
  const list=$('paper-list');list.replaceChildren();const term=$('paper-search').value.toLowerCase();
  const papers=state.papers.filter(p=>(p.title+' '+p.paper_id).toLowerCase().includes(term));
  $('paper-count').textContent=state.papers.length+' 篇';
  for(const p of papers){
    const b=make('button','paper-item'+(state.scope.includes(p.paper_id)?' selected':''));b.disabled=state.busy;b.title=p.title;
    b.append(make('span','paper-icon','▤'));const details=make('div');details.append(make('div','paper-title',p.title),make('div','paper-id',p.paper_id));b.append(details);
    b.addEventListener('click',async()=>{
      if(state.mode==='demo'){
        state.scope=[p.paper_id];renderPapers();renderScope();
        const t=state.sample.turns.find(t=>t.sources.some(s=>s.paper_id===p.paper_id));
        showSources(t.sources.filter(s=>s.paper_id===p.paper_id));return;
      }
      await settings(state.scope.includes(p.paper_id)?state.scope.filter(id=>id!==p.paper_id):[...state.scope,p.paper_id],state.pending_compaction);
    });list.append(b);
  }
  if(!papers.length)list.append(make('p','sidebar-empty','没有匹配的论文'));
}
function renderSessions(){
  const list=$('session-list');list.replaceChildren();
  if(state.mode==='demo'){
    const b=make('button','session-item selected');b.append(make('span',null,'◷'),make('span',null,'情感分析与语音表示 · 示例'));b.addEventListener('click',()=>playDemo(0));list.append(b);return;
  }
  for(const item of state.sessions){
    const b=make('button','session-item'+(state.active?.id===item.id?' selected':''));b.disabled=state.busy;
    b.append(make('span',null,'◷'),make('span',null,item.label));b.title=item.label;
    b.addEventListener('click',async()=>{clearNotice();busy(true);state.active=item;try{applyView(await api('/api/sessions/'+item.id));notice('已恢复这个会话。');}catch(e){notice(e.message,true);}finally{busy(false);}});list.append(b);
  }
  if(!state.sessions.length)list.append(make('p','sidebar-empty','你的对话会保存在这里。'));
}
function renderScope(){
  $('scope-all').classList.toggle('selected',!state.scope.length);const box=$('selected-scope');box.replaceChildren();
  for(const id of state.scope){const n=make('span','scope-chip selected',id);box.append(n);}
  $('budget-hint').textContent=state.budget?'剩余 '+state.budget.remaining_turns+' 轮':'';
}
function inlineText(target,text,sources){
  // Build text nodes and buttons; source and model text are never parsed as HTML.
  const pattern=/\[cite:([^\]]+)\]|\*\*([^*]+)\*\*/g;let position=0;
  for(const match of text.matchAll(pattern)){
    target.append(document.createTextNode(text.slice(position,match.index)));position=match.index+match[0].length;
    if(match[2]){target.append(make('strong',null,match[2]));continue;}
    const index=sources.findIndex(s=>s.chunk_id===match[1]);
    if(index<0){target.append(document.createTextNode('[引用不可用]'));continue;}
    const b=make('button','citation',String(index+1));b.setAttribute('aria-label','查看引用 '+(index+1));
    b.addEventListener('click',()=>{showSources(sources,index);openEvidence();});target.append(b);
  }
  target.append(document.createTextNode(text.slice(position)));
}
function sourceContent(blocks){
  const content=make('div','source-content');
  for(const block of blocks){
    if(block.kind==='table'){
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
function showSources(sources,active=-1){
  const box=$('sources');box.replaceChildren();$('source-count').textContent=String(sources.length);
  if(!sources.length){const n=make('div','empty-evidence');n.append(make('div',null,'❞'),make('h2',null,'证据就在这里'),make('p',null,'论文标题、章节和原文片段\n会随回答一起出现。'));box.append(n);return;}
  for(const [index,source] of sources.entries()){
    const card=make('article','source-card'+(active===index?' active':''));card.id='source-'+index;
    const top=make('div','source-top');top.append(make('span','source-number',String(index+1)),make('span',null,source.paper_id));
    card.append(top,make('h3',null,source.title),make('div','source-section','▤  '+source.section));
    const blocks=parseEvidenceText(source.text),preview=evidencePreview(blocks),excerpt=sourceContent(preview.blocks);excerpt.classList.add('source-preview');card.append(excerpt);
    if(preview.hasMore){
      const details=make('details','source-details'),summary=make('summary',null,'展开完整片段');details.append(summary,sourceContent(blocks));
      details.addEventListener('toggle',()=>{excerpt.hidden=details.open;summary.textContent=details.open?'收起完整片段':'展开完整片段';});card.append(details);
    }
    if(/^\d{4}\.\d{4,5}$/.test(source.paper_id)){const link=make('a','source-link','阅读论文 ↗');link.href='https://arxiv.org/abs/'+source.paper_id;link.target='_blank';link.rel='noopener noreferrer';card.append(link);}
    box.append(card);
  }
  if(active>=0)$('source-'+active)?.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function openEvidence(){if(window.innerWidth<=950)document.querySelector('.evidence-panel').classList.add('mobile-open');}
function renderMessages(){
  const box=$('messages');box.replaceChildren();$('welcome').hidden=state.turns.length>0;
  for(const [index,turn] of state.turns.entries()){
    const user=make('article','message user'),head=make('div','message-heading');head.append(make('span','avatar','↗'),make('span',null,'你'));user.append(head,make('div','message-text',turn.question));box.append(user);
    const assistant=make('article','message assistant'),heading=make('div','message-heading');heading.append(make('span','avatar','✳'),make('span',null,'AsterCite'));assistant.append(heading);
    const text=make('div','message-text');for(const paragraph of turn.answer.split(/\n\n+/)){const p=make('p','answer-paragraph');inlineText(p,paragraph,turn.sources);text.append(p);}assistant.append(text);
    const foot=make('div','answer-footer');const sources=make('button',null,turn.sources.length+' 处原文引用');sources.addEventListener('click',()=>{state.sourceTurn=index;showSources(turn.sources);openEvidence();});foot.append(sources);
    if(state.mode==='live')foot.append(make('span',null,'· '+Math.round(turn.elapsed_ms/1000)+' 秒'),make('span',null,'· '+(turn.tokens===null?'token 未报告':turn.tokens+' token')));
    else foot.append(make('span',null,'· 示例回放'));
    if(turn.status!=='completed')foot.append(make('span','answer-status','本轮未完成'));
    assistant.append(foot);box.append(assistant);
  }
  if(state.turns.length)showSources(state.turns.at(-1).sources);else showSources([]);
  $('export-chat').disabled=!state.turns.length;
  $('chat-scroll').scrollTop=state.turns.length?$('chat-scroll').scrollHeight:0;
}
function render(){renderPapers();renderSessions();renderScope();renderMessages();
  $('conversation-title').textContent=state.turns.length?'围绕论文，继续追问':'开始一次有依据的讨论';
  $('compact').textContent=state.pending_compaction?'下一问将压缩':'压缩上下文';
  if(state.mode==='demo'){
    const next=state.sample.turns[Math.min(state.demoIndex+1,state.sample.turns.length-1)];$('question').value=state.demoIndex>=state.sample.turns.length-1?'示例已播放完毕。点击新建对话可重新开始。':next.label;
    $('send').disabled=state.demoIndex>=state.sample.turns.length-1;
  }
}
function playDemo(index){
  if(state.busy)return;clearNotice();state.demoIndex=index;state.turns=state.sample.turns.slice(0,index+1);state.scope=[];render();
  if(index===state.sample.turns.length-1)notice('多轮示例已播放完毕。完整问答可按使用指南部署。');
}
function openSidebar(){document.querySelector('.sidebar').classList.add('mobile-open');}
async function settings(scope,compact){
  clearNotice();busy(true);try{await ensureSession();applyView(await api('/api/sessions/'+state.active.id+'/settings',{scope,compact}));if(compact)notice('下一次提问时执行压缩，计入该轮用量。');}
  catch(e){notice(e.message,true);}finally{busy(false);}
}
async function sendQuestion(){
  if(state.busy)return;
  if(state.mode==='demo'){if(state.demoIndex<state.sample.turns.length-1)playDemo(state.demoIndex+1);return;}
  const question=$('question').value.trim();if(!question)return;
  if(Array.from(question).length>12000){notice('问题最多 12000 字。',true);return;}
  clearNotice();busy(true);
  try{
    await ensureSession();const view=await api('/api/sessions/'+state.active.id+'/question',{question});applyView(view);$('question').value='';
    state.active.label=state.turns[0]?.question.slice(0,32)||'新对话';persist();renderSessions();
    if(state.turns.at(-1)?.status!=='completed')notice('本轮未完成，请检查模型服务。已发生的请求计入会话用量。',true);
  }catch(e){notice(e.message,true);}finally{busy(false);}
}
$('question-form').addEventListener('submit',e=>{e.preventDefault();void sendQuestion();});
$('question').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();void sendQuestion();}});
$('paper-search').addEventListener('input',renderPapers);
$('scope-all').addEventListener('click',()=>{if(state.mode==='demo'){state.scope=[];renderScope();renderPapers();}else void settings([],state.pending_compaction);});
$('compact').addEventListener('click',()=>void settings(state.scope,!state.pending_compaction));
$('new-chat').addEventListener('click',()=>{if(state.busy)return;state.active=null;state.turns=[];state.scope=[];state.memory=null;state.budget=null;state.pending_compaction=false;state.demoIndex=-1;clearNotice();render();busy(false);if(state.mode==='live'){$('question').value='';$('question').focus();}});
document.addEventListener('keydown',e=>{if(e.key==='n'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)&&!document.querySelector('dialog[open]'))$('new-chat').click();if(e.key==='Escape'){document.querySelector('.evidence-panel').classList.remove('mobile-open');document.querySelector('.sidebar').classList.remove('mobile-open');}});
$('setup-open').addEventListener('click',()=>$('setup-dialog').showModal());
for(const [button,panel] of [['guide-demo','demo-guide'],['guide-live','live-guide']])$(button).addEventListener('click',()=>{for(const id of ['guide-demo','guide-live'])$(id).classList.toggle('selected',id===button);for(const id of ['demo-guide','live-guide'])$(id).hidden=id!==panel;});
$('memory-open').addEventListener('click',()=>{
  const content=$('memory-content');content.replaceChildren();
  if(state.mode==='demo'){content.append(make('p',null,'这个示例展示了追问、论文切换和语言偏好纠正。完整问答模式可以在这里查看当前会话记忆。'));}
  else{const rows=[['当前论文',state.memory?.paper_id||'尚未确定'],['对比论文',state.memory?.comparison.join('、')||'无'],['比较维度',state.memory?.dimensions.join('、')||'无'],['回答偏好',state.memory?.preferences.map(p=>p.key+'：'+p.value).join('；')||'无'],['上下文压缩',state.pending_compaction?'下一问执行':'按会话配置执行']];for(const [key,value] of rows){const row=make('div','memory-row');row.append(make('span',null,key),make('span',null,value));content.append(row);}}
  $('memory-dialog').showModal();
});
$('access-form').addEventListener('submit',e=>{e.preventDefault();state.accessToken=$('access-token').value;$('access-token').value='';$('access-dialog').close();notice('已设置访问口令，可以开始问答。');});
$('export-chat').addEventListener('click',()=>{const blob=new Blob([JSON.stringify({application:'AsterCite',turns:state.turns},null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=make('a');a.href=url;a.download='astercite-conversation.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
const closeEvidence=make('button','icon-text-button','关闭');closeEvidence.setAttribute('aria-label','关闭原文依据');closeEvidence.addEventListener('click',()=>document.querySelector('.evidence-panel').classList.remove('mobile-open'));document.querySelector('.evidence-heading').append(closeEvidence);
closeEvidence.classList.add('source-jump');
const paperMenu=make('button','icon-text-button paper-menu','论文 / 会话');paperMenu.addEventListener('click',openSidebar);document.querySelector('.conversation-actions').prepend(paperMenu);
const closeSidebar=make('button','icon-text-button close-sidebar','关闭');closeSidebar.addEventListener('click',()=>document.querySelector('.sidebar').classList.remove('mobile-open'));document.querySelector('.sidebar').prepend(closeSidebar);
async function init(){
  try{
    state.sample=await readJSON('/sample.json');
    let config;try{config=await readJSON('/api/config');if(!['demo','live'].includes(config.mode))throw new Error('模式无效');}catch{config=await readJSON('/config.json');}
    state.mode=config.mode;state.papers=config.papers?.length?config.papers:state.sample.papers;
    $('mode-badge').textContent=state.mode==='demo'?'示例回放':'完整问答';
    $('mode-note').textContent=state.mode==='demo'?'示例使用已保存的问答。部署后可自由提问。':'模型：'+config.model+' · 会话保存在当前问答服务';
    $('question').readOnly=state.mode==='demo';$('compact').disabled=state.mode!=='live';
    $('input-hint').textContent=state.mode==='demo'?'查看完整的多轮对话':'Enter 发送 · Shift + Enter 换行';
    const examples=$('example-list');
    for(const index of [0,1,3]){
      const turn=state.sample.turns[index],b=make('button','example-card');b.append(make('span','example-number',String(index===3?3:index+1).padStart(2,'0')));
      const copy=make('span');copy.append(make('span','example-title',turn.label),make('span','example-topic',turn.topic));b.append(copy,make('span','example-arrow','↗'));
      b.addEventListener('click',()=>{if(state.mode==='demo')playDemo(index);else{$('question').value=turn.question;$('question').focus();}});examples.append(b);
    }
    render();busy(false);
    if(state.mode==='live'){
      if(config.access_token_required)$('access-dialog').showModal();
      else if(state.sessions.length){state.active=state.sessions[0];try{applyView(await api('/api/sessions/'+state.active.id));}catch(e){notice(e.message,true);}}
    }
  }catch{notice('页面资料未能加载，请刷新重试。',true);$('send').disabled=true;}
}
void init();
