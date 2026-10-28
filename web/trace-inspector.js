import {renderTrace} from './trace-view.js';
import {ExecutionPlayback} from './activity.js';

export class TraceInspector {
  constructor(){
    this.generation=0;this.popup=null;this.mode=null;
    this.dialog=document.createElement('dialog');this.dialog.className='trace-dialog';this.dialog.setAttribute('aria-label','Agent 执行详情');
    const toolbar=document.createElement('div');toolbar.className='trace-window-toolbar';
    const close=document.createElement('button');close.className='trace-close';close.textContent='关闭详情';close.addEventListener('click',()=>this.dialog.close());
    const popout=document.createElement('button');popout.className='trace-popout';popout.textContent='在独立窗口打开';popout.addEventListener('click',()=>{this.prepareWindow();this.deliver();});
    this.retry=document.createElement('button');this.retry.className='trace-retry';this.retry.textContent='重新读取详情';this.retry.hidden=true;this.retry.addEventListener('click',()=>{this.versions={};void this.loadRun();});
    toolbar.append(popout,this.retry,close);this.content=document.createElement('div');this.content.className='trace-root';this.dialog.append(toolbar,this.content);document.body.append(this.dialog);
    this.dialog.addEventListener('close',()=>{this.player?.dispose();this.player=null;});
    window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===this.popup&&event.data?.type==='astercite-trace-ready')this.deliver();});
  }
  prepareWindow(){this.popup=window.open('/trace.html','astercite-execution','popup,width=1480,height=960');}
  reset(){
    this.generation++;this.player?.dispose();this.player=null;
    if(this.dialog.open)this.dialog.close();if(this.popup&&!this.popup.closed)this.popup.close();this.popup=null;
    this.mode=null;this.detail=null;this.loader=null;this.run=null;this.runLoader=null;this.details={};this.errors={};this.versions={};this.activeId=null;this.pendingRun=false;this.loadingGeneration=null;this.content.replaceChildren();
  }
  prepare(mode){
    this.generation++;this.player?.dispose();this.player=null;this.mode=mode;this.detail=null;this.loader=null;this.activeId=null;this.run=null;this.runLoader=null;
    this.dialog.classList.toggle('replay-dialog',mode==='run');this.retry.hidden=true;this.content.dataset.tab='input';this.content.replaceChildren();if(!this.dialog.open)this.dialog.showModal();
  }
  open(item,loader){this.prepare('detail');this.activeId=item.id;this.loader=loader;this.content.textContent='正在读取请求详情…';void this.refresh();}
  async refresh(item){
    if(this.mode!=='detail'||!this.loader||item&&item.id!==this.activeId)return;const generation=this.generation;
    try{const detail=await this.loader();if(generation!==this.generation)return;this.detail=detail;this.deliver();}
    catch{if(generation!==this.generation)return;this.content.textContent='这次请求没有可读取的详情。';}
  }
  show(detail){this.prepare('detail');this.activeId=detail.id;this.detail=detail;this.deliver();}
  openRun(turn,loader,{live=false}={}){
    this.prepare('run');this.run=turn;this.runLoader=loader;this.live=live;this.details={};this.errors={};this.versions={};this.loadingGeneration=null;this.pendingRun=false;
    this.deliver();void this.loadRun();
  }
  updateRun(turn,{live=false}={}){
    if(this.mode!=='run'||!this.run||this.run.turn_id&&this.run.turn_id!==turn.turn_id||!this.dialog.open&&(!this.popup||this.popup.closed))return;
    if(!this.run.turn_id&&this.run.question!==turn.question)return;
    this.run=turn;this.live=live;this.deliver();void this.loadRun();
  }
  async loadRun(){
    if(this.mode!=='run'||!this.runLoader)return;const generation=this.generation;this.pendingRun=true;
    if(this.loadingGeneration===generation)return;this.loadingGeneration=generation;
    try{
      while(this.pendingRun&&generation===this.generation){
        this.pendingRun=false;const requests=(this.run.activity??[]).filter(item=>item.has_details&&this.versions[item.id]!==item.status+':'+item.elapsed_ms);
        await Promise.allSettled(requests.map(async item=>{
          const version=item.status+':'+item.elapsed_ms;
          try{const detail=await this.runLoader(item);if(generation!==this.generation)return;this.details[item.id]=detail;delete this.errors[item.id];}
          catch{if(generation!==this.generation)return;this.errors[item.id]=true;}
          if(generation===this.generation)this.versions[item.id]=version;
        }));
        if(generation===this.generation){this.retry.hidden=!Object.keys(this.errors).length;this.deliver();}
      }
    }finally{if(this.loadingGeneration===generation)this.loadingGeneration=null;}
  }
  deliver(){
    if(this.mode==='run'&&this.run){
      const options={live:this.live,errors:this.errors};
      if(this.dialog.open){if(this.player)this.player.update(this.run,this.details,options);else this.player=new ExecutionPlayback(this.content,this.run,this.details,options);}
      if(this.popup&&!this.popup.closed)this.popup.postMessage({type:'astercite-replay-data',turn:this.run,details:this.details,...options},location.origin);
    }else if(this.mode==='detail'&&this.detail){
      if(this.dialog.open)renderTrace(this.content,this.detail);
      if(this.popup&&!this.popup.closed)this.popup.postMessage({type:'astercite-trace-data',detail:this.detail},location.origin);
    }
  }
}
