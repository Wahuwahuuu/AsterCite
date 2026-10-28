import {renderTrace} from './trace-view.js';

const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function executionTime(ms){const seconds=Math.floor(Math.max(0,ms)/1000);return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+(seconds%60)+' 秒';}
function modelNode(item,detail){
  const stage=(detail?.stage??'')+' '+(item.label??''),phase=detail?.phase??'';
  if(/nlu|prepar|question_frame|understand|intent|理解|意图|压缩/iu.test(stage))return 'understand';
  if(/generat|closing|repair|final|整理回答|生成回答/iu.test(stage)||/generat/iu.test(phase))return 'generate';
  if(/nlu|prepar|compaction/iu.test(phase))return 'understand';
  return 'decision';
}

/** Reconstruct only timestamps supported by the saved record. Old elapsed_ms was cumulative. */
export function buildExecutionTimeline(turn,details={}){
  const events=[{key:'question',at:0,node:'question',kind:'question',moment:'point',title:'收到问题',status:'completed'}];
  const activities=turn.activity??[];
  for(const [order,item] of activities.entries()){
    const detail=details[item.id],end=finite(detail?.turn_elapsed_ms)&&detail.status===item.status?detail.turn_elapsed_ms:finite(item.elapsed_ms)?item.elapsed_ms:0;
    const modern=typeof detail?.started_at==='string'&&finite(detail?.turn_elapsed_ms)&&finite(detail?.elapsed_ms);
    const target=item.kind==='model'?modelNode(item,detail):item.kind==='tool'?'action':item.kind==='compaction'?'understand':'memory';
    const name=item.kind==='tool'?(item.tool??detail?.tool??'工具'):item.kind==='model'?`第 ${detail?.cycle??item.cycle??order+1} 次模型请求`:item.label;
    const base={id:item.id,kind:item.kind,item,detail,name,order,status:item.status};
    if(modern||item.status==='running'){
      const at=modern?Math.max(0,detail.turn_elapsed_ms-detail.elapsed_ms):end;
      events.push({...base,key:item.id+':start',at,node:target,moment:'start',title:item.kind==='tool'?'调用工具 · '+name:item.kind==='model'?name+' · 发送上下文':name+' · 开始',status:'running'});
    }
    if(item.status!=='running')events.push({...base,key:item.id+':end',at:end,node:item.kind==='tool'?'observation':target,moment:'end',title:item.kind==='tool'?'观察返回 · '+name:item.kind==='model'?name+' · 收到输出':name,status:item.status,legacy:!modern&&(item.kind==='model'||item.kind==='tool')});
  }
  events.sort((a,b)=>a.at-b.at||(a.kind==='question'?-1:b.kind==='question'?1:(a.order??0)-(b.order??0))||(a.moment==='start'?-1:1));
  const duration=Math.max(finite(turn.elapsed_ms)?turn.elapsed_ms:0,...events.map(event=>event.at));
  if(turn.status!=='running'&&activities.length)events.push({key:'finish',at:duration,node:events.at(-1).node,kind:'finish',moment:'point',title:turn.status==='completed'?'本轮完成':'本轮结束',status:turn.status});
  for(let index=1;index<events.length;index++){
    const previous=events[index-1],event=events[index];
    if(previous.node!==event.node)event.edge=previous.node+'-'+event.node;
    else if(event.node==='generate'&&event.moment==='start'&&event.id!==previous.id&&event.detail?.stage==='citation_repair')event.edge='generate-generate';
  }
  return {events,duration,hasRecords:activities.length>0};
}

export function executionIndexAt(timeline,at){
  let low=0,high=timeline.events.length-1;
  while(low<high){const mid=Math.ceil((low+high)/2);if(timeline.events[mid].at<=at)low=mid;else high=mid-1;}return low;
}

/** Historical start events must not reveal their future output or final duration. */
export function executionDetailAt(detail,event){
  if(!detail)return null;
  return event.moment==='start'?{...detail,status:'running',output:undefined,elapsed_ms:0,playback_pending:true}:detail;
}

