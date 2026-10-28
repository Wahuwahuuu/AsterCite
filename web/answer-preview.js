import {renderMarkdown} from './markdown.js';
/** Live text is provisional; the saved final response replaces this article on completion. */
export class AnswerPreview {
  constructor(container,scroll){this.container=container;this.scroll=scroll;this.text='';}
  update(update){
    if(!this.article){this.article=document.createElement('article');this.article.className='message assistant streaming-answer';const heading=document.createElement('div');heading.className='message-heading';heading.textContent='✳  AsterCite';this.body=document.createElement('div');this.body.className='message-text';this.status=document.createElement('div');this.status.className='answer-stream-status';this.status.textContent='正在生成回答…';this.article.append(heading,this.body,this.status);this.container.append(this.article);}
    const nearEnd=this.scroll.scrollHeight-this.scroll.scrollTop-this.scroll.clientHeight<160;
    this.text=update.text;renderMarkdown(this.body,update.text,{sources:update.sources??[]});if(nearEnd)this.scroll.scrollTop=this.scroll.scrollHeight;
  }
  interrupt(){if(this.status){this.article.classList.remove('streaming-answer');this.status.textContent='连接已中断，以上是已接收内容。刷新页面可恢复服务端保存的结果。';}}
}
