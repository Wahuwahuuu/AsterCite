import {renderMarkdown} from './markdown.js';
import {displayPaperTitles,splitAnswerControl} from './answer-format.js';
/** Live text is provisional; the saved final response replaces this article on completion. */
export class AnswerPreview {
  constructor(container,scroll,{onCitation,onCitationHover,papers=[]}={}){this.container=container;this.scroll=scroll;this.text='';this.onCitation=onCitation;this.onCitationHover=onCitationHover;this.papers=papers;this.frame=null;this.pending=null;}
  update(update){
    if(!this.article){this.article=document.createElement('article');this.article.className='message assistant streaming-answer';const heading=document.createElement('div');heading.className='message-heading';heading.textContent='✳  AsterCite';this.body=document.createElement('div');this.body.className='message-text';this.status=document.createElement('div');this.status.className='answer-stream-status';this.status.textContent='正在生成回答…';this.article.append(heading,this.body,this.status);this.container.append(this.article);}
    this.status.textContent=update.phase==='reviewing'?'正在核对与修正，当前回答保留显示…':update.phase==='final'?'回答已生成，正在保存本轮记录…':'正在生成回答…';
    this.article.classList.toggle('streaming-answer',update.phase!=='reviewing'&&update.phase!=='final');
    this.pending=update;
    if(update.phase==='final'){if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;this.paint(update);return;}
    if(this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;this.paint(this.pending);});
  }
  paint(update){
    const text=displayPaperTitles(splitAnswerControl(update.text,{streaming:update.phase!=='final'}).body,this.papers);
    const sourceKey=(update.sources??[]).map(source=>source.chunk_id).join('|');
    if(text===this.text&&sourceKey===this.sourceKey)return;
    const nearEnd=this.scroll.scrollHeight-this.scroll.scrollTop-this.scroll.clientHeight<160;
    const sources=update.sources??[];
    this.text=text;this.sourceKey=sourceKey;renderMarkdown(this.body,text,{sources,onCitation:this.onCitation?index=>this.onCitation(sources,index):undefined,onCitationHover:this.onCitationHover?index=>this.onCitationHover(sources[index]):undefined});if(nearEnd)this.scroll.scrollTop=this.scroll.scrollHeight;
  }
  interrupt(){if(this.frame!==null){cancelAnimationFrame(this.frame);this.frame=null;if(this.pending)this.paint(this.pending);}if(this.status){this.article.classList.remove('streaming-answer');this.status.textContent='连接已中断，以上是已接收内容。刷新页面可恢复服务端保存的结果。';}}
}
