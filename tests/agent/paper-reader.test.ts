import test from "node:test";
import assert from "node:assert/strict";
import { PaperReader } from "../../web/paper-reader.js";

function ui(){const element=()=>({hidden:false,disabled:false,textContent:"",href:"",style:{},addEventListener(){},setAttribute(){},getContext(){return {};}});
  const marks:Array<ReturnType<typeof element>>=[],scrolls:unknown[]=[];
  return {canvas:element(),status:element(),page:element(),previous:element(),next:element(),zoom:element(),original:element(),retry:element(),container:{clientWidth:400,clientHeight:500,scrollTo:(options:unknown)=>scrolls.push(options)},stage:{...element(),offsetTop:16},highlightLayer:{ownerDocument:{createElement:element},append:(mark:ReturnType<typeof element>)=>marks.push(mark),replaceChildren:()=>{marks.length=0;}},highlightBar:element(),highlightStatus:element(),marks,scrolls};}
function installBrowser(){const observer=Object.getOwnPropertyDescriptor(globalThis,"ResizeObserver"),browser=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"ResizeObserver",{configurable:true,value:class{observe(){}}});Object.defineProperty(globalThis,"window",{configurable:true,value:{devicePixelRatio:1}});
  return ()=>{if(observer)Object.defineProperty(globalThis,"ResizeObserver",observer);else Reflect.deleteProperty(globalThis,"ResizeObserver");if(browser)Object.defineProperty(globalThis,"window",browser);else Reflect.deleteProperty(globalThis,"window");};}
function doc(pages=5,texts:string[]=[],getText?:(page:number)=>Promise<string>){return {numPages:pages,async getPage(number:number){return {getViewport:({scale}:{scale:number})=>({width:400*scale,height:600*scale,transform:[scale,0,0,-scale,0,600*scale]}),render:()=>({promise:Promise.resolve(),cancel(){}}),async getTextContent(){return {items:[{str:getText?await getText(number):texts[number-1]??'Unrelated PDF text',transform:[10,0,0,10,20,400],width:200,height:10}],styles:{}};}};}};}

test("switching PDF uses the loading-task lifecycle and cannot retain the previous document",async()=>{
  const restore=installBrowser(),elements=ui(),urls:string[]=[],destroyed:string[]=[];
  const sdk={GlobalWorkerOptions:{workerSrc:""},getDocument({url}:{url:string}){urls.push(url);return {promise:Promise.resolve(doc(url.includes("1705")?7:5)),async destroy(){destroyed.push(url);}};}};
  try{
    const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk});await reader.open({paper_id:"1611.09441",title:"Twitter"});assert.equal(elements.page.textContent,"1 / 5");
    await reader.open({paper_id:"1705.02394",title:"Speech"});assert.equal(elements.page.textContent,"1 / 7");assert.equal(elements.canvas.hidden,false);
    assert.deepEqual(urls,["/api/papers/1611.09441/pdf","/api/papers/1705.02394/pdf"]);assert.deepEqual(destroyed,[urls[0]]);assert.match(elements.original.href,/1705\.02394v1$/);
  }finally{restore();}
});

test("late completion from an earlier PDF cannot replace the newly selected paper",async()=>{
  const restore=installBrowser(),elements=ui();let finishFirst!:(value:ReturnType<typeof doc>)=>void;const first=new Promise<ReturnType<typeof doc>>(resolve=>{finishFirst=resolve;});let started!:(value?:unknown)=>void;const ready=new Promise(resolve=>{started=resolve;});let destroyed=0;
  const sdk={GlobalWorkerOptions:{workerSrc:""},getDocument({url}:{url:string}){if(url.includes("1611"))started();return {promise:url.includes("1611")?first:Promise.resolve(doc(8)),async destroy(){destroyed++;}};}};
  try{
    const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk}),old=reader.open({paper_id:"1611.09441",title:"Twitter"});await ready;
    await reader.open({paper_id:"1705.02394",title:"Speech"});assert.equal(elements.page.textContent,"1 / 8");finishFirst(doc(5));await old;
    assert.equal(elements.page.textContent,"1 / 8");assert.ok(destroyed>0);assert.match(elements.original.href,/1705\.02394v1$/);
  }finally{restore();}
});

test('citation hover finds the right page, highlights it, and reuses cached PDF text',async()=>{
  const restore=installBrowser(),elements=ui(),quote='The hierarchical model captures local dependencies between neighbouring utterances in the dialogue.';
  let loads=0,reads=0;
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument(){loads++;return {promise:Promise.resolve(doc(3,[],async number=>{reads++;return number===2?quote:'A different page without the quotation.';})),async destroy(){}};}};
  try{
    const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk}),source={paper_id:'2003.06044',title:'Dialogue',chunk_id:'quotation',section:'Introduction',text:quote};
    await reader.highlight(source);assert.equal(elements.page.textContent,'2 / 3');assert.equal(loads,1);assert.equal(reads,2);assert.equal(elements.marks.length,1);assert.match(elements.highlightStatus.textContent,/第 2 页/);assert.equal(elements.scrolls.length,1);
    await reader.show(3);assert.equal(elements.marks.length,0);await reader.highlight(source);assert.equal(elements.page.textContent,'2 / 3');assert.equal(elements.marks.length,1);assert.equal(reads,2);assert.equal(loads,1);
    reader.clearHighlight();assert.equal(elements.marks.length,0);assert.equal(elements.highlightBar.hidden,true);
  }finally{restore();}
});

test('fast citation changes discard a late match and a manual clear cancels pending highlighting',async()=>{
  const restore=installBrowser(),elements=ui(),a='The first paper discusses convolutional networks for learning emotional representations.',b='The second paper studies dialogue act recognition with contextual attention.';
  let release!:(text:string)=>void,started!:()=>void;
  const gate=new Promise<string>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{started=resolve;});
  const sdk={GlobalWorkerOptions:{workerSrc:''},getDocument({url}:{url:string}){return {promise:Promise.resolve(doc(1,[],async()=>{if(url.includes('1705')){started();return gate;}return b;})),async destroy(){}};}};
  try{
    const reader=new PaperReader({...elements,loadPdfJs:async()=>sdk}),first=reader.highlight({paper_id:'1705.02394',title:'Speech',chunk_id:'a',section:'abstract',text:a});await ready;
    await reader.highlight({paper_id:'2003.06044',title:'Dialogue',chunk_id:'b',section:'abstract',text:b});assert.equal(elements.marks.length,1);assert.match(elements.original.href,/2003/);
    const before=JSON.stringify(elements.marks);release(a);await first;assert.equal(JSON.stringify(elements.marks),before);assert.match(elements.original.href,/2003/);
    const pending=reader.highlight({paper_id:'2003.06044',title:'Dialogue',chunk_id:'b',section:'abstract',text:b});reader.clearHighlight();await pending;assert.equal(elements.marks.length,0);assert.equal(elements.highlightBar.hidden,true);
  }finally{release(a);restore();}
});
