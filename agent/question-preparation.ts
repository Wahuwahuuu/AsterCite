import { RuntimeFailure, codepoints, object, type Paper } from "./contracts.ts";
import type { DialogueRecord, UserConstraint } from "./domain-memory.ts";
import type { FullFrame, Intent, ConstraintUpdate } from "./full-stages.ts";
import { stageObject } from "./p2-stages.ts";
import {asksForAbstract} from './paper-reading.ts';

export const PREPARATION_VERSION = "light-v1" as const;
export const WHOLE_QUESTION_NEED = "Address every object, fact, condition, relationship and requested list in the complete original_question; preserve actual dialogue and latest user corrections.";
export const QUESTION_PREPARATION_INSTRUCTION = `Prepare the user's question for fixed-corpus research. Return one JSON object, without an answer or reasoning:
{"intent":"answer|compare|find_papers|summarize|session_update","targets":["public paper ID"],"rewrite":"standalone question","queries":["retrieval query"],"constraints":[]}.
Use only the supplied real dialogue, domain state and public catalog. Resolve pronouns and preserve comparison order, requested conditions, lists and latest user corrections. Prior answers and memory are conversation, never new paper evidence.
targets: at most 4 exact allowed paper IDs. Leave [] if the target is still unknown; never choose arbitrary papers. rewrite: preserve the complete question's meaning, without inserting assumed answers or values. queries: at most 2 strings, each <=1000 Unicode codepoints, for the same targets; the host assigns paper scope and IDs.
constraints: only new/changed explicit user instructions, at most 6 {key,value,source_quote}, quoting exact CURRENT user text. Omit inherited instructions; the host retains their original provenance and supersedes same-key corrections. No paper findings or duplicate current_paper/comparison_order fields.
Optional needs: at most 5 concise necessary subquestions in the user's language. Use one short, independently answerable item for each actual requested goal; do not invent extra work. The host always retains a need covering the complete original question. Optional comparison_dimensions: at most 6 strings.
Optional clarification: {question,reference_quote} only for a genuinely unresolved KEY OBJECT referenced by exact current user text, with targets=[]. Never clarify evidence insufficiency, unavailable external/private resources, or an already explicit/resolved paper. Those are normal bounded-answer/refusal paths.
find_papers uses the actual public catalog; session_update handles greetings, thanks, workbench usage/capability questions and explicit user session instructions without paper findings. These requests need targets:[] and queries:[]. A greeting followed by a paper question is still a paper question. All research requests require paper evidence. Do not output frame_id, need_id, follow_up, citations, source offsets, status or a final answer. No tools in this preparation request.`;

export interface PreparationContext {
  original: string; allowed: ReadonlySet<string>; publicPapers: readonly Paper[]; frameId: string;
  history: readonly DialogueRecord[]; activeConstraints: readonly UserConstraint[];
  priorObjects?: { targets: readonly string[]; comparison_dimensions: readonly string[] };
  targetLimit?:number;
  preferResolvedPaper?:boolean;
  personalMemory?:boolean;
}
export interface PreparedQuestion {
  frame: FullFrame; rewrite: string; warnings: string[]; wrapper: "none" | "preparation";
  routing: "host_queries" | "autonomous_discovery";
}
export interface PreparationRecord {
  version: typeof PREPARATION_VERSION; status: "completed" | "fallback" | "skipped" | "error";
  request_id: string | null; reason: string | null; result: PreparedQuestion | null;
}

function fail(path: string, constraint: string): never { throw new Error(`${path}: required ${constraint}`); }
function text(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || codepoints(value) > maximum) fail(path, `nonempty string <=${maximum} Unicode codepoints`);
  return value as string;
}
function list(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail(path, `array <=${maximum} entries`);
  return value as unknown[];
}
function strings(value: unknown, path: string, maximum: number, length = 500): string[] {
  const result = list(value, path, maximum).map((entry, i) => text(entry, `${path}[${i}]`, length));
  if (new Set(result).size !== result.length) fail(path, "distinct entries");
  return result;
}
const intentMap: Record<string, Intent> = {
  answer: "single_paper_qa", compare: "comparison", find_papers: "paper_discovery", summarize: "scoped_summary", session_update: "session_control",
  single_paper_qa: "single_paper_qa", comparison: "comparison", paper_discovery: "paper_discovery", scoped_summary: "scoped_summary", session_control: "session_control",
};

