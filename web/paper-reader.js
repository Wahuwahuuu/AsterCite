import {indexPdfText,matchPdfCitation,citationBoxes} from './pdf-citation.js';

const PAGE_GAP=18;

export class PaperReader {
  constructor({pages,status,page,previous,next,zoom,original,retry,container,highlightBar,highlightStatus,highlightClear,loadPdfJs=()=>import('./vendor/pdf.mjs')}){
    Object.assign(this,{pages,status,page,previous,next,zoom,original,retry,container,highlightBar,highlightStatus,loadPdfJs});
    this.document=null;this.version=0;this.layoutVersion=0;this.pageNumber=1;this.scale=Number(zoom.value)||1;this.current=null;
    this.slots=new Map();this.pageCache=new Map();this.textCache=new Map();this.locations=new Map();this.highlightVersion=0;this.highlightBoxes=[];
    highlightClear?.addEventListener('click',()=>this.clearHighlight());
    previous.addEventListener('click',()=>{void this.show(this.pageNumber-1);});next.addEventListener('click',()=>{void this.show(this.pageNumber+1);});
    zoom.addEventListener('change',()=>{this.scale=Number(zoom.value)||1;this.resizePages();});
    retry.addEventListener('click',()=>{if(this.current)void this.open(...this.current,true);});
    container.addEventListener('scroll',()=>this.scheduleVisible(),{passive:true});
    this.resize=new ResizeObserver(()=>{if(!this.document||container.clientWidth===this.layoutWidth)return;clearTimeout(this.resizeTimer);this.resizeTimer=setTimeout(()=>this.resizePages(),120);});this.resize.observe(container);
  }
  async open(paper,accessToken='',force=false){
    if(!force&&this.opening?.id===paper.paper_id&&this.opening.token===accessToken)return this.opening.promise;
    const promise=this.load(paper,accessToken,force);this.opening={id:paper.paper_id,token:accessToken,promise};
    try{await promise;}finally{if(this.opening?.promise===promise)this.opening=null;}
  }
  async load(paper,accessToken,force){
    this.current=[paper,accessToken];this.original.href=`https://arxiv.org/pdf/${paper.paper_id}v1`;this.original.hidden=false;
    if(this.loadedId===paper.paper_id&&this.document&&!force){if(this.layoutWidth!==this.container.clientWidth)this.resizePages();else this.renderVisible();return;}
    this.clearHighlight();clearTimeout(this.scrollTimer);clearTimeout(this.resizeTimer);
    const version=++this.version,previousTask=this.loadingTask;this.loadingTask=null;this.loadedId=null;this.document=null;
    for(const slot of this.slots.values())this.releasePage(slot);this.slots.clear();this.pages.replaceChildren();this.pages.hidden=true;
    this.pageCache=new Map();this.textCache=new Map();this.locations=new Map();
    this.previous.disabled=true;this.next.disabled=true;this.retry.hidden=true;this.status.hidden=false;this.page.textContent='加载中';this.status.textContent='正在加载官方原始 PDF…';
    try{
      await previousTask?.destroy();if(version!==this.version)return;
      const pdfjs=await this.loadPdfJs();pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';if(version!==this.version)return;
      const loading=pdfjs.getDocument({url:`/api/papers/${encodeURIComponent(paper.paper_id)}/pdf`,httpHeaders:accessToken?{Authorization:'Bearer '+accessToken}:{},disableRange:true,isEvalSupported:false,useWasm:false,useSystemFonts:true});this.loadingTask=loading;
      const pdf=await loading.promise;if(version!==this.version){await loading.destroy();return;}
      this.document=pdf;const first=await this.pdfPage(pdf,1);if(version!==this.version)return;
      const base=first.getViewport({scale:1});this.loadedId=paper.paper_id;this.pageNumber=1;
      for(let number=1;number<=pdf.numPages;number++)this.createPage(number,base);
      this.pages.hidden=false;this.status.hidden=true;this.container.scrollTop=0;this.container.scrollLeft=0;this.updateSizes();this.updatePageNumber();
      await this.renderPage(this.slots.get(1));if(version===this.version)this.renderVisible();
    }catch{if(version!==this.version)return;this.status.textContent='PDF 暂时无法加载。请重试，或打开官方原文。';this.status.hidden=false;this.retry.hidden=false;this.page.textContent='加载失败';}
  }
  createPage(number,base){
    const doc=this.pages.ownerDocument,element=doc.createElement('div'),canvas=doc.createElement('canvas'),layer=doc.createElement('div'),placeholder=doc.createElement('div'),label=doc.createElement('span'),retry=doc.createElement('button');
    element.className='pdf-page-stage';element.dataset.pageNumber=String(number);element.setAttribute('role','group');element.setAttribute('aria-label',`第 ${number} 页`);
    canvas.width=0;canvas.height=0;canvas.hidden=true;canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`原始 PDF，第 ${number} 页`);
    layer.className='pdf-highlight-layer';layer.setAttribute('aria-hidden','true');placeholder.className='pdf-page-placeholder';label.textContent=`第 ${number} 页`;retry.textContent='重新加载这一页';retry.type='button';retry.hidden=true;
    placeholder.append(label,retry);element.append(canvas,layer,placeholder);this.pages.append(element);
    const slot={number,element,canvas,layer,placeholder,label,retry,base:{width:base.width,height:base.height},epoch:0,renderedLayout:-1,pending:null,task:null};this.slots.set(number,slot);
    retry.addEventListener('click',()=>{this.releasePage(slot);void this.renderPage(slot);});
  }
  pdfPage(pdf,number){const cache=this.pageCache;if(!cache.has(number))cache.set(number,pdf.getPage(number));return cache.get(number);}
  pageTop(slot){return (this.pages.offsetTop??16)+slot.top;}
  captureAnchor(){
    const top=this.container.scrollTop??0,y=top-(this.pages.offsetTop??16),slots=[...this.slots.values()];
    const slot=slots.find(item=>item.top+item.height>y)??slots.at(-1);
    return slot?{number:slot.number,fraction:Math.max(0,(y-slot.top)/slot.height),atTop:top<=1}:null;
  }
  updateSizes(anchor){
    this.layoutWidth=this.container.clientWidth;const width=Math.max(250,this.layoutWidth-32)*this.scale;let top=0;
    this.pages.style.width=width+'px';this.pages.style.gap=PAGE_GAP+'px';
    for(const slot of this.slots.values()){
      slot.top=top;slot.width=width;slot.height=width*slot.base.height/slot.base.width;top+=slot.height+PAGE_GAP;
      slot.element.style.width=slot.width+'px';slot.element.style.height=slot.height+'px';
    }
    if(anchor){const slot=this.slots.get(anchor.number);if(slot)this.container.scrollTop=anchor.atTop?0:this.pageTop(slot)+anchor.fraction*slot.height;}
  }
  resizePages(){
    if(!this.document||this.disposed)return;const anchor=this.captureAnchor();this.layoutVersion++;
    for(const slot of this.slots.values())this.releasePage(slot);this.updateSizes(anchor);this.renderVisible();
  }
  scheduleVisible(){clearTimeout(this.scrollTimer);this.scrollTimer=setTimeout(()=>this.renderVisible(),16);}
  updatePageNumber(){
    if(!this.slots.size)return;
    const y=(this.container.scrollTop??0)-(this.pages.offsetTop??16)+(this.container.clientHeight||600)*.4;
    const slot=[...this.slots.values()].find(item=>item.top+item.height>y)??[...this.slots.values()].at(-1);this.pageNumber=slot.number;
    this.previous.disabled=this.pageNumber<=1;this.next.disabled=this.pageNumber>=this.slots.size;this.page.textContent=`${this.pageNumber} / ${this.slots.size}`;
  }
  renderVisible(){
    if(!this.document||this.disposed||!this.slots.size)return;this.updatePageNumber();
    const top=(this.container.scrollTop??0)-(this.pages.offsetTop??16),height=this.container.clientHeight||600,margin=height*.75;
    for(const slot of this.slots.values()){
      if(slot.top+slot.height>top-margin&&slot.top<top+height+margin)void this.renderPage(slot);
      else if(slot.pending||slot.renderedLayout>=0)this.releasePage(slot);
    }
  }
  releasePage(slot){
    slot.epoch++;slot.previous=slot.pending??slot.previous;slot.pending=null;slot.task?.cancel();slot.task=null;slot.renderedLayout=-1;
    slot.canvas.width=0;slot.canvas.height=0;slot.canvas.hidden=true;slot.layer.replaceChildren();slot.placeholder.hidden=false;slot.label.textContent=`第 ${slot.number} 页`;slot.retry.hidden=true;
    if(this.activeHighlight?.page===slot.number)this.highlightBoxes=[];
  }
  renderPage(slot){
    if(!slot||!this.document||this.disposed)return Promise.resolve();
    if(slot.renderedLayout===this.layoutVersion&&!slot.canvas.hidden){this.paintHighlight(slot);return Promise.resolve();}
    if(slot.pending)return slot.pending;
    const pdf=this.document,version=this.version,layout=this.layoutVersion,epoch=slot.epoch,previous=slot.previous;
    const pending=this.drawPage(slot,pdf,version,layout,epoch,previous);slot.pending=pending;
    return pending.finally(()=>{if(slot.pending===pending){slot.pending=null;slot.previous=null;}});
  }
  async drawPage(slot,pdf,version,layout,epoch,previous){
    const valid=()=>!this.disposed&&version===this.version&&layout===this.layoutVersion&&slot.epoch===epoch&&this.document===pdf;
    try{
      await previous;if(!valid())return;const page=await this.pdfPage(pdf,slot.number);if(!valid())return;
      const base=page.getViewport({scale:1});
      if(base.width!==slot.base.width||base.height!==slot.base.height){const anchor=this.captureAnchor();slot.base={width:base.width,height:base.height};this.updateSizes(anchor);}
      const viewport=page.getViewport({scale:slot.width/base.width}),ratio=Math.min(window.devicePixelRatio||1,2);slot.viewport=viewport;
      slot.canvas.width=Math.ceil(viewport.width*ratio);slot.canvas.height=Math.ceil(viewport.height*ratio);slot.canvas.style.width=viewport.width+'px';slot.canvas.style.height=viewport.height+'px';
      const task=page.render({canvasContext:slot.canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});slot.task=task;await task.promise;if(!valid())return;
      slot.task=null;slot.renderedLayout=layout;slot.canvas.hidden=false;slot.placeholder.hidden=true;this.paintHighlight(slot);
    }catch(error){if(valid()&&error.name!=='RenderingCancelledException'){slot.placeholder.hidden=false;slot.label.textContent=`第 ${slot.number} 页暂时无法显示`;slot.retry.hidden=false;}}
  }
  async show(number,{highlight=false}={}){
    const slot=this.slots.get(number);if(!slot||this.disposed)return;
    this.pageNumber=number;this.page.textContent=`${number} / ${this.slots.size}`;this.previous.disabled=number<=1;this.next.disabled=number>=this.slots.size;
    const top=this.container.scrollTop??0,inView=this.pageTop(slot)+slot.height>top&&this.pageTop(slot)<top+this.container.clientHeight;
    if(!highlight||!inView)this.container.scrollTo({top:this.pageTop(slot),behavior:'instant'});await this.renderPage(slot);this.renderVisible();
    if(highlight&&this.activeHighlight?.page===number)this.paintHighlight(slot);
  }
  clearHighlight(){
    this.highlightVersion++;this.highlightKey=null;this.highlightPromise=null;this.revealPending=null;this.activeHighlight=null;this.highlightBoxes=[];
    for(const slot of this.slots.values())slot.layer.replaceChildren();if(this.highlightBar)this.highlightBar.hidden=true;
  }
  highlightMessage(text){if(this.highlightBar)this.highlightBar.hidden=false;if(this.highlightStatus)this.highlightStatus.textContent=text;}
  async textIndex(pdf,number){
    const cache=this.textCache;if(!cache.has(number))cache.set(number,this.pdfPage(pdf,number).then(page=>page.getTextContent()).then(indexPdfText));
    try{return await cache.get(number);}catch(error){cache.delete(number);throw error;}
  }
  async highlight(source,accessToken=''){
    if(!source?.paper_id||!source.text)return;const key=source.paper_id+'\n'+source.chunk_id+'\n'+source.text;
    if(this.highlightKey===key&&this.highlightPromise)return this.highlightPromise;
    const promise=this.locate(source,accessToken);this.highlightKey=key;this.highlightPromise=promise;
    try{await promise;}finally{if(this.highlightPromise===promise){this.highlightKey=null;this.highlightPromise=null;}}
  }
  async locate(source,accessToken){
    const ready=this.open({paper_id:source.paper_id,title:source.title},accessToken),request=++this.highlightVersion;
    this.activeHighlight=null;this.highlightBoxes=[];for(const slot of this.slots.values())slot.layer.replaceChildren();this.highlightMessage('正在定位引用原文…');
    try{
      await ready;const pdf=this.document;if(request!==this.highlightVersion)return;
      if(!pdf||this.loadedId!==source.paper_id){this.highlightMessage('PDF 加载后可重新悬停引用定位。');return;}
      const key=source.chunk_id+'\n'+source.text;let location=this.locations.get(key);
      if(!location){
        const preferred=/abstract|摘要/iu.test(source.section)?1:this.pageNumber;
        for(const number of [preferred,...Array.from({length:pdf.numPages},(_,i)=>i+1).filter(number=>number!==preferred)]){
          const index=await this.textIndex(pdf,number);if(request!==this.highlightVersion)return;const match=matchPdfCitation(index,source.text);if(!match)continue;
          if(!location||match.matched>location.match.matched)location={page:number,index,match};if(match.complete){location={page:number,index,match};break;}
        }
        if(location){if(this.locations.size>=64)this.locations.delete(this.locations.keys().next().value);this.locations.set(key,location);}
      }
      if(request!==this.highlightVersion)return;if(!location){this.highlightMessage('未能在 PDF 中定位这段文字，可点击引用查看原文依据。');return;}
      this.activeHighlight=location;this.revealPending=request;this.highlightMessage(`已定位第 ${location.page} 页，正在显示原文…`);await this.show(location.page,{highlight:true});
    }catch{if(request===this.highlightVersion)this.highlightMessage('这段原文暂时无法定位，可点击引用查看原文依据。');}
  }
  paintHighlight(slot){
    slot.layer.replaceChildren();if(!slot.viewport||slot.renderedLayout!==this.layoutVersion||this.activeHighlight?.page!==slot.number)return;
    this.highlightBoxes=citationBoxes(this.activeHighlight.index,this.activeHighlight.match,slot.viewport);
    this.highlightMessage(this.highlightBoxes.length?`第 ${slot.number} 页 · ${this.activeHighlight.match.complete?'引用原文已高亮':'已高亮匹配片段，部分原文可能在其他页'}`:'已定位页面，但该段文字暂时无法高亮。');
    for(const box of this.highlightBoxes){const mark=slot.layer.ownerDocument.createElement('span');mark.className='pdf-citation-highlight';Object.assign(mark.style,{left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px',transform:`rotate(${box.angle}deg)`});slot.layer.append(mark);}
    if(this.highlightBoxes.length&&this.revealPending===this.highlightVersion){this.revealPending=null;const first=this.highlightBoxes[0];this.container.scrollTo({top:Math.max(0,this.pageTop(slot)+first.top-this.container.clientHeight*.3),behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});}
  }
  dispose(){
    this.disposed=true;this.version++;this.clearHighlight();clearTimeout(this.scrollTimer);clearTimeout(this.resizeTimer);this.resize.disconnect?.();
    for(const slot of this.slots.values())this.releasePage(slot);void this.loadingTask?.destroy()?.catch(()=>{});
  }
}
