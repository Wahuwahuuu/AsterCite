import {indexPdfText,matchPdfCitation,citationBoxes} from './pdf-citation.js';

export class PaperReader {
  constructor({canvas,status,page,previous,next,zoom,original,retry,container,stage,highlightLayer,highlightBar,highlightStatus,highlightClear,loadPdfJs=()=>import('./vendor/pdf.mjs')}){
    this.loadPdfJs=loadPdfJs;
    Object.assign(this,{canvas,status,page,previous,next,zoom,original,retry,container});this.document=null;this.version=0;this.pageNumber=1;this.scale=1;this.rendering=null;this.current=null;
    Object.assign(this,{stage,highlightLayer,highlightBar,highlightStatus});this.highlightVersion=0;this.textCache=new Map();this.locations=new Map();
    highlightClear?.addEventListener('click',()=>this.clearHighlight());
    previous.addEventListener('click',()=>this.show(this.pageNumber-1));next.addEventListener('click',()=>this.show(this.pageNumber+1));
    zoom.addEventListener('change',()=>{this.scale=Number(zoom.value);void this.show(this.pageNumber);});
    retry.addEventListener('click',()=>{if(this.current)void this.open(...this.current,true);});
    this.resize=new ResizeObserver(()=>{clearTimeout(this.resizeTimer);this.resizeTimer=setTimeout(()=>{if(this.document)void this.show(this.pageNumber);},120);});this.resize.observe(container);
  }
  async open(paper,accessToken='',force=false){
    if(!force&&this.opening?.id===paper.paper_id&&this.opening.token===accessToken)return this.opening.promise;
    const promise=this.load(paper,accessToken,force);this.opening={id:paper.paper_id,token:accessToken,promise};
    try{await promise;}finally{if(this.opening?.promise===promise)this.opening=null;}
  }
  async load(paper,accessToken,force){
    this.current=[paper,accessToken];this.original.href=`https://arxiv.org/pdf/${paper.paper_id}v1`;this.original.hidden=false;
    if(this.loadedId===paper.paper_id&&this.document&&!force){await this.show(this.pageNumber);return;}
    this.clearHighlight();this.textCache=new Map();this.locations=new Map();
    const version=++this.version,previousTask=this.loadingTask;this.loadingTask=null;this.loadedId=null;this.rendering?.cancel();this.document=null;
    this.previous.disabled=true;this.next.disabled=true;this.canvas.hidden=true;if(this.stage)this.stage.hidden=true;this.retry.hidden=true;this.status.hidden=false;this.page.textContent='加载中';this.status.textContent='正在加载官方原始 PDF…';
    try{
      await previousTask?.destroy();if(version!==this.version)return;
      const pdfjs=await this.loadPdfJs();pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker.mjs';
      if(version!==this.version)return;
      const loading=pdfjs.getDocument({url:`/api/papers/${encodeURIComponent(paper.paper_id)}/pdf`,httpHeaders:accessToken?{Authorization:'Bearer '+accessToken}:{},disableRange:true,isEvalSupported:false,useWasm:false,useSystemFonts:true});
      this.loadingTask=loading;
      const pdf=await loading.promise;if(version!==this.version){await loading.destroy();return;}
      this.document=pdf;this.loadedId=paper.paper_id;this.pageNumber=1;await this.show(1);
    }catch{if(version!==this.version)return;this.status.textContent='PDF 暂时无法加载。请重试，或打开官方原文。';this.retry.hidden=false;this.page.textContent='加载失败';}
  }
  clearHighlight(){
    this.highlightVersion++;this.highlightKey=null;this.highlightPromise=null;this.revealPending=null;this.activeHighlight=null;this.highlightBoxes=[];this.highlightLayer?.replaceChildren();if(this.highlightBar)this.highlightBar.hidden=true;
  }
  highlightMessage(text){if(this.highlightBar)this.highlightBar.hidden=false;if(this.highlightStatus)this.highlightStatus.textContent=text;}
  async textIndex(pdf,number){
    const cache=this.textCache;
    if(!cache.has(number))cache.set(number,pdf.getPage(number).then(page=>page.getTextContent()).then(indexPdfText));
    try{return await cache.get(number);}catch(error){cache.delete(number);throw error;}
  }
  async highlight(source,accessToken=''){
    if(!source?.paper_id||!source.text)return;
    const key=source.paper_id+'\n'+source.chunk_id+'\n'+source.text;
    if(this.highlightKey===key&&this.highlightPromise)return this.highlightPromise;
    const promise=this.locate(source,accessToken);this.highlightKey=key;this.highlightPromise=promise;
    try{await promise;}finally{if(this.highlightPromise===promise){this.highlightKey=null;this.highlightPromise=null;}}
  }
  async locate(source,accessToken){
    const ready=this.open({paper_id:source.paper_id,title:source.title},accessToken),request=++this.highlightVersion;
    this.activeHighlight=null;this.highlightBoxes=[];this.highlightLayer?.replaceChildren();this.highlightMessage('正在定位引用原文…');
    try{
      await ready;const pdf=this.document;if(request!==this.highlightVersion)return;
      if(!pdf||this.loadedId!==source.paper_id){this.highlightMessage('PDF 加载后可重新悬停引用定位。');return;}
      const key=source.chunk_id+'\n'+source.text;let location=this.locations.get(key);
      if(!location){
        const preferred=/abstract|摘要/iu.test(source.section)?1:this.pageNumber;
        const order=[preferred,...Array.from({length:pdf.numPages},(_,i)=>i+1).filter(number=>number!==preferred)];
        for(const number of order){
          const index=await this.textIndex(pdf,number);if(request!==this.highlightVersion)return;
          const match=matchPdfCitation(index,source.text);if(!match)continue;
          if(!location||match.matched>location.match.matched)location={page:number,index,match};
          if(match.complete){location={page:number,index,match};break;}
        }
        if(location){if(this.locations.size>=64)this.locations.delete(this.locations.keys().next().value);this.locations.set(key,location);}
      }
      if(request!==this.highlightVersion)return;
      if(!location){this.highlightMessage('未能在 PDF 中定位这段文字，可点击引用查看原文依据。');return;}
      this.activeHighlight=location;this.revealPending=request;this.highlightMessage(`已定位第 ${location.page} 页，正在显示原文…`);await this.show(location.page);
    }catch{if(request===this.highlightVersion)this.highlightMessage('这段原文暂时无法定位，可点击引用查看原文依据。');}
  }
  paintHighlight(viewport,number){
    this.highlightLayer?.replaceChildren();this.highlightBoxes=[];
    if(!this.activeHighlight||this.activeHighlight.page!==number)return;
    this.highlightBoxes=citationBoxes(this.activeHighlight.index,this.activeHighlight.match,viewport);
    this.highlightMessage(this.highlightBoxes.length?`第 ${number} 页 · ${this.activeHighlight.match.complete?'引用原文已高亮':'已高亮匹配片段，部分原文可能在其他页'}`:'已定位页面，但该段文字暂时无法高亮。');
    if(this.highlightBoxes.length&&this.revealPending===this.highlightVersion){this.revealPending=null;this.revealHighlight();}
    if(!this.highlightLayer)return;
    for(const box of this.highlightBoxes){
      const mark=this.highlightLayer.ownerDocument.createElement('span');mark.className='pdf-citation-highlight';
      Object.assign(mark.style,{left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px',transform:`rotate(${box.angle}deg)`});this.highlightLayer.append(mark);
    }
  }
  revealHighlight(){
    const first=this.highlightBoxes[0];if(first)this.container.scrollTo?.({top:Math.max(0,(this.stage?.offsetTop??16)+first.top-this.container.clientHeight*.3),behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  }
  async show(number){
    const pdf=this.document;if(!pdf||number<1||number>pdf.numPages)return;
    this.pageNumber=number;const version=this.version,renderVersion=(this.renderVersion??0)+1;this.renderVersion=renderVersion;this.previous.disabled=number<=1;this.next.disabled=number>=pdf.numPages;
    this.page.textContent=`${number} / ${pdf.numPages}`;
    this.rendering?.cancel();
    try{
      const page=await pdf.getPage(number);if(version!==this.version||renderVersion!==this.renderVersion||number!==this.pageNumber)return;
      const width=Math.max(250,this.container.clientWidth-32),base=page.getViewport({scale:1}),ratio=Math.min(window.devicePixelRatio||1,2);
      const viewport=page.getViewport({scale:width/base.width*this.scale});
      this.canvas.width=Math.floor(viewport.width*ratio);this.canvas.height=Math.floor(viewport.height*ratio);
      this.canvas.style.width=Math.floor(viewport.width)+'px';this.canvas.style.height=Math.floor(viewport.height)+'px';
      if(this.stage){this.stage.style.width=viewport.width+'px';this.stage.style.height=viewport.height+'px';}
      const task=page.render({canvasContext:this.canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});this.rendering=task;await task.promise;
      if(version===this.version&&renderVersion===this.renderVersion&&number===this.pageNumber){this.canvas.hidden=false;if(this.stage)this.stage.hidden=false;this.status.hidden=true;this.paintHighlight(viewport,number);this.canvas.setAttribute('aria-label',`原始 PDF，第 ${number} 页，共 ${pdf.numPages} 页`);}
    }catch(error){if(error.name!=='RenderingCancelledException'&&version===this.version){this.status.hidden=false;this.status.textContent='本页暂时无法显示，请重试。';this.retry.hidden=false;}}
  }
}