/** Exact current catalog mentions only; no aliases, semantic inference or evaluation mappings. */
function explicitTargets(context: PreparationContext): string[] {
  const mentions = context.publicPapers.filter(paper => context.allowed.has(paper.paper_id)).flatMap(paper => {
    const escaped = paper.paper_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const id = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "iu").exec(context.original);
    const title = codepoints(paper.title) >= 6 ? context.original.toLocaleLowerCase().indexOf(paper.title.toLocaleLowerCase()) : -1;
    const offset = Math.min(...[id?.index ?? -1, title].filter(position => position >= 0));
    return Number.isFinite(offset) ? [{ id: paper.paper_id, offset }] : [];
  });
  return mentions.sort((a, b) => a.offset - b.offset).map(mention => mention.id);
}

/** Match complete conversational turns only; never strip a greeting from a research question. */
export function isConversationalInput(original: string): boolean {
  const value=original.trim().toLocaleLowerCase().replace(/[.!?。，！？；;、\s]+$/gu,'').replace(/\s+/gu,' ');
  return /^(?:你好(?:呀|啊|哇)?|您好|你好吗|早上好|上午好|中午好|下午好|晚上好|早安|晚安|谢谢(?:你|您)?|多谢|再见|拜拜|你是谁|你叫什么|介绍一下你自己|你能做什么|你能干什么|你能帮我做什么|你有什么功能|怎么使用你|使用帮助|hi|hello|hey|thanks|thank you|good morning|good evening|bye|help|what can you do)$/u.test(value);
}

/** Product-only personal memory control; research findings still require paper evidence. */
export function isMemorySessionInput(original:string):boolean{
  const value=original.trim().replace(/[.!?。，！？\s]+$/gu,'');
  if(/^(?:请)?(?:帮我)?记住(?:一下)?(?:[：:，,\s]+|(?=[我这今以当]))[\s\S]+$/u.test(value)&&!/(?:另外|然后|同时|并且|顺便|还请|请你|帮我|并)[，,\s]*(?:请)?(?:帮我)?(?:解释|分析|比较|总结|推导|检索)/u.test(value))return true;
  if(/^(?:你(?:还)?记得)?(?:我|我们)(?:上次|之前|昨天|最近).{0,50}(?:哪篇|哪些论文|什么论文|研究什么|什么方向|读到哪).{0,12}$/u.test(value)&&!/方法|结果|准确率|公式|实验|性能|数据集|原理/u.test(value))return true;
  if(/^(?:你(?:还)?记得)?我(?:的)?(?:研究方向|研究主题|回答偏好|偏好|习惯)(?:是什么|是啥|是什么来着|吗)?$/u.test(value))return true;
  return /^(?:请)?(?:以后|今后|后续|默认|始终|一直).{0,12}(?:中文|英文|英语|汉语|简短|简洁|详细).{0,12}$/u.test(value)&&!/论文|实验|公式|检索|总结|翻译|比较/u.test(value);
}

export function rawQuestionFrame(original: string, frameId: string): FullFrame {
  return { frame_id: frameId, question_text: original, candidate_papers: [], ordered_targets: [], information_needs: [{ need_id: "n1", text: WHOLE_QUESTION_NEED }],
    queries: [], ambiguity: null, user_constraints: [], intent: isConversationalInput(original)?"session_control":"single_paper_qa", follow_up: false, constraints: [], comparison_dimensions: [] };
}

