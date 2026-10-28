import {redactText} from './contracts.ts';
export interface AnswerUpdate {request_id:string;text:string;source_ids:string[]}
function stringPrefix(source:string,start:number):{text:string;end:number;complete:boolean}{
  let text='';
  for(let i=start+1;i<source.length;i++){
    const ch=source[i];if(ch==='"')return {text,end:i+1,complete:true};
    if(ch!=='\\'){text+=ch;continue;}
    if(++i>=source.length)break;const escaped=source[i];
    if(escaped==='u'){const code=source.slice(i+1,i+5);if(!/^[\da-f]{4}$/iu.test(code))break;text+=String.fromCharCode(Number.parseInt(code,16));i+=4;}
    else{const escapes:Record<string,string>={'"':'"','\\':'\\','/':'/','b':'\b','f':'\f','n':'\n','r':'\r','t':'\t'};if(!Object.hasOwn(escapes,escaped))break;text+=escapes[escaped];}
  }return {text:text.replace(/[\uD800-\uDBFF]$/u,''),end:source.length,complete:false};
}
function jsonBody(source:string,wrapped=false):string{
  let depth=0;
  for(let i=0;i<source.length;i++){
    if(source[i]==='{'){depth++;continue;}if(source[i]==='}'){depth--;continue;}if(source[i]!=='"')continue;
    const key=stringPrefix(source,i);if(!key.complete)return '';i=key.end-1;
    let next=key.end;while(/\s/u.test(source[next]??'')&&next<source.length)next++;
    if(depth!==1||source[next]!==':')continue;next++;while(/\s/u.test(source[next]??'')&&next<source.length)next++;
    if(key.text==='answer'&&source[next]==='"')return stringPrefix(source,next).text;
    if(!wrapped&&key.text==='final_answer'&&source[next]==='{')return jsonBody(source.slice(next),true);
  }return '';
}
/** Decode only visible answer text; a partial JSON envelope never becomes a chat reply. */
export function visibleAnswerPrefix(raw:string,secrets:readonly string[]=[]):string{
  let source=raw.trimStart();
  if(/^```(?:json)?\s*\n/u.test(source)){const body=source.replace(/^```(?:json)?\s*\n/u,'');if(body.trimStart().startsWith('{'))source=body.trimStart();}
  else if(/^`{1,2}$/u.test(source)||/^```(?:j(?:s(?:o(?:n)?)?)?)?$/u.test(source))return '';
  let text=source.startsWith('{')?jsonBody(source):source;
  text=redactText(text,secrets);
  for(const secret of secrets)for(let size=Math.min(secret.length-1,text.length);size>0;size--)if(text.endsWith(secret.slice(0,size))){text=text.slice(0,-size);break;}
  return text;
}
export class AnswerStreamer {
  private request='';private last='';private sentAt=0;
  private notify:(update:AnswerUpdate)=>void;private secrets:readonly string[];private now:()=>number;
  constructor(notify:(update:AnswerUpdate)=>void,secrets:readonly string[]=[],now:()=>number=Date.now){this.notify=notify;this.secrets=secrets;this.now=now;}
  update(request:string,raw:string,sourceIds:readonly string[],force=false){
    if(request!==this.request){this.request=request;this.last='';this.sentAt=0;}
    const text=visibleAnswerPrefix(raw,this.secrets);if(!text||text===this.last||!force&&this.sentAt!==0&&this.now()-this.sentAt<75)return;
    this.last=text;this.sentAt=this.now();try{this.notify({request_id:request,text,source_ids:[...sourceIds]});}catch{/* A closed viewer cannot interrupt generation. */}
  }
}
