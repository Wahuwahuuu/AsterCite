const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const number=value=>typeof value==='number'?Math.round(value).toLocaleString('zh-CN'):'待统计';
const time=value=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'';
const labels={language:'回答语言',format:'回答格式',style:'表达方式',detail:'详细程度',verbosity:'详细程度',answer_language:'回答语言'};
export function compressionChange(record){const change=record.before_tokens-record.after_tokens;return {tokens:change,percent:record.before_tokens?change/record.before_tokens*100:0};}

export class SessionPanel {
  constructor({onSchedule,onJump,onPaper}){this.onSchedule=onSchedule;this.onJump=onJump;this.onPaper=onPaper;this.data={};document.getElementById('context-open').addEventListener('click',()=>this.openCompression());}
  update(data){this.data=data;this.renderMeter();if(document.getElementById('memory-dialog').open)this.renderMemory();if(document.getElementById('compression-dialog').open)this.renderCompression();}
  paperName(id){return this.data.papers?.find(p=>p.paper_id===id)?.title??id;}
  turnNumber(id){const index=this.data.turns?.findIndex(t=>t.turn_id===id)??-1;return index<0?'来源对话':'第 '+(index+1)+' 轮';}
  source(id){const button=node('button','memory-origin',this.turnNumber(id));button.type='button';button.addEventListener('click',()=>this.onJump(id));return button;}
  row(label,text){const row=node('div','memory-row');row.append(node('span',null,label),node('span',null,text));return row;}
  renderMeter(){
    const context=this.data.context,button=document.getElementById('context-open'),progress=document.getElementById('context-progress'),label=document.getElementById('context-label');
    button.hidden=this.data.mode!=='live';if(button.hidden)return;progress.value=Math.min(100,context?.percent??0);progress.setAttribute('aria-label','上下文占用');
    const usageName=context?.stage==='compaction'?'压缩后上下文':context?.basis==='provider'?'最近主请求占用':'上下文估算';
    label.textContent=context?`${usageName} ${context.basis==='estimate'?'约 ':''}${number(context.used_tokens)} / ${number(context.window_tokens)} token${context.percent===null?'':' · '+context.percent.toFixed(1)+'%'} · ${context.auto_enabled?'80% 自动压缩':'自动压缩关闭'}`:'上下文用量待连接';
    button.title='查看当前上下文用量、保留策略和压缩前后对比';button.dataset.level=(context?.percent??0)>=80?'high':'normal';
  }
  openMemory(){this.renderMemory();document.getElementById('memory-dialog').showModal();}
  renderMemory(){
    const content=document.getElementById('memory-content');content.replaceChildren();
    if(this.data.mode!=='live'){content.append(node('p',null,'示例回放没有独立会话记忆。完整问答时，这里显示实际保存并用于后续回答的内容。'));return;}
    const memory=this.data.memory??{},notes=memory.notes??[],latest=this.data.turns?.at(-1)?.turn_id;
    content.append(node('p','panel-intro','这里是当前会话实际保存的记忆。对话摘记会用于后续提问，点击来源轮次可查看完整回答。'));
    const objects=memory.comparison?.length?memory.comparison:memory.paper_id?[memory.paper_id]:[];
    const objectRow=node('div','memory-row');objectRow.append(node('span',null,objects.length>1?'讨论论文':'当前论文'));const objectList=node('div','memory-objects');
    for(const id of objects){const button=node('button','memory-paper',this.paperName(id));button.type='button';button.addEventListener('click',()=>{document.getElementById('memory-dialog').close();this.onPaper(id);});objectList.append(button);}
    if(!objects.length)objectList.append(node('span',null,'尚未开始论文讨论'));if(memory.object_source_turn)objectList.append(this.source(memory.object_source_turn));objectRow.append(objectList);content.append(objectRow,this.row('比较维度',memory.dimensions?.join('、')||'尚未记录比较维度'));
    const preferences=node('section','memory-section');preferences.append(node('h3',null,'回答偏好'));
    for(const item of memory.preferences??[]){const row=this.row(labels[item.key]??item.key,item.value);if(item.source_turn)row.lastChild.append(' ',this.source(item.source_turn));preferences.append(row);}
    if(!memory.preferences?.length)preferences.append(node('p',null,'尚未记录语言、格式等偏好。'));content.append(preferences);
    const section=node('section','memory-section');section.append(node('h3',null,'正在保留的对话摘记'));
    for(const note of [...notes].reverse()){
      const card=node('article','memory-note'),heading=node('div','memory-note-heading');heading.append(this.source(note.source_turn));if(note.source_turn===latest)heading.append(node('span','memory-new','本轮更新'));if(note.status==='partial')heading.append(node('span','memory-status','有待补充'));
      card.append(heading,node('h4',null,note.question),node('div','memory-note-text',note.answer_excerpt+(note.excerpt_truncated?'\n…（摘记到此，完整回答见来源轮次）':'')));
      if(note.paper_ids.length)card.append(node('p','memory-paper-names',note.paper_ids.map(id=>this.paperName(id)).join('；')));
      if(note.citations.length)card.append(node('span','memory-reference-count',`保留 ${note.citations.length} 处原文引用，随来源回答查看`));section.append(card);
    }
    if(!notes.length)section.append(node('p',null,'完成一次问答后，这里会显示实际保存的问题、回答摘记和引用。'));content.append(section);
    if(memory.unresolved?.length){const gaps=node('section','memory-section');gaps.append(node('h3',null,'待解决的问题'));for(const item of memory.unresolved){const p=node('p',null,item.text+'：'+item.gap+' ');p.append(this.source(item.source_turn));gaps.append(p);}content.append(gaps);}
    for(const [key,title] of [['findings','已记录的研究说明'],['inferences','待核实的推断']])if(memory[key]?.length){const section=node('section','memory-section');section.append(node('h3',null,title));for(const item of memory[key]){const p=node('p',null,item.text+' ');p.append(this.source(item.source_turn));section.append(p);}content.append(section);}
    if(this.data.context?.compressions.some(record=>record.status==='completed')){const link=node('button','panel-link','查看压缩时保存的摘要');link.type='button';link.addEventListener('click',()=>{document.getElementById('memory-dialog').close();this.openCompression();});content.append(link);}
  }
  openCompression(){this.renderCompression();document.getElementById('compression-dialog').showModal();}
  summary(container,text){
    try{const data=JSON.parse(text);container.append(node('p',null,'以下内容是本次压缩实际保存的摘要。'));const memory=data.domain_memory;
      if(memory){const ids=memory.comparison_order?.length?memory.comparison_order:memory.current_paper?[memory.current_paper.paper_id]:[];if(ids.length)container.append(this.row('讨论论文',ids.map(id=>this.paperName(id)).join('；')));
        for(const p of memory.user_constraints??[])container.append(this.row(labels[p.key]??p.key,p.value));
        for(const note of memory.reading_notes??[]){const card=node('article','memory-note');card.append(node('h4',null,note.question),node('div','memory-note-text',note.answer_excerpt),this.source(note.source_turn));container.append(card);}
        for(const finding of memory.conclusion_candidates??[])container.append(node('p',null,finding.text));for(const gap of memory.unresolved_questions??[])container.append(node('p',null,gap.text+'：'+gap.gap));
      }
      for(const entry of data.conversation_only??[]){const item=node('p',null,entry.user_text);if(entry.final_answer)item.append(node('div','memory-note-text',entry.final_answer));container.append(item);}
    }catch{container.append(node('div','memory-note-text',text));}
  }
  renderCompression(){
    const content=document.getElementById('compression-content');content.replaceChildren();const context=this.data.context;
    if(this.data.mode!=='live'||!context){content.append(node('p',null,'连接完整问答服务后，可查看上下文用量和压缩记录。'));return;}
    const policy=context.policy,stats=node('div','context-stats');
    for(const [label,value] of [[context.basis==='provider'?'最近主请求占用':'上下文估算',(context.basis==='estimate'?'约 ':'')+number(context.used_tokens)+' token'],['上下文容量',number(context.window_tokens)+' token'],['剩余空间',number(context.remaining_tokens)+' token'],['自动触发',context.auto_enabled?'80% · '+number(policy.threshold_tokens)+' token':'已关闭']]){const stat=node('div');stat.append(node('span',null,label),node('strong',null,value));stats.append(stat);}content.append(stats);
    content.append(node('p','panel-intro',context.basis==='provider'?'占用来自最近一次模型请求的输入与输出统计，不是整个会话的累计消耗。':context.basis==='estimate'?'当前用量为本地估算；模型返回用量后会更新。压缩前后统一使用本地估算比较。':'首次提问后开始统计当前上下文用量。'));
    content.append(node('p',null,`手动和自动压缩使用相同策略：保留约 ${number(policy.keep_recent_tokens)} token 的近期对话，将早期内容整理为摘要，并保留论文对象、回答偏好与对话摘记。完整聊天记录仍可查看。`));
    const action=node('button','primary-button',this.data.pending?'取消已安排的压缩':'安排下一问前压缩');action.type='button';action.disabled=this.data.busy||!context.auto_enabled;action.addEventListener('click',()=>void this.onSchedule(!this.data.pending));content.append(action);
    content.append(node('p',this.data.pending?'compression-pending':'panel-intro',this.data.pending?'已安排：将在下一次提问前执行，完成后会显示实际对比。':'压缩会在下一问前执行；近期内容不足时会保留原上下文。'));
    const records=context.compressions??[],history=node('section','memory-section');history.append(node('h3',null,'压缩记录'));if(!records.length)history.append(node('p',null,'尚未执行压缩。执行后可查看前后用量与实际保存的摘要。'));
    for(const record of [...records].reverse()){
      const card=node('details','compression-record');card.open=record.id===records.at(-1)?.id;card.append(node('summary',null,`${record.reason==='manual'?'手动':'自动'} · ${time(record.finished_at)} · ${record.status==='completed'?'已完成':record.status==='unchanged'?'无需压缩':'未完成'}`));
      const change=compressionChange(record),comparison=node('div','compression-comparison');comparison.append(node('strong',null,`${number(record.before_tokens)} → ${number(record.after_tokens)} token`),node('span',null,change.tokens>=0?`减少 ${number(change.tokens)} token（${change.percent.toFixed(1)}%）`:`增加 ${number(-change.tokens)} token（摘要与保留内容合计）`));card.append(comparison,node('p',null,`${record.before_messages} → ${record.after_messages} 条上下文消息 · 前后均为本地估算`),node('p',null,record.note));
      if(record.summary){const saved=node('details','saved-summary');saved.append(node('summary',null,'查看实际保存的摘要'));this.summary(saved,record.summary);card.append(saved);}history.append(card);
    }content.append(history);
  }
}