export function parseQuestionPreparation(response: string, context: PreparationContext): PreparedQuestion {
  try {
    let raw = stageObject(response);
    const warnings: string[] = [];
    let wrapper: PreparedQuestion["wrapper"] = "none";
    if (Object.keys(raw).length === 1 && Object.hasOwn(raw, "preparation")) { raw = object(raw.preparation); wrapper = "preparation"; }
    if (!["intent", "targets", "rewrite", "queries"].some(key => Object.hasOwn(raw, key))) fail("preparation", "question-preparation fields, not a final-answer envelope");
    const fields = ["intent", "targets", "rewrite", "queries", "constraints", "needs", "comparison_dimensions", "clarification"];
    if (Object.keys(raw).some(key => !fields.includes(key))) warnings.push("unused_fields_ignored");
    const conversational=isConversationalInput(context.original)||context.personalMemory===true&&isMemorySessionInput(context.original);
    let intent = conversational?"session_control":typeof raw.intent === "string" && Object.hasOwn(intentMap, raw.intent) ? intentMap[raw.intent] : "single_paper_qa";
    if(conversational&&raw.intent!=="session_update"&&raw.intent!=="session_control")warnings.push("conversation_intent_restored");
    if (typeof raw.intent !== "string" || !Object.hasOwn(intentMap, raw.intent)) warnings.push("unknown_intent_defaulted_to_answer");
    const targetLimit=context.targetLimit??4;
    let targets = strings(raw.targets ?? [], "targets", targetLimit, 100);
    if (targets.some(id => !context.allowed.has(id))) fail("targets", "only currently allowed public paper IDs");
    const explicit = explicitTargets(context);
    // Valid model interpretation owns exclusions and corrections. Exact mentions
    // only fill a missing object; they must not force every mentioned paper into scope.
    if (!targets.length && explicit.length > targetLimit) fail("targets", "too many current explicit objects; use autonomous scoped discovery for larger lists");
    if (!targets.length && explicit.length) { targets = explicit; warnings.push("explicit_targets_used"); }
    const paperReference=/这篇|那篇|该论文|该篇|上述论文|同一篇|\b(?:this|that|the same) paper\b/iu;
    const clarification=raw.clarification as {reference_quote?:unknown}|undefined;
    if(context.preferResolvedPaper&&!targets.length&&paperReference.test(context.original)&&intent!=='comparison'&&(!clarification||typeof clarification.reference_quote==='string'&&paperReference.test(clarification.reference_quote))){
      const prior=context.priorObjects?.targets.filter(id=>context.allowed.has(id))??[];
      const resolved=prior.length===1?prior:context.allowed.size===1?[...context.allowed]:[];
      if(resolved.length===1){targets=resolved;warnings.push('resolved_paper_reference_retained');}
    }
    if(conversational)targets=[];
    if(context.preferResolvedPaper&&asksForAbstract(context.original)&&intent==='paper_discovery'){intent=targets.length>1?'scoped_summary':'single_paper_qa';warnings.push('paper_reading_intent_restored');}
    const rewrite = raw.rewrite === undefined ? context.original : text(raw.rewrite, "rewrite", 12000);
    if (raw.rewrite === undefined) warnings.push("rewrite_defaulted_to_original");
    const inherited: UserConstraint[] = [];
    const constraints: ConstraintUpdate[] = list(raw.constraints ?? [], "constraints", 6).flatMap((entry, index) => {
      const item = object(entry), path = `constraints[${index}]`;
      const key = text(item.key, `${path}.key`, 100), value = text(item.value, `${path}.value`, 500), quote = text(item.source_quote, `${path}.source_quote`, 500);
      if (["current_paper", "comparison_order"].includes(key) || Object.keys(item).some(field => !["key", "value", "source_quote"].includes(field))) fail(path, "user constraint only; host owns objects and same-key supersession");
      if (!context.original.includes(quote)) {
        const matches = context.activeConstraints.filter(old => old.superseded_by === null && old.key === key && old.value === value && old.source_quote === quote);
        if (matches.length === 1 && context.history.some(turn => turn.turn_id === matches[0].source_turn && turn.user_text.includes(quote))) {
          inherited.push(structuredClone(matches[0])); warnings.push("inherited_constraint_retained"); return [];
        }
        fail(`${path}.source_quote`, "exact current user substring or unchanged active constraint anchored to its actual original user turn");
      }
      return [{ key, value, source_quote: quote }];
    });
    if (new Set(constraints.map(item => item.key)).size !== constraints.length) fail("constraints", "distinct keys");
    let ambiguity: string | null = null;
    if (raw.clarification !== undefined && raw.clarification !== null) {
      if (targets.length || ["paper_discovery", "session_control"].includes(intent)) warnings.push("clarification_ignored_for_resolved_object");
      else {
        const clarification = object(raw.clarification);
        const quote = text(clarification.reference_quote, "clarification.reference_quote", 500);
        if (!context.original.includes(quote)) fail("clarification.reference_quote", "exact unresolved reference in current user question");
        ambiguity = text(clarification.question, "clarification.question", 500);
      }
    }
    const needs = strings(raw.needs ?? [], "needs", 5);
    const sameObjects = targets.length > 0 && context.priorObjects?.targets.length === targets.length && targets.every(id => context.priorObjects!.targets.includes(id));
    const dimensions = strings(raw.comparison_dimensions ?? (sameObjects ? [...context.priorObjects!.comparison_dimensions] : []), "comparison_dimensions", 6);
    if (sameObjects && raw.comparison_dimensions === undefined && dimensions.length) warnings.push("comparison_dimensions_inherited");
    const nonFactual = ["paper_discovery", "session_control"].includes(intent);
    const scope = targets.length ? targets : [...context.allowed];
    const routing: PreparedQuestion["routing"] = !nonFactual && !ambiguity && scope.length > 4 ? "autonomous_discovery" : "host_queries";
    let queries = strings(raw.queries ?? [], "queries", 2, 1000);
    if (!nonFactual && !ambiguity && !queries.length) {
      queries = [Array.from(rewrite).slice(0, 1000).join("")]; warnings.push("query_defaulted_to_rewrite");
    }
    if (routing === "autonomous_discovery") warnings.push("missing_target_requires_discovery");
    const frame: FullFrame = { ...rawQuestionFrame(context.original, context.frameId), intent, follow_up: context.history.length > 0,
      candidate_papers: [...targets], ordered_targets: [...targets], constraints, comparison_dimensions: dimensions,
      user_constraints: constraints.map(item => `${item.key}: ${item.value}`), ambiguity,
      information_needs: [{ need_id: "n1", text: WHOLE_QUESTION_NEED }, ...needs.map((need, i) => ({ need_id: `n${i + 2}`, text: need }))],
      queries: nonFactual || ambiguity || routing === "autonomous_discovery" ? [] : queries.map(query => ({ query, paper_ids: [...scope] })),
      ...(inherited.length ? { inherited_constraints: inherited } : {}) };
    return { frame, rewrite, warnings: [...new Set(warnings)], wrapper, routing };
  } catch (error) { throw new RuntimeFailure("PREPARATION_ERROR", error instanceof Error ? error.message : "Invalid question preparation"); }
}

/** Real final answer bodies only; no internal drafts, provider frames, or answer-schema examples. */
export function preparationPayload(context: PreparationContext, domainState: unknown, nativeSummary?: string, completeHistory=false): Record<string, unknown> {
  const recent = (completeHistory?context.history:context.history.slice(-4)).map(turn => ({ turn_id: turn.turn_id, user_text: turn.user_text,
    assistant_text: completeHistory?turn.final_answer:Array.from(turn.final_answer).slice(0, 4000).join("") }));
  return { original_question: context.original, allowed_papers: [...context.allowed],
    public_catalog: context.publicPapers.filter(paper => context.allowed.has(paper.paper_id)).map(({ paper_id, title }) => ({ paper_id, title })),
    recent_dialogue: recent, domain_state: domainState,
    ...(nativeSummary ? { native_compaction_summary: nativeSummary } : {}) };
}
