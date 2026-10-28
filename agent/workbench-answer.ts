import type {Chunk,Paper} from './contracts.ts';
import type {AnswerKind,BusinessStatus,FinalAnswer} from './final-answer.ts';
import type {PaperCoverage} from './selected-scope.ts';
import {citationIds} from './p2-r2.ts';
import {decodeCandidateJSON} from './main-reliability-v2.ts';
import {inspectCitationAttribution,type ClaimAttribution} from './citation-attribution.ts';

export const WORKBENCH_ANSWER_POLICY='workbench-v1' as const;
const OUTPUT_LIMIT=256_000;
export const WORKBENCH_ANSWER_INSTRUCTION=`Answer the complete original user question naturally, using readable Markdown. Ordinary prose is valid; an optional JSON envelope may use status, answer_kind, answer, exact_quotes and paper_coverage. Missing auxiliary fields or formatting must not prevent a useful answer.
For research findings, use only the actual visible paper excerpts and copy their exact [cite:chunk_id] markers. Never invent a source, equate retrieval with correctness, or attach an unrelated excerpt to a claim. Distinguish supported findings, interpretation, and evidence gaps. If only part can be answered, answer that part and state what remains unknown. No need to turn every gap into a refusal.
Place citations next to the factual statement or within its paragraph, especially experimental numbers. A citation to a methods paragraph cannot support an accuracy found only in a catalog preview. For original abstracts, read retrieve_chunks section=abstract before explaining results. Explicitly distinguish paper-reported numbers from your own calculations and examples.
Respond normally to conversational questions, workbench usage and user preferences without requiring paper citations. Treat the QuestionFrame and optional evidence check as fallible hints; preserve the original question and real conversation. Ask clarification only when an unresolved ambiguity actually prevents a useful answer.
Do not reveal hidden reasoning. Do not output auxiliary quote annotations unless useful; a paraphrase does not require exact_quotes.`;

export interface WorkbenchContext {
  evidence:ReadonlyMap<string,Chunk>;expectedKind?:AnswerKind;allowAnswer:boolean;
  requiredPapers?:readonly string[];papers?:readonly Paper[];
  truncated?:boolean;
}
export interface WorkbenchAnswer {
  value:FinalAnswer;original:string;notices:string[];adaptations:string[];
  citationIssues:string[];needsCitationRepair:boolean;visibleCitationCount:number;
  attribution:ClaimAttribution[];
  pendingAction:boolean;
}

