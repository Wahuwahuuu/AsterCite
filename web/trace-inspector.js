import {renderTrace} from './trace-view.js';
export class TraceInspector {
  constructor(){
    this.detail=null;this.popup=null;this.loader=null;this.activeId=null;
    this.dialog=document.createElement('dialog');this.dialog.className='trace-dialog';
    const close=document.createElement('button');close.className='trace-close';close.textContent='关闭详情';close.addEventListener('click',()=>this.dialog.close());
    const popout=document.createElement('button');popout.className='trace-popout';popout.textContent='在独立窗口打开';popout.addEventListener('click',()=>{this.prepareWindow();this.deliver();});
    this.content=document.createElement('div');this.content.className='trace-root';this.dialog.append(popout,close,this.content);document.body.append(this.dialog);
    window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===this.popup&&event.data?.type==='astercite-trace-ready'){this.popupReady=true;clearTimeout(this.fallbackTimer);this.deliver();}});
  }
  prepareWindow(){
    this.popupReady=false;clearTimeout(this.fallbackTimer);this.popup=window.open('/trace.html','astercite-request-detail','popup,width=1120,height=840');
    this.fallbackTimer=setTimeout(()=>{if(!this.popupReady){if(!this.dialog.open)this.dialog.showModal();if(this.detail)renderTrace(this.content,this.detail);else this.content.textContent='正在读取请求详情…';}},900);
    if(!this.popup){clearTimeout(this.fallbackTimer);if(!this.dialog.open)this.dialog.showModal();}
  }
  open(item,loader){
    this.activeId=item.id;this.loader=loader;this.detail=null;
    this.content.textContent='正在读取请求详情…';this.content.dataset.tab='input';if(!this.dialog.open)this.dialog.showModal();
    void this.refresh();
  }
  async refresh(item){
    if(!this.loader||item&&item.id!==this.activeId)return;
    try{this.detail=await this.loader();this.deliver();}catch{if(this.dialog.open)this.content.textContent='这次请求没有可读取的详情。升级前的问答不会补造请求记录。';if(this.popup&&!this.popup.closed)this.popup.postMessage({type:'astercite-trace-error'},location.origin);}
  }
  show(detail){this.activeId=detail.id;this.loader=null;this.detail=detail;this.content.dataset.tab='input';if(!this.dialog.open)this.dialog.showModal();this.deliver();}
  deliver(){if(!this.detail)return;if(this.popup&&!this.popup.closed)this.popup.postMessage({type:'astercite-trace-data',detail:this.detail},location.origin);if(this.dialog.open)renderTrace(this.content,this.detail);}
}
