import test from "node:test";
import assert from "node:assert/strict";
import { PaperReader } from "../../web/paper-reader.js";

function ui(){const element=()=>({hidden:false,disabled:false,textContent:"",href:"",style:{},addEventListener(){},setAttribute(){},getContext(){return {};}});
  return {canvas:element(),status:element(),page:element(),previous:element(),next:element(),zoom:element(),original:element(),retry:element(),container:{clientWidth:400}};}
function installBrowser(){const observer=Object.getOwnPropertyDescriptor(globalThis,"ResizeObserver"),browser=Object.getOwnPropertyDescriptor(globalThis,"window");
  Object.defineProperty(globalThis,"ResizeObserver",{configurable:true,value:class{observe(){}}});Object.defineProperty(globalThis,"window",{configurable:true,value:{devicePixelRatio:1}});
  return ()=>{if(observer)Object.defineProperty(globalThis,"ResizeObserver",observer);else Reflect.deleteProperty(globalThis,"ResizeObserver");if(browser)Object.defineProperty(globalThis,"window",browser);else Reflect.deleteProperty(globalThis,"window");};}
function doc(pages=5){return {numPages:pages,async getPage(){return {getViewport:({scale}:{scale:number})=>({width:400*scale,height:600*scale}),render:()=>({promise:Promise.resolve(),cancel(){}})};}};}

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
