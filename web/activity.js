const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

export class ActivityPanel {
  constructor(root){this.root=root;this.items=[];this.running=false;this.replay=false;this.timer=null;this.outcome=null;this.render();}
  reset({running=false,replay=false,items=[],outcome=null}={}){
    clearInterval(this.timer);this.items=items.slice(0,100);this.running=running;this.replay=replay;this.outcome=outcome;this.started=Date.now();
    this.render();if(running)this.timer=setInterval(()=>this.updateTime(),1000);
  }
  update(item){const index=this.items.findIndex(e=>e.id===item.id);if(index<0)this.items.push(item);else this.items[index]=item;this.render();}
  finish(ok=true){clearInterval(this.timer);this.running=false;this.outcome=ok?'completed':'error';for(const e of this.items)if(e.status==='running')e.status=ok?'completed':'error';this.render();}
  updateTime(){const n=this.root.querySelector('.activity-time');if(n)n.textContent=Math.floor((Date.now()-this.started)/1000)+' 秒';}
  render(){
    const root=this.root;root.replaceChildren();root.classList.toggle('is-running',this.running);
    const head=make('div','activity-heading'),title=make('div','activity-title');
    title.append(make('span','activity-signal'),make('strong',null,'Agent 执行过程'));
    const current=[...this.items].reverse().find(e=>e.status==='running');
    const status=this.replay?'示例回放':this.running?(current?.label||'正在连接问答服务'):this.outcome==='error'?'本轮未完成':this.items.length?'本轮执行完成':'等待提问';
    const note=make('span','activity-current',status);note.setAttribute('role','status');head.append(title,note,make('span','activity-time',this.running?'0 秒':''));root.append(head);
    const rail=make('ol','activity-rail');
    for(const [kind,label] of [['model','理解与决策'],['tool','工具与观察'],['answer','整理回答'],['memory','会话记忆']]){
      const matches=this.items.filter(e=>kind==='answer'?e.kind==='model'&&e.label.includes('回答'):kind==='model'?e.kind==='model'&&!e.label.includes('回答'):e.kind===kind);
      const active=matches.some(e=>e.status==='running');const completed=matches.length&&matches.every(e=>e.status==='completed');
      const item=make('li',active?'active':completed?'done':'',label);rail.append(item);
    }root.append(rail);
    if(this.items.length){
      const details=make('details','activity-details');details.open=this.running;
      details.append(make('summary',null,`查看执行记录 · ${this.items.length} 项`));
      const list=make('ol','activity-list');
      for(const item of this.items){
        const row=make('li','activity-row '+item.status),copy=make('div');copy.append(make('strong',null,item.label));
        if(item.tool)copy.append(make('code','activity-tool',item.tool));copy.append(make('p',null,item.detail));
        row.append(make('span','activity-marker'),copy,make('span','activity-stamp',(item.elapsed_ms/1000).toFixed(1)+'s'));list.append(row);
      }details.append(list);root.append(details);
      if(this.running)list.scrollTop=list.scrollHeight;
    }else root.append(make('p','activity-idle',this.replay?'当前为已保存的问答示例。':'发送问题后，这里会实时展示模型请求、工具调用和结果。'));
    if(this.running)this.updateTime();
  }
}

/** POST streams retain ownership headers; transport loss never retries an inference. */
export async function readQuestionStream(response,onActivity){
  if(!response.ok){const error=await response.json();throw new Error(error.error||'问答服务未能连接。');}
  if(!response.body)throw new Error('浏览器未能读取执行过程，请刷新后恢复会话。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',result;
  try{
    while(true){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});
      let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;
        const item=JSON.parse(line);if(item.type==='activity')onActivity(item.event);else if(item.type==='result')result=item.view;else if(item.type==='error')throw new Error(item.error);
      }
      if(pending.length>2000000)throw new Error('问答响应过长，请刷新后查看会话。');if(done)break;
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!result)throw new Error('连接已中断。服务可能仍在处理，稍后刷新恢复本轮结果。');return result;
}
