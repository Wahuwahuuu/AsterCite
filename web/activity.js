const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};

export class ActivityPanel {
  constructor(root,onOpen=()=>{}){this.root=root;this.onOpen=onOpen;this.items=[];this.running=false;this.replay=false;this.timer=null;this.outcome=null;this.render();}
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
    const models=this.items.filter(e=>e.kind==='model'),tools=this.items.filter(e=>e.kind==='tool');
    const graph=make('div','loop-graph');graph.setAttribute('aria-label','模型请求，调用工具，观察返回，再回到模型请求');
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 660 112');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','M185 65 H245 M415 65 H475 M560 39 C560 4 100 4 100 39');path.setAttribute('fill','none');path.setAttribute('stroke','#91aa7d');path.setAttribute('stroke-width','1.6');svg.append(path);
    for(const [x,y] of [[242,65],[472,65],[100,38]]){const arrow=document.createElementNS(svg.namespaceURI,'path');arrow.setAttribute('d',y===38?`M${x-4} ${y-6} L${x} ${y} L${x+4} ${y-6}`:`M${x-6} ${y-4} L${x} ${y} L${x-6} ${y+4}`);arrow.setAttribute('fill','none');arrow.setAttribute('stroke','#688552');arrow.setAttribute('stroke-width','1.6');svg.append(arrow);}graph.append(svg,make('span','loop-return-label','带着结果继续判断'));
    for(const [index,label,selected,sub] of [[0,'模型请求',models.at(-1),models.length+' 次'],[1,'工具调用',tools.at(-1),tools.length+' 次'],[2,'观察返回',tools.at(-1),tools.filter(e=>e.status==='completed').length+' 次返回']]){
      const active=index===2?selected?.status==='completed'&&this.running&&!current:selected?.status==='running';
      const b=make('button','loop-node node-'+index+(active?' active':''));b.type='button';b.disabled=!selected?.has_details;
      b.append(make('strong',null,label),make('span',null,sub));if(selected)b.addEventListener('click',()=>this.onOpen(selected));graph.append(b);
    }root.append(graph);
    if(this.items.length){
      const details=make('details','activity-details');details.open=this.running;
      details.append(make('summary',null,`展开调用循环 · ${models.length} 次模型请求 · ${tools.length} 次工具调用`));
      const list=make('ol','activity-list');
      const rounds=new Map(models.map((item,index)=>[item.id,{model:item,number:item.cycle??index+1,tools:[]}]));let previous=null;
      for(const item of this.items){if(item.kind==='model')previous=item.id;else if(item.kind==='tool')rounds.get(item.parent_id??previous)?.tools.push(item);}
      const show=(item,label)=>{const b=make('button','loop-detail-button',label);b.disabled=!item.has_details;b.addEventListener('click',()=>this.onOpen(item));return b;};
      for(const round of rounds.values()){
        const row=make('li','loop-round '+round.model.status),top=make('div','loop-round-heading');top.append(make('strong',null,`第 ${round.number} 次 · ${round.model.label}`),show(round.model,'输入 / 输出'));row.append(top);
        for(const tool of round.tools){const action=make('div','loop-action');action.append(make('code',null,tool.tool),make('span','loop-origin',tool.origin==='host_plan'?'检索计划':'模型选择'),show(tool,'参数 / 返回'),make('p',null,tool.detail));row.append(action);}
        row.append(make('p','loop-feedback',round.tools.length?'工具结果已送回上下文'+(round.number<models.length?'，进入下一次模型请求':''):round.model.status==='running'?'模型正在处理本次上下文':this.outcome==='error'?'本轮未完成，可查看返回信息':round.number===models.length?'本轮回答与记忆已整理':'继续执行检索计划'));list.append(row);
      }details.append(list);root.append(details);
      if(this.running)list.scrollTop=list.scrollHeight;
    }else root.append(make('p','activity-idle',this.replay?'当前为已保存的问答示例。':'模型读取上下文，调用工具获取证据，再根据结果继续判断。点击节点可查看详情。'));
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