/** The conversation keeps a short live status; complete history belongs to each reply. */
export class ActivityPanel {
  constructor(root,onOpen=()=>{}){this.root=root;this.onOpen=onOpen;this.items=[];this.running=false;this.started=Date.now();this.render();}
  reset({running=false,items=[],question=''}={}){clearInterval(this.timer);this.items=items.slice();this.running=running;this.question=question;this.started=Date.now();this.render();if(running)this.timer=setInterval(()=>this.updateTime(),1000);}
  update(item){const index=this.items.findIndex(e=>e.id===item.id);if(index<0)this.items.push(item);else this.items[index]=item;this.render();}
  finish(){clearInterval(this.timer);this.running=false;this.render();}
  snapshot(){return {question:this.question,answer:'',turn_id:this.items.find(item=>item.turn_id)?.turn_id,status:this.running?'running':'error',elapsed_ms:Date.now()-this.started,activity:this.items.slice()};}
  updateTime(){const n=this.root.querySelector('.activity-time');if(n)n.textContent=executionTime(Date.now()-this.started);}
  render(){
    this.root.replaceChildren();this.root.hidden=!this.running;if(!this.running)return;
    const line=make('div','activity-heading'),current=this.items.findLast(item=>item.status==='running');
    const status=make('span','activity-current',current?.label??'正在连接问答服务');status.setAttribute('role','status');
    const button=make('button','execution-open','查看执行过程');button.type='button';button.disabled=!this.items.some(item=>item.turn_id);button.addEventListener('click',()=>this.onOpen());
    line.append(make('span','spinner'),status,make('span','activity-time',executionTime(Date.now()-this.started)),button);this.root.append(line);
  }
}

const SVG='http://www.w3.org/2000/svg';
function vector(tag,attributes={},text){const n=document.createElementNS(SVG,tag);for(const [key,value] of Object.entries(attributes))n.setAttribute(key,String(value));if(text!==undefined)n.textContent=text;return n;}
let graphId=0;
const graphNodes=[
  ['question',18,116,112,'用户问题','输入'],['understand',164,116,146,'理解与准备','上下文 / 检索计划'],
  ['decision',370,116,144,'模型决策','是否调用工具'],['action',562,116,144,'调用工具','执行检索'],
  ['observation',754,116,144,'观察返回','读取工具结果'],['generate',958,116,130,'整理回答','生成 / 引用检查'],['memory',1118,116,92,'会话记忆','更新状态']
];
const graphEdges=[
  ['question-understand','M130 145 H164'],['understand-decision','M310 145 H370'],
  ['decision-action','M514 145 H562'],['action-observation','M706 145 H754'],
  ['observation-decision','M826 116 V66 H442 V116','带着结果继续判断',634,55],
  ['understand-action','M310 145 H334 V222 H634 V174','检索计划',450,213],
  ['observation-action','M826 174 V222 H634 V174','按计划继续',755,213],
  ['observation-generate','M898 145 H958'],['decision-generate','M442 116 V22 H1023 V116','直接生成',1023,15],
  ['understand-generate','M237 116 V22 H1023 V116'],['generate-memory','M1088 145 H1118'],
  ['generate-generate','M1000 116 C960 65 1085 65 1045 116','检查后修正',1023,70]
];

