export class PaperReader {
  constructor({canvas,status,page,previous,next,zoom,original,retry,container,loadPdfJs=()=>import('./vendor/pdf.mjs')}){
    this.loadPdfJs=loadPdfJs;
    Object.assign(this,{canvas,status,page,previous,next,zoom,original,retry,container});this.document=null;this.version=0;this.pageNumber=1;this.scale=1;this.rendering=null;this.current=null;
    previous.addEventListener('click',()=>this.show(this.pageNumber-1));next.addEventListener('click',()=>this.show(this.pageNumber+1));
    zoom.addEventListener('change',()=>{this.scale=Number(zoom.value);void this.show(this.pageNumber);});
    retry.addEventListener('click',()=>{if(this.current)void this.open(...this.current,true);});
    this.resize=new ResizeObserver(()=>{clearTimeout(this.resizeTimer);this.resizeTimer=setTimeout(()=>{if(this.document)void this.show(this.pageNumber);},120);});this.resize.observe(container);
  }
  async open(paper,accessToken='',force=false){
    this.current=[paper,accessToken];this.original.href=`https://arxiv.org/pdf/${paper.paper_id}v1`;this.original.hidden=false;
    if(this.loadedId===paper.paper_id&&this.document&&!force){void this.show(this.pageNumber);return;}
    const version=++this.version,previousTask=this.loadingTask;this.loadingTask=null;this.loadedId=null;this.rendering?.cancel();this.document=null;
    this.previous.disabled=true;this.next.disabled=true;this.canvas.hidden=true;this.retry.hidden=true;this.status.hidden=false;this.page.textContent='加载中';this.status.textContent='正在加载官方原始 PDF…';
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
      const task=page.render({canvasContext:this.canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]});this.rendering=task;await task.promise;
      if(version===this.version){this.canvas.hidden=false;this.status.hidden=true;this.canvas.setAttribute('aria-label',`原始 PDF，第 ${number} 页，共 ${pdf.numPages} 页`);}
    }catch(error){if(error.name!=='RenderingCancelledException'&&version===this.version){this.status.hidden=false;this.status.textContent='本页暂时无法显示，请重试。';this.retry.hidden=false;}}
  }
}
