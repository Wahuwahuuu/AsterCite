import test from 'node:test';
import assert from 'node:assert/strict';
import {PaperReader} from '../../web/paper-reader.js';

class ViewElement {
  hidden=false;disabled=false;textContent='';href='';value='1';className='';type='';width=0;height=0;
  style:Record<string,string>={};dataset:Record<string,string>={};children:ViewElement[]=[];attributes:Record<string,string>={};
  clientWidth=400;clientHeight=500;offsetTop=16;scrollTop=0;scrollLeft=0;scrolls:Array<{top:number;behavior?:string}>=[];
  listeners=new Map<string,Array<()=>void>>();ownerDocument={createElement:(tag:string)=>new ViewElement(tag)};
  tagName:string;
  constructor(tagName='div'){this.tagName=tagName;}
  append(...nodes:ViewElement[]){this.children.push(...nodes);}
  replaceChildren(...nodes:ViewElement[]){this.children=[...nodes];}
  setAttribute(key:string,value:string){this.attributes[key]=value;}
  addEventListener(name:string,listener:()=>void){this.listeners.set(name,[...(this.listeners.get(name)??[]),listener]);}
  emit(name:string){for(const listener of this.listeners.get(name)??[])listener();}
  getContext(){return {};}
  scrollTo(options:{top:number;behavior?:string}){this.scrollTop=options.top;this.scrolls.push(options);this.emit('scroll');}
}
function ui(){const element=()=>new ViewElement();return {pages:element(),status:element(),page:element(),previous:element(),next:element(),zoom:element(),original:element(),retry:element(),container:element(),highlightBar:element(),highlightStatus:element()};}
function browser(){
  const previousObserver=Object.getOwnPropertyDescriptor(globalThis,'ResizeObserver'),previousWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),observers:Array<()=>void>=[];
  Object.defineProperty(globalThis,'ResizeObserver',{configurable:true,value:class{constructor(callback:()=>void){observers.push(callback);}observe(){}disconnect(){}}});Object.defineProperty(globalThis,'window',{configurable:true,value:{devicePixelRatio:1}});
  return {resize(){for(const observer of observers)observer();},restore(){if(previousObserver)Object.defineProperty(globalThis,'ResizeObserver',previousObserver);else Reflect.deleteProperty(globalThis,'ResizeObserver');if(previousWindow)Object.defineProperty(globalThis,'window',previousWindow);else Reflect.deleteProperty(globalThis,'window');}};
}
function doc(pages=5,texts:string[]=[],getText?:(page:number)=>Promise<string>,render?:(page:number)=>Promise<void>){
  return {numPages:pages,async getPage(number:number){return {getViewport:({scale}:{scale:number})=>({width:400*scale,height:600*scale,transform:[scale,0,0,-scale,0,600*scale]}),render:()=>({promise:render?render(number):Promise.resolve(),cancel(){}}),async getTextContent(){return {items:[{str:getText?await getText(number):texts[number-1]??'Unrelated PDF text',transform:[10,0,0,10,20,400],width:200,height:10}],styles:{}};}};}};
}
const canvas=(elements:ReturnType<typeof ui>,number:number)=>elements.pages.children[number-1].children[0];
const marks=(elements:ReturnType<typeof ui>,number:number)=>elements.pages.children[number-1].children[1].children;
const height=(elements:ReturnType<typeof ui>,number=1)=>Number.parseFloat(elements.pages.children[number-1].style.height);
async function until(condition:()=>boolean){const end=Date.now()+1500;while(!condition()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(condition(),'reader did not reach the expected visible state');}
const paper={paper_id:'1611.09441',title:'Twitter'};

test('the document exposes every page in order and switches PDF loading tasks cleanly',async()=>{
  const env=browser(),elements=ui(),urls:string[]=[],destroyed:string[]=[];
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument({url}:{url:string}){urls.push(url);return {promise:Promise.resolve(doc(url.includes('1705')?7:5)),async destroy(){destroyed.push(url);}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});
  try{await reader.open(paper);assert.equal(elements.page.textContent,'1 / 5');assert.deepEqual(elements.pages.children.map(page=>page.dataset.pageNumber),['1','2','3','4','5']);assert.equal(canvas(elements,1).hidden,false);
    await reader.open({paper_id:'1705.02394',title:'Speech'});assert.equal(elements.page.textContent,'1 / 7');assert.equal(elements.pages.children.length,7);assert.deepEqual(destroyed,[urls[0]]);assert.match(elements.original.href,/1705\.02394v1$/);
  }finally{reader.dispose();env.restore();}
});

test('continuous scrolling updates the current page, renders nearby pages and releases distant canvases',async()=>{
  const env=browser(),elements=ui();let loads=0;
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument(){loads++;return {promise:Promise.resolve(doc(30)),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});
  try{await reader.open(paper);assert.equal(elements.pages.children.length,30);assert.equal(canvas(elements,30).width,0);
    const top=16+8*(height(elements)+18);elements.container.scrollTop=top;elements.container.emit('scroll');
    await until(()=>elements.page.textContent==='9 / 30'&&!canvas(elements,9).hidden&&canvas(elements,1).width===0);
    assert.ok(elements.pages.children.filter(page=>page.children[0].width>0).length<=6);
    await reader.open(paper);assert.equal(loads,1);assert.equal(elements.container.scrollTop,top);assert.equal(elements.page.textContent,'9 / 30');
    elements.next.emit('click');await until(()=>elements.page.textContent==='10 / 30');
  }finally{reader.dispose();env.restore();}
});

test('zoom and reader-width changes retain the page and relative reading position',async()=>{
  const env=browser(),elements=ui(),sdk={GlobalWorkerOptions:{workerSrc:''},getDocument(){return {promise:Promise.resolve(doc(10)),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});
  try{await reader.open(paper);const fraction=.35;elements.container.scrollTop=16+3*(height(elements)+18)+fraction*height(elements);elements.container.emit('scroll');await until(()=>elements.page.textContent==='4 / 10');
    elements.zoom.value='1.5';elements.zoom.emit('change');await until(()=>canvas(elements,4).width===552);
    assert.ok(Math.abs(elements.container.scrollTop-(16+3*(height(elements)+18)+fraction*height(elements)))<.01);assert.equal(elements.page.textContent,'4 / 10');
    elements.container.clientWidth=500;env.resize();await until(()=>canvas(elements,4).width===702);
    assert.ok(Math.abs(elements.container.scrollTop-(16+3*(height(elements)+18)+fraction*height(elements)))<.01);
  }finally{reader.dispose();env.restore();}
});

test('late completion from an earlier PDF cannot replace the newly selected document',async()=>{
  const env=browser(),elements=ui();let finish!:(value:ReturnType<typeof doc>)=>void,started!:()=>void;
  const first=new Promise<ReturnType<typeof doc>>(resolve=>{finish=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument({url}:{url:string}){if(url.includes('1611'))started();return {promise:url.includes('1611')?first:Promise.resolve(doc(8)),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});
  try{const old=reader.open(paper);await ready;await reader.open({paper_id:'1705.02394',title:'Speech'});finish(doc(5));await old;assert.equal(elements.pages.children.length,8);assert.equal(elements.page.textContent,'1 / 8');assert.match(elements.original.href,/1705/);}
  finally{reader.dispose();env.restore();}
});

test('zoom waits for a cancelled paint before drawing into that page canvas again',async()=>{
  const env=browser(),elements=ui();let release!:()=>void,started!:()=>void,active=0,paints=0,overlap=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument(){return {promise:Promise.resolve(doc(5,[],undefined,number=>{
    if(number!==1)return Promise.resolve();paints++;active++;overlap ||= active>1;if(paints===1)started();return (paints===1?gate:Promise.resolve()).finally(()=>{active--;});
  })),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});
  try{const opening=reader.open(paper);await ready;elements.zoom.value='1.5';elements.zoom.emit('change');release();await opening;await until(()=>canvas(elements,1).width===552&&!canvas(elements,1).hidden);assert.equal(overlap,false);assert.ok(paints>=2);}
  finally{release();reader.dispose();env.restore();}
});

test('citation highlighting scrolls to its page and survives scrolling away and back',async()=>{
  const env=browser(),elements=ui(),quote='The hierarchical model captures local dependencies between neighbouring utterances in the dialogue.';let reads=0;
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument(){return {promise:Promise.resolve(doc(30,[],async number=>{reads++;return number===12?quote:'Another page without this quotation.';})),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk}),source={paper_id:'2003.06044',title:'Dialogue',chunk_id:'quotation',section:'Introduction',text:quote};
  try{await reader.highlight(source);assert.equal(elements.page.textContent,'12 / 30');assert.equal(marks(elements,12).length,1);assert.equal(reads,12);assert.match(elements.highlightStatus.textContent,/第 12 页/);
    await reader.show(25);assert.equal(canvas(elements,12).width,0);await reader.show(12);assert.equal(marks(elements,12).length,1);
    await reader.highlight(source);assert.equal(reads,12);reader.clearHighlight();assert.equal(marks(elements,12).length,0);assert.equal(elements.highlightBar.hidden,true);
  }finally{reader.dispose();env.restore();}
});

test('fast citation changes discard stale matches, and clearing cancels pending highlighting',async()=>{
  const env=browser(),elements=ui(),a='The first paper discusses convolutional networks for learning emotional representations.',b='The second paper studies dialogue act recognition with contextual attention.';
  let release!:(text:string)=>void,started!:()=>void;const gate=new Promise<string>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument({url}:{url:string}){return {promise:Promise.resolve(doc(1,[],async()=>{if(url.includes('1705')){started();return gate;}return b;})),async destroy(){}};}};
  const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk}),source={paper_id:'2003.06044',title:'Dialogue',chunk_id:'b',section:'abstract',text:b};
  try{const first=reader.highlight({...source,paper_id:'1705.02394',text:a});await ready;await reader.highlight(source);assert.equal(marks(elements,1).length,1);assert.match(elements.original.href,/2003/);
    release(a);await first;assert.equal(marks(elements,1).length,1);assert.match(elements.original.href,/2003/);
    const pending=reader.highlight(source);reader.clearHighlight();await pending;assert.equal(marks(elements,1).length,0);assert.equal(elements.highlightBar.hidden,true);
  }finally{release(a);reader.dispose();env.restore();}
});
