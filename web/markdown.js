import {Marked} from './vendor/marked.js';
import katex from './vendor/katex.mjs';
import DOMPurify from './vendor/purify.mjs';
const escape=text=>String(text).replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const safeUrl=href=>{try{const value=new URL(href,'https://astercite.invalid');return ['http:','https:'].includes(value.protocol)?href:null;}catch{return null;}};
function mathToken(source,block){
  for(const [open,close,display] of block?[['$$','$$',true],['\\[','\\]',true]]:[['$$','$$',true],['\\(','\\)',false],['$','$',false]]){
    if(!source.startsWith(open)||open==='$'&&/\s/u.test(source[1]??' '))continue;
    for(let end=source.indexOf(close,open.length);end>=0;end=source.indexOf(close,end+close.length)){
      if(source[end-1]==='\\'||open==='$'&&(/\s/u.test(source[end-1])||/\d/u.test(source[end+1]??'')))continue;
      const text=source.slice(open.length,end);if(!text||!display&&text.includes('\n'))break;
      return {type:block?'mathBlock':'mathInline',raw:source.slice(0,end+close.length),text,display};
    }
  }
}
const formulaCache=new Map();
function formula(token){const key=JSON.stringify([token.display,token.text]);if(formulaCache.has(key))return formulaCache.get(key);const html=katex.renderToString(token.text,{displayMode:token.display,throwOnError:false,trust:false,strict:'ignore',maxExpand:1000,maxSize:20,output:'htmlAndMathml'});if(formulaCache.size>=256)formulaCache.delete(formulaCache.keys().next().value);formulaCache.set(key,html);return html;}
/** Parse Markdown and scientific notation; citation numbers come only from known sources. */
export function markdownToHtml(text,{sources=[],interactive=true}={}){
  const parser=new Marked({gfm:true,breaks:false});
  parser.use({extensions:[
    {name:'mathBlock',level:'block',start:source=>source.search(/\$\$|\\\[/u),tokenizer:source=>mathToken(source,true),renderer:formula},
    {name:'mathInline',level:'inline',start:source=>source.search(/\$|\\\(/u),tokenizer:source=>mathToken(source,false),renderer:formula},
    {name:'citation',level:'inline',start:source=>source.indexOf('[cite:'),tokenizer(source){const match=/^\[cite:([^\]\n]+)\]/u.exec(source);if(match)return {type:'citation',raw:match[0],id:match[1]};},renderer(token){const index=sources.findIndex(source=>source.chunk_id===token.id);if(index<0)return '<span class="citation-unavailable">〔引用待关联〕</span>';return interactive?`<button type="button" class="citation" data-citation-index="${index}" aria-label="查看引用 ${index+1}">${index+1}</button>`:`<sup class="citation">${index+1}</sup>`;}}
  ],renderer:{html:({text})=>escape(text),link({href,tokens}){const text=this.parser.parseInline(tokens),url=safeUrl(href);return url?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`:text;},image:({href,text})=>safeUrl(href)?`<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">图片：${escape(text)}</a>`:escape(text)}});
  return parser.parse(text.replace(/\[cite:[^\]\n]*$/u,''));
}
export function renderMarkdown(target,text,{sources=[],onCitation,onCitationHover}={}){
  const html=markdownToHtml(text,{sources,interactive:typeof onCitation==='function'||typeof onCitationHover==='function'});
  target.innerHTML=DOMPurify.sanitize(html,{USE_PROFILES:{html:true,mathMl:true,svg:true},ADD_ATTR:['target'],FORBID_TAGS:['style','form'],FORBID_ATTR:['srcdoc']});
  target.classList.add('markdown-body');
  for(const button of target.querySelectorAll('button[data-citation-index]')){
    const index=Number(button.dataset.citationIndex);
    if(onCitation)button.addEventListener('click',()=>onCitation(index));
    if(onCitationHover){button.title='悬停定位 PDF 原文，点击查看依据';button.addEventListener('pointerenter',()=>onCitationHover(index));button.addEventListener('focus',()=>onCitationHover(index));}
  }
}
