import {renderTrace} from './trace-view.js';

const make=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
export function executionTime(ms){const seconds=Math.floor(Math.max(0,ms)/1000);return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+(seconds%60)+' 秒';}
function modelNode(item,detail,moment){
  const stage=detail?.stage??item.stage??'',phase=detail?.phase??item.phase??'';
  if(stage==='long_term_memory'||phase==='memory')return 'memory';
  if(['question_preparation','question_frame','compaction'].includes(stage)||phase==='compaction')return 'understand';
  if(['turn_completion','comparison_check','evidence_check'].includes(stage))return 'generate';
  if(moment==='end'&&detail?.output?.tool_calls?.length)return 'decision';
  if(moment==='start'&&phase==='agent'&&detail?.input?.tools?.length)return 'decision';
  if(['generate','closing','citation_repair'].includes(stage))return 'generate';
  // 老记录尚未读到详情时，仅使用已保存的展示标签作兼容。
  if(!stage){const label=item.label??'';if(/记忆/iu.test(label))return 'memory';if(/核对.*(?:完成|比较)|整理回答|生成回答|引用/u.test(label))return 'generate';if(/理解|意图|压缩/u.test(label))return 'understand';}
  return 'decision';
}

/** Reconstruct only timestamps supported by the saved record. Old elapsed_ms was cumulative. */
export function buildExecutionTimeline(turn,details={}){
  const events=[{key:'question',at:0,node:'question',kind:'question',moment:'point',title:'收到问题',status:'completed'}];
  const activities=turn.activity??[];
  for(const [order,item] of activities.entries()){
    const detail=details[item.id],end=finite(detail?.turn_elapsed_ms)&&detail.status===item.status?detail.turn_elapsed_ms:finite(item.elapsed_ms)?item.elapsed_ms:0;
    const startedAt=detail?.started_at??item.started_at,duration=detail?.elapsed_ms??item.request_elapsed_ms,recordedEnd=finite(detail?.turn_elapsed_ms)?detail.turn_elapsed_ms:end;
    const modern=typeof startedAt==='string'&&finite(recordedEnd)&&finite(duration);
    const target=item.kind==='model'?modelNode(item,detail,'start'):item.kind==='tool'?'action':item.kind==='compaction'?'understand':'memory';
    const stage=detail?.stage??item.stage,purpose={long_term_memory:'提炼长期记忆',turn_completion:'核对任务完成情况',comparison_check:'核对比较依据',evidence_check:'核对原文依据'}[stage];
    const name=item.kind==='tool'?(item.tool??detail?.tool??'工具'):item.kind==='model'?`第 ${detail?.cycle??item.cycle??order+1} 次模型请求${purpose?' · '+purpose:''}`:item.label;
    const base={id:item.id,kind:item.kind,item,detail,name,order,status:item.status};
    if(modern||item.status==='running'){
      const at=modern?Math.max(0,recordedEnd-duration):end;
      events.push({...base,key:item.id+':start',at,node:target,moment:'start',title:item.kind==='tool'?'调用工具 · '+name:item.kind==='model'?name+' · 发送上下文':name+' · 开始',status:'running'});
    }
    if(item.status!=='running')events.push({...base,key:item.id+':end',at:end,node:item.kind==='tool'?'observation':item.kind==='model'?modelNode(item,detail,'end'):target,moment:'end',title:item.kind==='tool'?'工具返回 · '+name:item.kind==='model'?name+' · 收到输出':name,status:item.status,legacy:Boolean(detail)&&!modern&&(item.kind==='model'||item.kind==='tool')});
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

export function executionNodeIndex(timeline,node,after=-1){
  const matches=event=>event.node===node&&event.kind!=='finish';
  const next=timeline.events.findIndex((event,index)=>index>after&&matches(event));
  return next>=0?next:timeline.events.findIndex(matches);
}

/** Keep event following inside the list; scrolling ancestors would hide the graph. */
export function revealExecutionEvent(list,item){
  if(!item||list.clientHeight<=0)return;
  const viewportTop=list.getBoundingClientRect().top+list.clientTop,bounds=item.getBoundingClientRect();
  const top=bounds.top-viewportTop,bottom=bounds.bottom-viewportTop;
  if(top<0)list.scrollTop=Math.max(0,list.scrollTop+top);
  else if(bottom>list.clientHeight)list.scrollTop+=Math.min(top,bottom-list.clientHeight);
}

/** Historical start events must not reveal their future output or final duration. */
export function executionDetailAt(detail,event){
  if(!detail)return null;
  return event.moment==='start'?{...detail,status:'running',output:undefined,elapsed_ms:0,playback_pending:true}:detail;
}

const argumentsObject=value=>{if(typeof value==='string')try{return JSON.parse(value);}catch{return {};}return value&&typeof value==='object'?value:{};};
const queryIdentity=value=>{const args=argumentsObject(value);return typeof args.query==='string'&&Array.isArray(args.paper_ids)?JSON.stringify([args.query.trim(),args.paper_ids.slice().sort()]):null;};

/** Explicit request and call identities form groups; adjacent timestamps never do. */
export function buildExecutionBatches(turn,details={}){
  const items=turn.activity??[],groups=new Map(),owners=new Map();
  const ensure=(origin,parent,stage,id)=>{
    const linked=Boolean(parent&&origin!=='unknown'&&(origin==='model'||stage));
    const key=linked?JSON.stringify([origin,parent,origin==='host_plan'?stage:'']):'tool:'+id;
    if(!groups.has(key))groups.set(key,{id:key,origin,linked,parent_id:parent,stage,calls:[],declared:[]});
    return groups.get(key);
  };
  for(const item of items.filter(item=>item.kind==='model')){
    const calls=details[item.id]?.output?.tool_calls?.filter(call=>typeof call.id==='string'&&call.id)??[];
    if(!calls.length)continue;
    const batch=ensure('model',item.id,details[item.id]?.stage??item.stage??'',item.id);
    for(const call of calls){
      if(batch.declared.some(row=>row.id===call.id))continue;
      owners.set(call.id,item.id);const args=argumentsObject(call.arguments);
      batch.declared.push({id:call.id,key:call.id,tool:call.name,query:args.query??'',identity:queryIdentity(args)});
    }
  }
  for(const item of items.filter(item=>item.kind==='tool')){
    const detail=details[item.id],parent=detail?.parent_id??item.parent_id??owners.get(item.id);
    const rawOrigin=detail?.origin??item.origin??(owners.has(item.id)?'model':'unknown');
    const origin=['model','host_plan'].includes(rawOrigin)?rawOrigin:'unknown',stage=detail?.stage??item.stage??'';
    const batch=ensure(origin,parent,stage,item.id),args=argumentsObject(detail?.input);
    batch.calls.push({id:item.id,key:item.id,tool:item.tool??detail?.tool??'工具',query:args.query??'',identity:queryIdentity(args)});
  }
  for(const batch of groups.values()){
    if(batch.origin!=='host_plan'||batch.stage!=='retrieve_first')continue;
    const parent=details[batch.parent_id];if(!['question_preparation','question_frame'].includes(parent?.stage))continue;
    let plan;try{plan=JSON.parse(parent.output?.text??'');}catch{continue;}
    if(!Array.isArray(plan.queries)||!plan.queries.length)continue;
    const declared=new Map();
    for(const query of plan.queries){const identity=queryIdentity(query);if(identity)declared.set(identity,{key:'plan:'+identity,tool:'retrieve_chunks',query:query.query,identity});}
    if(declared.size&&batch.calls.every(call=>call.identity&&declared.has(call.identity)))batch.declared=[...declared.values()];
  }
  return [...groups.values()];
}

/** A batch projection sees only emitted plans and events at the selected position. */
export function executionBatchAt(timeline,batches,index){
  const event=timeline.events[index];if(!event)return null;
  let batch=batches.find(batch=>batch.calls.some(call=>call.id===event.id));
  if(!batch&&event.kind==='model'&&event.moment==='end')batch=batches.find(batch=>batch.parent_id===event.id&&batch.declared.length);
  if(!batch&&event.kind==='finish'){
    const previous=timeline.events.slice(0,index).findLast(item=>item.kind==='tool');
    if(previous)batch=batches.find(batch=>batch.calls.some(call=>call.id===previous.id));
  }
  if(!batch)return null;
  const past=timeline.events.slice(0,index+1),seen=new Map();
  for(const step of past){if(!step.id)continue;let row=seen.get(step.id);if(!row){row={};seen.set(step.id,row);}if(step.moment==='start')row.start=step;else if(step.moment==='end')row.end=step;}
  const declaredVisible=Boolean(batch.declared.length&&seen.get(batch.parent_id)?.end),rows=[],matched=new Set();
  const project=(call,planned)=>{
    const actual=batch.calls.find(row=>call.id?row.id===call.id:row.identity===call.identity),record=actual&&seen.get(actual.id);
    if(actual)matched.add(actual.id);
    const status=record?.end?(record.end.status==='error'?'error':'completed'):record?.start?'running':event.kind==='finish'?'unexecuted':'queued';
    const start=record?.start?{...record.start,detail:executionDetailAt(record.start.detail,record.start)}:undefined;
    return {key:call.key,id:record?actual.id:call.id,tool:call.tool,query:call.query,status,planned,start,end:record?.end};
  };
  if(declaredVisible)for(const call of batch.declared)rows.push(project(call,true));
  for(const call of batch.calls)if(!matched.has(call.id)&&seen.has(call.id))rows.push(project(call,false));
  if(!rows.length)return null;
  const knownTotal=declaredVisible&&rows.every(row=>row.planned),returned=rows.filter(row=>row.end).length,started=rows.filter(row=>row.start||row.end).length;
  const running=rows.filter(row=>row.status==='running').length;
  const parallel=running>1||rows.some((a,i)=>a.start&&rows.slice(i+1).some(b=>b.start&&Math.max(a.start.at,b.start.at)<Math.min(a.end?.at??event.at,b.end?.at??event.at)));
  return {batch,calls:rows,known_total:knownTotal,total:knownTotal?rows.length:null,returned,started,running,parallel,complete:knownTotal&&returned===rows.length,failed:rows.filter(row=>row.status==='error').length};
}

/** Keep the raw timeline intact while a whole tool batch occupies one outer action. */
export function buildExecutionGraph(timeline,batches){
  const events=timeline.events.map((event,index)=>{
    const snapshot=executionBatchAt(timeline,batches,index);
    const node=event.kind==='tool'&&snapshot?.batch.linked?(snapshot.complete?'observation':'action'):event.node;
    return {...event,node,edge:undefined};
  });
  for(let index=1;index<events.length;index++){
    const previous=events[index-1],event=events[index],raw=timeline.events[index];
    if(event.kind==='finish')event.node=previous.node;
    if(previous.node!==event.node)event.edge=previous.node+'-'+event.node;
    if(event.node==='decision'&&event.moment==='start'&&raw.edge==='observation-decision')event.edge='observation-decision';
    if(raw.edge==='generate-generate')event.edge=raw.edge;
  }
  return {...timeline,events};
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
  ['question',36,12,190,'用户问题','本轮输入'],['understand',310,12,214,'理解与准备','上下文与检索计划'],
  ['decision',280,146,0,'模型决策','选择工具或回答'],['action',403,359,0,'工具执行','执行本批调用'],
  ['observation',157,359,0,'本批结果','等待模型处理'],['generate',76,504,184,'整理回答','生成与核对引用'],['memory',322,504,162,'会话记忆','保存阅读进展']
];
const graphEdges=[
  ['decision-action','M334.34 156.81 A142 142 0 0 1 420.79 306.54'],
  ['action-observation','M366.45 400.66 A142 142 0 0 1 193.55 400.66'],
  ['observation-decision','M139.21 306.54 A142 142 0 0 1 225.66 156.81']
];
const coreNodes=new Set(['decision','action','observation']);
const nodeTitle=node=>graphNodes.find(entry=>entry[0]===node)?.[4]??'执行记录';

export class ExecutionPlayback {
  constructor(root,turn,details={},options={}){
    this.root=root;this.options=options;this.live=Boolean(options.live);this.follow=this.live;this.playing=false;this.speed=2;this.index=0;this.position=0;this.detailRevision=0;
    this.build();this.update(turn,details,{live:this.live,initial:true,errors:options.errors});
    this.visibility=()=>{if(document.hidden){cancelAnimationFrame(this.frame);this.lastFrame=null;this.root.classList.remove('is-animating');}else{this.paint();if(this.playing||this.follow)this.startClock();}};document.addEventListener('visibilitychange',this.visibility);
  }
  build(){
    this.root.replaceChildren();this.root.classList.add('execution-player','orbit-player');
    const head=make('header','replay-heading'),title=make('div','replay-title-row'),collapse=make('button','replay-graph-toggle','收起流程图');collapse.type='button';collapse.setAttribute('aria-expanded','true');
    collapse.addEventListener('click',()=>{const hidden=!this.graph.hidden;this.graph.hidden=hidden;this.root.classList.toggle('graph-collapsed',hidden);collapse.textContent=hidden?'展开流程图':'收起流程图';collapse.setAttribute('aria-expanded',String(!hidden));});
    title.append(make('h1',null,'Agent 执行回放'),collapse);head.append(title);this.summary=make('p','replay-summary');this.question=make('p','replay-question');head.append(this.question,this.summary);this.root.append(head);
    const transport=make('div','replay-transport');this.root.append(transport);
    const controls=make('div','replay-controls');this.play=make('button','replay-play','播放');this.play.addEventListener('click',()=>this.toggle());
    this.previous=make('button',null,'上一事件');this.previous.addEventListener('click',()=>this.step(-1));this.next=make('button',null,'下一事件');this.next.addEventListener('click',()=>this.step(1));
    const speedLabel=make('label','replay-speed','速度 ');this.speedSelect=make('select');this.speedSelect.setAttribute('aria-label','回放速度');
    for(const value of [1,2,4]){const option=make('option',null,value+'×');option.value=String(value);this.speedSelect.append(option);}this.speedSelect.value=String(this.speed);this.speedSelect.addEventListener('change',()=>{this.speed=Number(this.speedSelect.value);});speedLabel.append(this.speedSelect);
    this.liveButton=make('button','replay-follow','回到实时');this.liveButton.addEventListener('click',()=>{this.follow=true;this.playing=false;this.startClock();this.paint();});this.clock=make('span','replay-clock');
    controls.append(this.play,this.previous,this.next,speedLabel,this.liveButton,this.clock);transport.append(controls);
    const timeline=make('div','replay-timeline'),label=make('label',null,'执行时间轴');this.slider=make('input','replay-slider');this.slider.type='range';this.slider.min='0';this.slider.step='1';this.slider.setAttribute('aria-label','执行时间轴');
    this.slider.addEventListener('input',()=>{this.pause();this.follow=false;this.seek(Number(this.slider.value));});label.append(this.slider);timeline.append(label);
    const captions=make('div','replay-captions');this.eventCount=make('span');this.durationLabel=make('span');captions.append(make('span',null,'开始'),this.eventCount,this.durationLabel);timeline.append(captions);transport.append(timeline);
    const body=make('div','replay-body'),overview=make('section','replay-overview'),graphHead=make('div','replay-section-heading');
    graphHead.append(make('h2',null,'执行全景'),make('span',null,'点击节点，切换对应事件'));overview.append(graphHead);
    this.graph=make('div','replay-graph');this.graph.setAttribute('aria-label','模型决策、整批工具执行、结果就绪组成外层循环');this.transition=make('p','replay-transition');overview.append(this.graph,this.transition);this.buildGraph();
    const eventsHead=make('div','replay-section-heading replay-events-heading');eventsHead.append(make('h2',null,'执行记录'));this.listCounter=make('span');eventsHead.append(this.listCounter);
    this.eventsList=make('ol','replay-events');this.eventsList.setAttribute('aria-label','本轮执行事件');overview.append(eventsHead,this.eventsList);
    const inspector=make('section','replay-inspector'),detailHead=make('div','replay-section-heading');detailHead.append(make('h2',null,'事件详情'));this.phaseLabel=make('span','replay-phase');detailHead.append(this.phaseLabel);
    const content=make('div','replay-inspector-content');this.batchRoot=make('section','replay-batch');this.batchRoot.hidden=true;this.batchExpanded=true;
    this.detailRoot=make('div','replay-detail');content.append(this.batchRoot,this.detailRoot);inspector.append(detailHead,content);body.append(overview,inspector);this.root.append(body);
    this.note=make('p','replay-note');this.root.append(this.note);
  }
  buildGraph(){
    const id='replay-arrow-'+(++graphId),svg=vector('svg',{viewBox:'0 0 560 570',role:'group','aria-label':'阶段概览：准备、Agent 循环、回答与记忆；具体执行顺序见当前事件'});
    const defs=vector('defs'),marker=vector('marker',{id,viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto-start-reverse'});marker.append(vector('path',{d:'M1 1 L9 5 L1 9',fill:'none',stroke:'context-stroke','stroke-width':1.5}));defs.append(marker);svg.append(defs);
    const connectors=vector('g',{class:'orbit-connectors','aria-hidden':'true'});
    for(const d of ['M234 34 H302','M417 64 V82 H280 V94','M280 442 V474 H168 V496','M268 526 H314'])connectors.append(vector('path',{d,fill:'none','marker-end':`url(#${id})`}));
    connectors.append(vector('text',{x:294,y:470,class:'orbit-exit-label'},'结束循环'));svg.append(connectors);
    svg.append(vector('text',{x:280,y:269,'text-anchor':'middle',class:'orbit-title'},'Agent Loop'));
    this.orbitPhase=vector('text',{x:280,y:299,'text-anchor':'middle',class:'orbit-phase'});this.orbitCount=vector('text',{x:280,y:325,'text-anchor':'middle',class:'orbit-count'});svg.append(this.orbitPhase,this.orbitCount);
    this.edgeElements=new Map();
    for(const [key,d] of graphEdges){const group=vector('g',{class:'flow-edge orbit-main'}),path=vector('path',{d,fill:'none','marker-end':`url(#${id})`});group.append(path);this.edgeElements.set(key,group);svg.append(group);}
    this.nodeElements=new Map();
    for(const [key,x,y,width,title,subtitle] of graphNodes){
      const round=coreNodes.has(key),group=vector('g',{class:'flow-node '+(round?'orbit-node':'orbit-stage'),role:'button',tabindex:0,'aria-label':'切换到'+title});
      if(round){
        group.append(vector('circle',{cx:x,cy:y,r:46,class:'orbit-node-disc'}),vector('circle',{cx:x,cy:y,r:51,class:'orbit-node-focus'}));
        const icon=vector('g',{transform:`translate(${x} ${y-12})`,class:'orbit-node-icon','aria-hidden':'true'});
        const paths={decision:['M-8-7H3V-1H8V7','M3-7L8-2M3-7L-2-2','M-8-7V7H-3'],action:['M-10-7H10V7H-10Z','M-6-2H6M-6 2H1'],observation:['M-10 0C-5-9 5-9 10 0C5 9-5 9-10 0Z','M-3 0A3 3 0 1 0 3 0A3 3 0 1 0-3 0']};
        for(const d of paths[key])icon.append(vector('path',{d}));group.append(icon,vector('text',{x,y:y+18,'text-anchor':'middle',class:'flow-node-title'},title));
      }else group.append(vector('rect',{x,y,width,height:44,rx:10}),vector('text',{x:x+width/2,y:y+19,'text-anchor':'middle',class:'flow-node-title'},title),vector('text',{x:x+width/2,y:y+35,'text-anchor':'middle',class:'flow-node-subtitle'},subtitle));
      const jump=()=>{if(!this.graphTimeline)return;const next=executionNodeIndex(this.graphTimeline,key,this.index);if(key==='action')this.batchExpanded=true;if(next>=0)this.select(next);};
      group.addEventListener('click',jump);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();jump();}});this.nodeElements.set(key,group);svg.append(group);
    }this.graph.append(svg);
  }
  update(turn,details={},options={}){
    if(this.disposed)return;const previousKey=this.timeline?.events[this.index]?.key,wasFollowing=this.follow;
    this.turn=turn;this.details=details;this.errors=options.errors??this.errors??{};this.live=Boolean(options.live);this.timeline=buildExecutionTimeline(turn,details);this.detailRevision++;
    this.batches=buildExecutionBatches(turn,details);this.graphTimeline=buildExecutionGraph(this.timeline,this.batches);
    this.baseLiveElapsed=this.timeline.duration;this.liveUpdated=Date.now();
    if(options.initial){const first=this.timeline.events.findIndex(event=>event.kind==='model'&&event.moment==='start');this.index=this.live?this.timeline.events.length-1:Math.max(0,first);this.position=this.timeline.events[this.index].at;}
    else if(wasFollowing){this.position=this.timeline.duration;this.index=this.timeline.events.length-1;}
    else{const found=this.timeline.events.findIndex(event=>event.key===previousKey);this.position=Math.min(this.position,this.timeline.duration);this.index=found>=0?found:executionIndexAt(this.timeline,this.position);}
    if(!this.live){this.follow=false;if(wasFollowing)this.pause();}
    this.question.textContent=turn.question;const items=turn.activity??[],models=items.filter(item=>item.kind==='model').length,tools=items.filter(item=>item.kind==='tool').length;
    this.summary.textContent=(this.live?'实时执行':turn.status==='completed'?'本轮已完成':'本轮未完成')+` · ${models} 次模型请求 · ${tools} 次工具调用`;
    this.usedNodes=new Set(this.graphTimeline.events.map(event=>event.node));
    this.listCounter.textContent=this.timeline.events.length+' 个事件';
    this.eventsList.replaceChildren();this.eventButtons=[];
    for(const [index,event] of this.timeline.events.entries()){
      const li=make('li'),button=make('button');button.type='button';button.append(make('span','replay-event-time',executionTime(event.at)),make('span',null,event.title));button.addEventListener('click',()=>this.select(index));li.append(button);this.eventsList.append(li);this.eventButtons.push(button);
    }
    const missing=Object.keys(this.errors).length,legacy=this.timeline.events.some(event=>event.legacy);
    this.note.textContent=!this.timeline.hasRecords?'这条回答没有保存执行记录。':missing?'部分请求详情暂时无法读取，可重新读取。':legacy?'部分旧记录仅有完成时间，按已知事件显示。':this.live?'正在接收执行记录；拖动时间轴可暂停跟随。':'拖动时间轴回看当时的输入与返回。连续点击同一节点，可切换该阶段的事件。';
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
      const graphEvent=this.graphTimeline.events[this.index],past=this.graphTimeline.events.slice(0,this.index+1),visited=new Set(past.map(item=>item.node));
      if(graphEvent.edge==='observation-decision')visited.add('observation');
      const decisions=new Set(past.filter(item=>item.kind==='model'&&item.node==='decision').map(item=>item.id)).size,tools=new Set(past.filter(item=>item.kind==='tool').map(item=>item.id)).size;
      const failed=new Set(past.filter(item=>item.status==='error').map(item=>item.node));
      this.orbitPhase.textContent=event.kind==='finish'?event.title:nodeTitle(graphEvent.node);
      this.orbitCount.textContent=!this.timeline.hasRecords?'暂无执行记录':decisions+' 次决策 · '+tools+' 次工具';
      const previous=this.timeline.events[this.index-1],recordedEdges=new Set(past.map(item=>item.edge));
      const route=event.edge&&previous?nodeTitle(previous.node)+' → '+nodeTitle(event.node):event.title;
      const batch=executionBatchAt(this.timeline,this.batches,this.index);
      this.transition.textContent=!this.timeline.hasRecords?'暂无执行记录':event.kind==='finish'?event.title:event.kind==='tool'&&batch?(batch.batch.origin==='host_plan'?'按计划执行':batch.batch.origin==='model'?'模型发起':'单次工具记录')+' · '+(batch.known_total?'已返回 '+batch.returned+'/'+batch.total:'已返回 '+batch.returned+' 项，批次总数未记录')+(batch.complete?' · 本批结果就绪':batch.parallel?' · 并行执行中':''):route;
      this.phaseLabel.textContent=event.moment==='start'?'请求发出':event.moment==='end'?'结果返回':event.kind==='finish'?'本轮结束':'用户输入';
      for(const [key,node] of this.nodeElements){node.classList.toggle('active',key===graphEvent.node);node.classList.toggle('visited',visited.has(key));node.classList.toggle('failed',failed.has(key));node.classList.toggle('unrecorded',!this.usedNodes.has(key));node.setAttribute('aria-disabled',String(!this.usedNodes.has(key)));node.setAttribute('tabindex',this.usedNodes.has(key)?'0':'-1');node.setAttribute('aria-label',this.usedNodes.has(key)?'查看'+nodeTitle(key)+'的事件':nodeTitle(key)+'，暂无记录');const subtitle=node.querySelector('.flow-node-subtitle');if(subtitle)subtitle.textContent=this.usedNodes.has(key)?graphNodes.find(entry=>entry[0]===key)[5]:this.timeline.hasRecords?'本轮未使用':'暂无记录';}
      for(const [key,edge] of this.edgeElements){edge.classList.toggle('recorded',recordedEdges.has(key));edge.classList.toggle('flow-current',graphEvent.edge===key);}
      this.renderBatch(batch);
      for(const [index,button] of this.eventButtons.entries()){button.classList.toggle('selected',index===this.index);if(index===this.index)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}
      if(this.paintedKey!==event.key){this.detailRoot.dataset.tab=event.moment==='end'?'output':'input';this.renderDetail(event);revealExecutionEvent(this.eventsList,this.eventButtons[this.index]);}
      else this.renderDetail(event);
      this.paintedKey=event.key;
    }
  }
  renderBatch(snapshot){
    const savedScroll=this.batchRoot.scrollTop;this.batchRoot.replaceChildren();this.batchRoot.hidden=!snapshot;if(!snapshot)return;
    const head=make('div','replay-batch-head'),title=make('div'),origin={model:'模型发起',host_plan:'按计划执行',unknown:'来源未记录'}[snapshot.batch.origin];
    title.append(make('h2',null,snapshot.batch.linked?'本批工具':'单次工具记录'),make('span','replay-batch-origin',origin));
    const toggle=make('button','replay-batch-toggle',this.batchExpanded?'收起批次':'展开批次');toggle.type='button';toggle.setAttribute('aria-expanded',String(this.batchExpanded));toggle.addEventListener('click',()=>{this.batchExpanded=!this.batchExpanded;this.renderBatch(snapshot);});head.append(title,toggle);this.batchRoot.append(head);
    this.batchRoot.append(make('p','replay-batch-progress',(snapshot.known_total?'已返回 '+snapshot.returned+' / '+snapshot.total:'已返回 '+snapshot.returned+' 项 · 批次总数未记录')+(snapshot.parallel?' · 存在并行调用':'')+(snapshot.failed?' · '+snapshot.failed+' 项失败':'')));
    if(this.batchExpanded){
      const list=make('ol','replay-batch-calls');
      for(const call of snapshot.calls){
        const row=make('li'),button=make('button','replay-batch-call'),status={queued:'待调用',running:'执行中',completed:'已返回',error:'失败',unexecuted:'未执行'}[call.status];button.type='button';button.dataset.status=call.status;
        button.append(make('span','replay-batch-tool',call.tool),make('span','replay-batch-query',call.query||'查看调用参数'),make('span','replay-batch-status',status));
        const target=call.end??call.start;button.disabled=!target;
        if(target){button.classList.toggle('selected',target.id===this.timeline.events[this.index].id);button.addEventListener('click',()=>this.select(this.timeline.events.findIndex(event=>event.key===target.key)));}
        row.append(button);list.append(row);
      }this.batchRoot.append(list);
    }this.batchRoot.scrollTop=savedScroll;
  }
  renderDetail(event){
    const detail=event.id&&executionDetailAt(this.details[event.id],event);
    if(detail){renderTrace(this.detailRoot,detail);return;}
    this.detailRoot.replaceChildren();const head=make('header','trace-head');head.append(make('h1',null,event.title),make('p',null,executionTime(event.at)));this.detailRoot.append(head);
    const text=event.kind==='question'?this.turn.question:event.kind==='finish'?this.turn.answer||'本轮没有生成完整回答。':event.item?.detail||'已记录此事件。';this.detailRoot.append(make('p','replay-event-content',text));
    if(event.id&&event.item?.has_details){const note=make('p','trace-description',this.errors[event.id]?'这次请求的详情暂时无法读取。':'正在等待请求详情。');this.detailRoot.append(note);}
    if(event.legacy)this.detailRoot.append(make('p','trace-description','这条旧记录没有请求开始时间，仅展示已保存的完成事件。'));
  }
  dispose(){this.disposed=true;this.pause();document.removeEventListener('visibilitychange',this.visibility);this.root.classList.remove('execution-player','orbit-player','is-animating','graph-collapsed');}
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