export class ExecutionPlayback {
  constructor(root,turn,details={},options={}){
    this.root=root;this.options=options;this.live=Boolean(options.live);this.follow=this.live;this.playing=false;this.speed=2;this.index=0;this.position=0;this.detailRevision=0;
    this.build();this.update(turn,details,{live:this.live,initial:true,errors:options.errors});
    this.visibility=()=>{if(document.hidden){cancelAnimationFrame(this.frame);this.lastFrame=null;this.root.classList.remove('is-animating');}else{this.paint();if(this.playing||this.follow)this.startClock();}};document.addEventListener('visibilitychange',this.visibility);
  }
  build(){
    this.root.replaceChildren();this.root.classList.add('execution-player');
    const head=make('header','replay-heading'),title=make('div','replay-title-row'),collapse=make('button','replay-graph-toggle','收起流程图');collapse.type='button';collapse.setAttribute('aria-expanded','true');collapse.addEventListener('click',()=>{this.graph.hidden=!this.graph.hidden;collapse.textContent=this.graph.hidden?'展开流程图':'收起流程图';collapse.setAttribute('aria-expanded',String(!this.graph.hidden));});title.append(make('h1',null,'Agent 执行回放'),collapse);head.append(title);this.summary=make('p','replay-summary');this.question=make('p','replay-question');head.append(this.summary,this.question);this.root.append(head);
    this.graph=make('div','replay-graph');this.graph.setAttribute('aria-label','问答流程与 Agent 工具交互循环');this.root.append(this.graph);this.buildGraph();
    const controls=make('div','replay-controls');this.play=make('button','replay-play','播放');this.play.addEventListener('click',()=>this.toggle());
    this.previous=make('button',null,'上一事件');this.previous.addEventListener('click',()=>this.step(-1));this.next=make('button',null,'下一事件');this.next.addEventListener('click',()=>this.step(1));
    const speedLabel=make('label','replay-speed','速度 ');this.speedSelect=make('select');this.speedSelect.setAttribute('aria-label','回放速度');
    for(const value of [1,2,4]){const option=make('option',null,value+'×');option.value=String(value);this.speedSelect.append(option);}this.speedSelect.value=String(this.speed);this.speedSelect.addEventListener('change',()=>{this.speed=Number(this.speedSelect.value);});speedLabel.append(this.speedSelect);
    this.liveButton=make('button','replay-follow','回到实时');this.liveButton.addEventListener('click',()=>{this.follow=true;this.playing=false;this.startClock();this.paint();});this.clock=make('span','replay-clock');
    controls.append(this.play,this.previous,this.next,speedLabel,this.liveButton,this.clock);this.root.append(controls);
    const timeline=make('div','replay-timeline'),label=make('label',null,'执行时间轴');this.slider=make('input','replay-slider');this.slider.type='range';this.slider.min='0';this.slider.step='1';this.slider.setAttribute('aria-label','执行时间轴');
    this.slider.addEventListener('input',()=>{this.pause();this.follow=false;this.seek(Number(this.slider.value));});label.append(this.slider);timeline.append(label);
    const captions=make('div','replay-captions');this.eventCount=make('span');this.durationLabel=make('span');captions.append(make('span',null,'开始'),this.eventCount,this.durationLabel);timeline.append(captions);this.root.append(timeline);
    this.note=make('p','replay-note');this.root.append(this.note);
    const body=make('div','replay-body');this.eventsList=make('ol','replay-events');this.eventsList.setAttribute('aria-label','本轮执行事件');this.detailRoot=make('div','replay-detail');body.append(this.eventsList,this.detailRoot);this.root.append(body);
  }
  buildGraph(){
    const id='replay-arrow-'+(++graphId),svg=vector('svg',{viewBox:'0 0 1228 252',role:'group','aria-label':'从用户问题到回答和记忆；模型决策、调用工具和观察返回可循环'});
    const defs=vector('defs'),marker=vector('marker',{id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(vector('path',{d:'M1 1 L9 5 L1 9',fill:'none',stroke:'context-stroke','stroke-width':1.5}));defs.append(marker);svg.append(defs);
    svg.append(vector('rect',{x:348,y:39,width:572,height:200,rx:12,class:'flow-loop-boundary'}),vector('text',{x:634,y:96,'text-anchor':'middle',class:'flow-loop-title'},'Agent Loop · 模型 / 行动 / 观察'));
    this.edgeElements=new Map();
    for(const [key,d,label,x,y] of graphEdges){const group=vector('g',{class:'flow-edge'}),path=vector('path',{d,fill:'none','marker-end':`url(#${id})`});group.append(path);if(label)group.append(vector('text',{x,y,'text-anchor':'middle'},label));this.edgeElements.set(key,group);svg.append(group);}
    this.nodeElements=new Map();
    for(const [key,x,y,width,title,subtitle] of graphNodes){
      const group=vector('g',{class:'flow-node',role:'button',tabindex:0,'aria-label':'跳至'+title});group.append(vector('rect',{x,y,width,height:58,rx:8}),vector('text',{x:x+width/2,y:y+24,'text-anchor':'middle',class:'flow-node-title'},title),vector('text',{x:x+width/2,y:y+43,'text-anchor':'middle',class:'flow-node-subtitle'},subtitle));
      const jump=()=>{const found=this.timeline?.events.findIndex(event=>event.node===key);if(found>=0)this.select(found);};group.addEventListener('click',jump);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();jump();}});this.nodeElements.set(key,group);svg.append(group);
    }this.graph.append(svg);
  }
  update(turn,details={},options={}){
    if(this.disposed)return;const previousKey=this.timeline?.events[this.index]?.key,wasFollowing=this.follow;
    this.turn=turn;this.details=details;this.errors=options.errors??this.errors??{};this.live=Boolean(options.live);this.timeline=buildExecutionTimeline(turn,details);this.detailRevision++;
    this.baseLiveElapsed=this.timeline.duration;this.liveUpdated=Date.now();
    if(options.initial){const first=this.timeline.events.findIndex(event=>event.kind==='model'&&event.moment==='start');this.index=this.live?this.timeline.events.length-1:Math.max(0,first);this.position=this.timeline.events[this.index].at;}
    else if(wasFollowing){this.position=this.timeline.duration;this.index=this.timeline.events.length-1;}
    else{const found=this.timeline.events.findIndex(event=>event.key===previousKey);this.position=Math.min(this.position,this.timeline.duration);this.index=found>=0?found:executionIndexAt(this.timeline,this.position);}
    if(!this.live){this.follow=false;if(wasFollowing)this.pause();}
    this.question.textContent=turn.question;const items=turn.activity??[],models=items.filter(item=>item.kind==='model').length,tools=items.filter(item=>item.kind==='tool').length;
    this.summary.textContent=(this.live?'实时执行':turn.status==='completed'?'本轮已完成':'本轮未完成')+` · ${models} 次模型请求 · ${tools} 次工具调用`;
    this.usedNodes=new Set(this.timeline.events.map(event=>event.node));this.usedEdges=new Set(this.timeline.events.map(event=>event.edge));
    this.eventsList.replaceChildren();this.eventButtons=[];
    for(const [index,event] of this.timeline.events.entries()){
      const li=make('li'),button=make('button');button.type='button';button.append(make('span','replay-event-time',executionTime(event.at)),make('span',null,event.title));button.addEventListener('click',()=>this.select(index));li.append(button);this.eventsList.append(li);this.eventButtons.push(button);
    }
    const missing=Object.keys(this.errors).length,legacy=this.timeline.events.some(event=>event.legacy);
    this.note.textContent=!this.timeline.hasRecords?'这条回答没有保存执行记录。':missing?'部分请求详情暂时无法读取，已保留执行顺序。':legacy?'部分旧记录仅保存完成时间，时间轴按已知事件显示。':this.live?'正在接收真实执行事件；拖动时间轴可暂停跟随。':'拖动时间轴查看当时的输入与返回，也可点击流程节点定位。';
    this.liveButton.hidden=!this.live;this.paint(true);if(this.follow)this.startClock();
  }
  select(index){this.pause();this.follow=false;this.index=Math.max(0,Math.min(index,this.timeline.events.length-1));this.position=this.timeline.events[this.index].at;this.paint(true);}
  step(delta){this.select(this.index+delta);}
  seek(at){this.position=Math.max(0,Math.min(at,this.timeline.duration));this.index=executionIndexAt(this.timeline,this.position);this.paint();}
  pause(){this.playing=false;cancelAnimationFrame(this.frame);this.frame=null;}
  toggle(){
    if(this.playing||this.follow){this.pause();this.follow=false;this.paint();return;}
    if(this.position>=this.timeline.duration){this.position=0;this.index=0;}
    this.playing=true;this.follow=false;this.startClock();this.paint();
  }
  startClock(){
    cancelAnimationFrame(this.frame);this.lastFrame=null;
    const tick=now=>{
      if(this.disposed||document.hidden||!this.root.isConnected||!this.playing&&!this.follow)return;
      if(this.follow){this.position=this.baseLiveElapsed+Date.now()-this.liveUpdated;this.timeline.duration=Math.max(this.timeline.duration,this.position);this.index=this.timeline.events.length-1;}
      else{if(this.lastFrame!==null)this.position=Math.min(this.timeline.duration,this.position+(now-this.lastFrame)*this.speed);this.index=executionIndexAt(this.timeline,this.position);if(this.position>=this.timeline.duration)this.playing=false;}
      this.lastFrame=now;if(!this.lastPaint||now-this.lastPaint>40||!this.playing&&!this.follow){this.paint();this.lastPaint=now;}if(this.playing||this.follow)this.frame=requestAnimationFrame(tick);
    };this.frame=requestAnimationFrame(tick);
  }
  paint(force=false){
    const event=this.timeline.events[this.index],duration=this.timeline.duration,progress=duration?Math.min(100,this.position/duration*100):0;
    this.root.classList.toggle('is-animating',this.playing||this.follow);this.play.textContent=this.follow?'暂停跟随':this.playing?'暂停':this.position>=duration&&duration>0?'重新播放':'播放';this.play.disabled=!this.timeline.hasRecords;
    this.previous.disabled=this.index===0;this.next.disabled=this.index===this.timeline.events.length-1;this.liveButton.disabled=this.follow;
    this.slider.max=String(Math.max(1,duration));this.slider.value=String(this.position);this.slider.disabled=!this.timeline.hasRecords;this.slider.style.setProperty('--replay-progress',progress+'%');this.slider.setAttribute('aria-valuetext',executionTime(this.position)+'，'+event.title);
    this.clock.textContent=executionTime(this.position)+' / '+executionTime(duration);this.durationLabel.textContent=this.live?'实时':executionTime(duration);this.eventCount.textContent=`事件 ${this.index+1} / ${this.timeline.events.length}`;
    if(force||this.paintedKey!==event.key){
      const visited=new Set(this.timeline.events.slice(0,this.index+1).map(item=>item.node));
      for(const [key,node] of this.nodeElements){node.classList.toggle('active',key===event.node);node.classList.toggle('visited',visited.has(key));node.classList.toggle('unrecorded',!this.usedNodes.has(key));node.setAttribute('aria-disabled',String(!this.usedNodes.has(key)));node.setAttribute('tabindex',this.usedNodes.has(key)?'0':'-1');node.querySelector('.flow-node-subtitle').textContent=this.usedNodes.has(key)?graphNodes.find(entry=>entry[0]===key)[5]:'本轮未使用';}
      for(const [key,edge] of this.edgeElements){edge.classList.toggle('recorded',this.usedEdges.has(key));edge.classList.toggle('flow-current',event.edge===key);}
      for(const [index,button] of this.eventButtons.entries()){button.classList.toggle('selected',index===this.index);if(index===this.index)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}
      if(this.paintedKey!==event.key){this.detailRoot.dataset.tab=event.moment==='end'?'output':'input';this.renderDetail(event);this.eventsList.querySelector('[aria-current]')?.scrollIntoView({block:'nearest'});}
      else this.renderDetail(event);
      this.paintedKey=event.key;
    }
  }
  renderDetail(event){
    const detail=event.id&&executionDetailAt(this.details[event.id],event);
    if(detail){renderTrace(this.detailRoot,detail);return;}
    this.detailRoot.replaceChildren();const head=make('header','trace-head');head.append(make('h1',null,event.title),make('p',null,executionTime(event.at)));this.detailRoot.append(head);
    const text=event.kind==='question'?this.turn.question:event.kind==='finish'?this.turn.answer||'本轮没有生成完整回答。':event.item?.detail||'已记录此事件。';this.detailRoot.append(make('p','replay-event-content',text));
    if(event.id&&event.item?.has_details){const note=make('p','trace-description',this.errors[event.id]?'这次请求的详情暂时无法读取。':'正在等待请求详情。');this.detailRoot.append(note);}
    if(event.legacy)this.detailRoot.append(make('p','trace-description','这条旧记录没有请求开始时间，仅展示已保存的完成事件。'));
  }
  dispose(){this.disposed=true;this.pause();document.removeEventListener('visibilitychange',this.visibility);this.root.classList.remove('execution-player','is-animating');}
}

/** POST streams retain ownership headers; transport loss never retries an inference. */
export async function readQuestionStream(response,onActivity,onAnswer=()=>{},onTasks=()=>{}){
  if(!response.ok){const error=await response.json();throw new Error(error.error||'问答服务未能连接。');}
  if(!response.body)throw new Error('浏览器未能读取执行过程，请刷新后恢复会话。');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',result;
  try{
    while(true){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});
      let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(!line.trim())continue;
        const item=JSON.parse(line);if(item.type==='activity')onActivity(item.event);else if(item.type==='answer')onAnswer(item.update);else if(item.type==='task_progress')onTasks(item.progress);else if(item.type==='result')result=item.view;else if(item.type==='error')throw new Error(item.error);
      }
      if(pending.length>2000000)throw new Error('问答响应过长，请刷新后查看会话。');if(done)break;
    }
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  if(!result)throw new Error('连接已中断。服务可能仍在处理，稍后刷新恢复本轮结果。');return result;
}
