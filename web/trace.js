import {renderTrace} from './trace-view.js';
const root=document.getElementById('trace-root');
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==window.opener)return;if(event.data?.type==='astercite-trace-data')renderTrace(root,event.data.detail);else if(event.data?.type==='astercite-trace-error')root.textContent='这次请求没有可读取的详情。升级前的问答不会补造请求记录。';});
if(window.opener)window.opener.postMessage({type:'astercite-trace-ready'},location.origin);else root.textContent='请从论文工作台点击模型请求或工具调用，打开详情。';
