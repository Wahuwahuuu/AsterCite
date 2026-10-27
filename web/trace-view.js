const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
const json=value=>JSON.stringify(value,null,2);
function code(value){return node('pre','trace-code',typeof value==='string'?value:json(value));}
export function renderTrace(root,detail){
  const tab=root.dataset.tab||'input';root.replaceChildren();
  const head=node('header','trace-head');head.append(node('h1',null,detail.kind==='tool'?`工具调用 · ${detail.tool}`:detail.stage==='source_translation'?'原文翻译请求':`第 ${detail.cycle??1} 次模型请求`),node('p',null,`${detail.status==='running'?'正在执行':detail.status==='error'?'执行未完成':'执行完成'} · ${detail.stage} · ${detail.origin==='host_plan'?'由检索计划发起':detail.kind==='tool'?'由模型发起':'模型调用'}`));root.append(head);
  const tabs=node('nav','trace-tabs');tabs.setAttribute('aria-label','请求详情');
  const panels={input:node('section','trace-section'),output:node('section','trace-section'),tools:node('section','trace-section')};
  for(const [id,label] of [['input',detail.kind==='tool'?'调用参数':'输入上下文'],['output',detail.kind==='tool'?'工具返回':'模型输出'],['tools','工具与请求信息']]){
    const button=node('button',id===tab?'selected':'',label);button.type='button';button.setAttribute('aria-pressed',String(id===tab));button.addEventListener('click',()=>{root.dataset.tab=id;renderTrace(root,detail);});tabs.append(button);panels[id].hidden=id!==tab;
  }root.append(tabs);
  const input=detail.input;
  if(Array.isArray(input?.messages)){
    panels.input.append(node('p','trace-description',`${input.messages.length} 条消息 · ${input.format==='provider_payload'?'实际发送的模型请求':'SDK 中的模型上下文'}`));
    for(const [index,message] of input.messages.entries()){
      const section=node('details','trace-message');section.open=index===input.messages.length-1;
      section.append(node('summary',null,`${index+1}. ${message.role}${message.tool_name?' · '+message.tool_name:''}`),code(message.text));
      if(message.tool_calls?.length)section.append(node('h2',null,'工具调用'),code(message.tool_calls));if(message.tool_call_id)section.append(node('p','trace-meta','tool_call_id: '+message.tool_call_id));panels.input.append(section);
    }
  }else panels.input.append(input?code(input):node('p',null,'请求内容正在准备。'));
  if(detail.output){panels.output.append(code(detail.output.text||'（本次没有文本输出）'));if(detail.output.tool_calls?.length)panels.output.append(node('h2',null,'模型要求执行的工具'),code(detail.output.tool_calls));}
  else panels.output.append(node('p',null,detail.status==='running'?'正在等待返回，窗口会自动更新。':'本次没有可见输出。'));
  panels.tools.append(node('h2',null,'请求标识'),code({request_id:detail.id,parent_request_id:detail.parent_id??null,phase:detail.phase,stage:detail.stage,origin:detail.origin??'model',started_at:detail.started_at??null,elapsed_ms:detail.elapsed_ms}));
  if(input?.settings)panels.tools.append(node('h2',null,'请求设置'),code(input.settings));
  if(input?.tools)panels.tools.append(node('h2',null,'本次可调用的工具'),code(input.tools));
  root.append(panels.input,panels.output,panels.tools);
}
