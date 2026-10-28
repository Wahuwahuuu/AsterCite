const states={pending:'等待执行',running:'正在处理',retrieved:'已取得原文',supported:'依据已核对',answered:'已说明',gap:'缺少依据',stopped:'已停止',unconfirmed:'未单独核对'};
export function taskSummary(progress){const items=(progress?.items??[]).filter(item=>!['understand','answer'].includes(item.id)&&!item.id.startsWith('source:'));const done=items.filter(item=>item.state==='answered').length;return {total:items.length,done,gaps:items.filter(item=>item.state==='gap').length};}
const make=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
export class TaskProgressPanel {
  constructor({dialog,content,button,papers,onPaper}){Object.assign(this,{dialog,content,button,papers,onPaper});button.addEventListener('click',()=>this.open());}
  begin(){this.current=null;this.following=false;this.button.hidden=true;}
  update(progress){this.current=progress;const summary=taskSummary(progress);this.button.hidden=false;this.button.textContent=summary.total?`任务进度 · 已说明 ${summary.done}/${summary.total}`:'查看任务进度';if(this.following&&this.dialog.open)this.render(progress);}
  open(progress){this.following=!progress;this.render(progress??this.current);if(!this.dialog.open)this.dialog.showModal();}
  render(progress){
    this.content.replaceChildren();if(!progress){this.content.append(make('p',null,'正在理解问题，任务列表即将出现。'));return;}
    const summary=taskSummary(progress),phase={running:'正在执行',completed:'本轮已结束',partial:'本轮部分完成',stopped:'已停止',clarification:'等待补充信息'}[progress.phase]??'本轮任务';
    this.content.append(make('p','task-overview',`${phase} · 已说明 ${summary.done}/${summary.total} 项${summary.gaps?` · ${summary.gaps} 项缺少依据`:''}`));
    const table=make('table','task-table'),head=make('tr');for(const text of ['论文 / 任务','进度','说明'])head.append(make('th',null,text));const thead=make('thead');thead.append(head);table.append(thead);const body=make('tbody');
    for(const item of progress.items){const row=make('tr'),name=make('td');if(item.paper_id){const title=this.papers().find(paper=>paper.paper_id===item.paper_id)?.title??item.paper_id,link=make('button','task-paper',title);link.addEventListener('click',()=>this.onPaper(item.paper_id));name.append(link);}name.append(make('span','task-label',item.label));const status=make('td');status.append(make('span','task-state '+item.state,states[item.state]??'等待执行'));const note=make('td',null,item.note||'—');if(item.source_ids?.length)note.append(make('span','task-source-count',`关联 ${item.source_ids.length} 处原文`));row.append(name,status,note);body.append(row);}
    table.append(body);this.content.append(table,make('p','task-note','取得原文只表示检索已返回片段。逐项说明会关联实际原文；未单独核对的任务会保留提示。'));
  }
}
