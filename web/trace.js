import {renderTrace} from './trace-view.js';
import {ExecutionPlayback} from './activity.js';
const root=document.getElementById('trace-root');let player=null,turnId=null;
window.addEventListener('message',event=>{
  if(event.origin!==location.origin||event.source!==window.opener)return;const data=event.data;
  if(data?.type==='astercite-replay-data'){
    document.body.classList.add('replay-page');document.title='AsterCite · Agent 执行回放';
    if(player&&turnId===data.turn.turn_id)player.update(data.turn,data.details,data);
    else{player?.dispose();player=new ExecutionPlayback(root,data.turn,data.details,data);turnId=data.turn.turn_id;}
  }else if(data?.type==='astercite-trace-data'){
    player?.dispose();player=null;turnId=null;document.body.classList.remove('replay-page');document.title='AsterCite · 请求详情';renderTrace(root,data.detail);
  }else if(data?.type==='astercite-trace-error'){player?.dispose();player=null;root.textContent='这次请求没有可读取的详情。';}
});
window.addEventListener('pagehide',()=>player?.dispose());
if(window.opener)window.opener.postMessage({type:'astercite-trace-ready'},location.origin);else root.textContent='请从论文工作台点击回答下方的“查看执行过程”。';