/** An explicit unexecuted action at the end is a continuation, not a finished explanation. */
export function pendingWorkbenchAction(text:string):boolean{
  return /(?:^|[。！？.!?\n])\s*(?:(?:让|容)我(?:再|继续|先|来)?|我(?:会|将|需要|先|再|接下来(?:会)?))[^。！？.!?\n]{0,100}(?:检索|搜索|查阅|查询|查找|核实|读取|阅读)[^。！？.!?\n]{0,100}[：:。.!！\s]*$/u.test(text)
    ||/(?:^|[.!?\n])\s*(?:let me|i (?:will|shall|need to|am going to)|i['’]ll)\s+[^.!?\n]{0,80}(?:look up|search|retrieve|read|check|inspect)[^.!?\n]{0,100}[:.!\s]*$/iu.test(text);
}

export function workbenchSystemPrompt(prompt:string):string{
  return prompt.replace('Final answers use the host JSON contract with explicit business status and separately declared exact quotes.','Final answers may use readable Markdown. JSON packaging, exact quote metadata and coverage metadata are optional; source authenticity and clear evidence gaps remain required.');
}

function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}

/** Recover only a complete top-level answer string, never an unfinished or guessed string. */
function completeAnswerString(source:string):string|undefined{
  if(!source.startsWith('{'))return;
  let depth=0,arrays=0;
  for(let i=0;i<source.length;i++){
    const ch=source[i];if(ch==='{' ){depth++;continue;}if(ch==='}'){depth--;continue;}if(ch==='['){arrays++;continue;}if(ch===']'){arrays--;continue;}
    if(ch!=='"')continue;const start=i;let escaped=false;
    for(i++;i<source.length;i++){if(escaped)escaped=false;else if(source[i]==='\\')escaped=true;else if(source[i]==='"')break;}
    if(i>=source.length)return;let text:unknown;try{text=JSON.parse(source.slice(start,i+1));}catch{continue;}
    let next=i+1;while(next<source.length&&/\s/u.test(source[next]))next++;
    if(depth===1&&arrays===0&&text==='answer'&&source[next]===':'){
      next++;while(next<source.length&&/\s/u.test(source[next]))next++;if(source[next]!=='"')return;
      const from=next;escaped=false;for(next++;next<source.length;next++){if(escaped)escaped=false;else if(source[next]==='\\')escaped=true;else if(source[next]==='"'){try{return JSON.parse(source.slice(from,next+1));}catch{return;}}}
      return;
    }
  }
}

function bodyFrom(output:string,adaptations:string[]):{raw:Record<string,unknown>;body:string}|null{
  if(!output.trim())return null;
  try{
    let value:unknown=JSON.parse(decodeCandidateJSON(output,kind=>adaptations.push(kind),OUTPUT_LIMIT));
    if(record(value)){
      if(record(value.final_answer)){value=value.final_answer;adaptations.push('answer_wrapper_removed');}
      if(record(value)&&typeof value.answer==='string')return {raw:value,body:value.answer};
      if(record(value)&&value.answer!==undefined&&value.answer!==null&&typeof value.answer!=='string'){
        adaptations.push('structured_answer_body_preserved');return {raw:value,body:JSON.stringify(value.answer,null,2)};
      }
      if(record(value)){
        const fields=value,alternatives=['final_answer','response','text','content'].filter(key=>typeof fields[key]==='string'&&String(fields[key]).trim());
        if(alternatives.length===1){adaptations.push('answer_field_normalized');return {raw:fields,body:fields[alternatives[0]] as string};}
      }
      if(record(value)&&(Object.hasOwn(value,'status')||Object.hasOwn(value,'answer_kind')||Object.hasOwn(value,'exact_quotes')))return null;
    }
  }catch{
    const extracted=completeAnswerString(output.trim());
    if(extracted!==undefined){adaptations.push('complete_body_preserved_from_incomplete_envelope');return {raw:{},body:extracted};}
  }
  adaptations.push('ordinary_answer_text_accepted');return {raw:{},body:output.trim()};
}

export function workbenchCoverageInstruction(ids:readonly string[],papers:readonly Paper[]):string{
  if(!ids.length)return '';
  return `Address each selected paper separately: ${JSON.stringify(ids.map(id=>({paper_id:id,title:papers.find(paper=>paper.paper_id===id)?.title??id})))}. Prefer a heading with paper ID/title, then explain its actual findings or the bounded evidence gap. Use each paper's own visible citations. Do not force a Twitter-text question onto an unrelated speech/dialogue paper. If time/tool allowance prevents covering a paper, say so. paper_coverage metadata is optional; clear readable coverage in the answer is the priority.`;
}

/** Presentation normalization is separate from the strict research answer contract. */
export function prepareWorkbenchAnswer(output:string,context:WorkbenchContext):WorkbenchAnswer|null{
  const adaptations:string[]=[],notices:string[]=[],citationIssues:string[]=[];
  const parsed=bodyFrom(output,adaptations);if(!parsed||!parsed.body.trim())return null;
  const raw=parsed.raw;let body=parsed.body,limited=false;
  if(Array.from(body).length>OUTPUT_LIMIT){body=Array.from(body).slice(0,OUTPUT_LIMIT).join('');limited=true;notices.push('内容较长，当前保留已生成的前半部分');adaptations.push('visible_answer_size_bounded');}
  if(context.truncated){limited=true;notices.push('回答达到本次输出长度上限，已保留生成内容，可继续追问');adaptations.push('truncated_answer_preserved');}
  const declared=raw.answer_kind;
  const kind:AnswerKind=context.expectedKind??(['paper_fact','catalog','session_control'].includes(String(declared))?declared as AnswerKind:'paper_fact');
  if(declared!==undefined&&declared!==kind)adaptations.push('answer_kind_reconciled_with_question');
  let status:BusinessStatus=['answer','partial','refusal','clarification'].includes(String(raw.status))?raw.status as BusinessStatus:'answer';
  if(Object.keys(raw).some(key=>!['status','answer_kind','answer','final_answer','exact_quotes','paper_coverage'].includes(key)))adaptations.push('auxiliary_answer_fields_ignored');
  // Exact identity only. Numeric reference labels are never guessed into source IDs.
  body=body.replace(/\[\s*(?:cite\s*:\s*)?([^\]\n]+?)\s*\]|【\s*cite\s*:\s*([^】\n]+?)\s*】/giu,(marker:string,ordinary:string|undefined,wide:string|undefined)=>{
    const id=(wide??ordinary??'').trim();
    if(context.evidence.has(id)){if(marker!==`[cite:${id}]`)adaptations.push('visible_citation_format_normalized');return `[cite:${id}]`;}
    if(/^\[\s*cite\s*:/iu.test(marker)||wide!==undefined){citationIssues.push(id);return '〔引用未定位〕';}
    return marker;
  });
  const attribution=kind==='paper_fact'&&['answer','partial'].includes(status)?inspectCitationAttribution(body,context.evidence):{answer:body,checks:[],issues:[]};
  body=attribution.answer;citationIssues.push(...attribution.issues);
  if(attribution.issues.length){notices.push('部分关键数值尚未在其引用原文中找到对应依据，已在文中标出');adaptations.push('claim_value_source_mismatch_flagged');}
  const ids=citationIds(body),quotes:FinalAnswer['exact_quotes']=[];
  for(const entry of Array.isArray(raw.exact_quotes)?raw.exact_quotes:[]){
    if(!record(entry)||typeof entry.chunk_id!=='string'||typeof entry.quote!=='string'||!entry.quote.trim()){adaptations.push('invalid_quote_metadata_ignored');continue;}
    const source=context.evidence.get(entry.chunk_id),offset=source?.text.indexOf(entry.quote)??-1;
    if(!body.includes(entry.quote)){adaptations.push('unused_quote_metadata_ignored');continue;}
    if(!source||!ids.includes(entry.chunk_id)||offset<0){notices.push('部分逐字引文的标注未能与原文对应，阅读时请核对');adaptations.push('unmatched_quote_metadata_ignored');continue;}
    if(source.text.indexOf(entry.quote,offset+1)>=0){adaptations.push('ambiguous_quote_offset_omitted');continue;}
    const start=Array.from(source.text.slice(0,offset)).length;quotes.push({chunk_id:entry.chunk_id,quote:entry.quote,start,end:start+Array.from(entry.quote).length});
  }
  if(citationIssues.some(issue=>!issue.startsWith('metric_source_mismatch:')))notices.push('部分引用未能定位到原文，已取消对应链接');
  const positive=status==='answer'||status==='partial',missing=kind==='paper_fact'&&positive&&!ids.length;
  if(missing){citationIssues.push('missing_visible_citation');notices.push('这份回答尚未关联到论文原文，其中的研究结论需要进一步核对');}
  if(!context.allowAnswer&&status==='answer'){status='partial';notices.push('现有依据尚未覆盖全部问题，当前保留已生成的回答');}
  const required=context.requiredPapers??[];let coverage:PaperCoverage[]|undefined;
  if(required.length){
    const supplied=Array.isArray(raw.paper_coverage)?raw.paper_coverage:[];
    coverage=required.map(paperId=>{
      const citations=ids.filter(id=>context.evidence.get(id)?.paper_id===paperId),prior=supplied.find(row=>record(row)&&row.paper_id===paperId);
      const insufficient=!citations.length||record(prior)&&prior.status==='insufficient';
      const summary=record(prior)&&typeof prior.summary==='string'&&prior.summary.trim()?prior.summary:citations.length?`回答已关联本篇论文的 ${citations.length} 处原文。`:'本轮回答尚未关联本篇论文的原文，可继续指定这篇论文追问。';
      return {paper_id:paperId,status:insufficient?'insufficient':'addressed',summary,citations};
    });
    adaptations.push('paper_coverage_derived_from_visible_citations');
    const gaps=coverage.filter(paper=>paper.status==='insufficient');
    if(gaps.length){if(status==='answer')status='partial';notices.push('以下论文尚未充分覆盖：'+gaps.map(paper=>paper.paper_id).join('、'));}
  }
  const pendingAction=kind==='paper_fact'&&pendingWorkbenchAction(body);
  if(pendingAction){status='partial';notices.push('后续检索尚未完成，以上仅为当前已经找到的内容');adaptations.push('unfinished_tool_action');}
  if(positive&&(notices.length||limited))status='partial';
  const distinctNotices=[...new Set(notices)];
  const answer=body+(distinctNotices.length?'\n\n'+(pendingAction?'本轮说明':'原文关联说明')+'：'+distinctNotices.join('；')+'。':'');
  return {value:{status,answer_kind:kind,answer,exact_quotes:quotes,...(coverage?{paper_coverage:coverage}:{})},original:output,
    notices:distinctNotices,adaptations:[...new Set(adaptations)],citationIssues:[...new Set(citationIssues)],
    needsCitationRepair:positive&&citationIssues.length>0&&context.evidence.size>0,visibleCitationCount:ids.length,attribution:attribution.checks,pendingAction};
}

/** A correction must improve source linkage or explicitly withdraw unsupported findings. */
export function preferWorkbenchAnswer(previous:WorkbenchAnswer|undefined,current:WorkbenchAnswer):WorkbenchAnswer{
  if(previous&&previous.pendingAction!==current.pendingAction)return previous.pendingAction?current:previous;
  if(!previous||!current.citationIssues.length||['refusal','clarification'].includes(current.value.status))return current;
  if(current.visibleCitationCount!==previous.visibleCitationCount)return current.visibleCitationCount>previous.visibleCitationCount?current:previous;
  if(current.citationIssues.length!==previous.citationIssues.length)return current.citationIssues.length<previous.citationIssues.length?current:previous;
  return current.value.answer.length>=previous.value.answer.length?current:previous;
}
