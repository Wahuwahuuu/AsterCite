import { RuntimeFailure, codepoints, type Chunk } from "./contracts.ts";
import { stageObject } from "./p2-stages.ts";
import { citationIds } from "./p2-r2.ts";

export type BusinessStatus = "answer" | "partial" | "refusal" | "clarification";
export type AnswerKind = "paper_fact" | "catalog" | "session_control";
export interface FinalAnswer { status: BusinessStatus; answer_kind: AnswerKind; answer: string; exact_quotes: Array<{ chunk_id: string; quote: string; start: number; end: number }>;paper_coverage?:import("./selected-scope.ts").PaperCoverage[] }
export const FINAL_ANSWER_INSTRUCTION = `Return only one JSON object: {"status":"answer|partial|refusal|clarification","answer_kind":"paper_fact|catalog|session_control","answer":"final user-facing text","exact_quotes":[]}.
For paper_fact, answer and partial require actual visible citations [cite:chunk_id]. Clarification asks about a genuinely ambiguous object/meaning. A refusal may explain missing evidence without citations or unsupported findings.
Use session_control for greetings, thanks, workbench usage/capability questions and user session instructions. Respond naturally without paper citations or research claims. Use catalog for actual public catalog information. Follow the host's known answer kind; if omitted, that known kind is retained, otherwise the default is paper_fact. These labels do not prove semantic correctness.
Unresolved evidence permits supported partial facts, bounded refusal or necessary clarification; it never permits a complete affirmative answer.
exact_quotes describes VERBATIM TEXT ACTUALLY PRESENT IN answer, not an evidence list or Reflect support_spans. For ordinary faithful paraphrases use exact_quotes:[], even when grounded in excerpts. Keep valid [cite:chunk_id] markers.
Only if answer quotes original wording, declare {chunk_id,quote}; copy one exact contiguous source substring and include the SAME decoded string in answer. Do not append unused source quotes as metadata. JSON escape once without changing decoded source text.
For fictional source demo containing "The sample contains three items.": paraphrase {"status":"answer","answer":"There are 3 items [cite:demo]","exact_quotes":[]}; verbatim {"status":"answer","answer":"The sample contains three items. [cite:demo]","exact_quotes":[{"chunk_id":"demo","quote":"The sample contains three items."}]}. Never use fictional IDs in real answers.
Do not expose hidden reasoning. Previous model assessments are fallible; never claim full correctness from their status.`;

export function parseFinalAnswer(text: string, evidence: ReadonlyMap<string, Chunk>, allowAnswer: boolean, ambiguity: boolean, expectedKind?: AnswerKind): FinalAnswer {
  try {
    const raw = stageObject(text);
    for (const key of Object.keys(raw)) if (!["status", "answer_kind", "answer", "exact_quotes"].includes(key)) throw new Error(`final.${key}: unexpected field`);
    const kind = raw.answer_kind ?? expectedKind ?? "paper_fact";
    if (!["paper_fact", "catalog", "session_control"].includes(kind as string) || expectedKind && kind !== expectedKind) throw new Error(`final.answer_kind: expected ${expectedKind ?? "paper_fact|catalog|session_control"}, got ${JSON.stringify(kind)}`);
    if (!["answer", "partial", "refusal", "clarification"].includes(raw.status as string)) throw new Error(`final.status: value=${JSON.stringify(raw.status)}; required answer|partial|refusal|clarification`);
    if (typeof raw.answer !== "string" || !raw.answer.trim() || codepoints(raw.answer) > 16000) throw new Error("final.answer: required nonempty text <=16000 Unicode codepoints");
    const answerText = raw.answer;
    if (ambiguity && raw.status !== "clarification") throw new Error(`final.status: value=${JSON.stringify(raw.status)}; unresolved object ambiguity requires clarification, with answer_kind=${JSON.stringify(expectedKind ?? kind)} and a concrete question about the ambiguous object`);
    if (!allowAnswer && raw.status === "answer") throw new Error("final.status: unresolved evidence cannot use answer; use supported partial/refusal/clarification");
    const ids = citationIds(raw.answer);
    const illegal = ids.filter((id) => !evidence.has(id));
    if (illegal.length) throw new RuntimeFailure("INVALID_CITATION", `final.answer: citations not currently visible ${JSON.stringify(illegal)}`);
    if (kind === "paper_fact" && ["answer", "partial"].includes(raw.status as string) && !ids.length) throw new RuntimeFailure("INVALID_CITATION", "final.answer: factual answer/partial requires a visible [cite:chunk_id]");
    const quotes = raw.exact_quotes ?? [];
    if (!Array.isArray(quotes) || quotes.length > 12) throw new Error("final.exact_quotes: required array <=12");
    const exact = quotes.map((value,index) => {
      const item = value as Record<string, unknown>;
      if (!item || Object.keys(item).sort().join() !== "chunk_id,quote" || typeof item.chunk_id !== "string" || typeof item.quote !== "string" || !item.quote.trim() || codepoints(item.quote) > 2000) throw new Error("final.exact_quotes[]: required chunk_id and quote <=2000");
      const source = evidence.get(item.chunk_id), offset = source?.text.indexOf(item.quote) ?? -1;
      const invalid=(field:string,value:unknown,constraint:string):never=>{throw new RuntimeFailure("INVALID_CITATION",`final.exact_quotes[${index}].${field}: value=${JSON.stringify(value)}; required ${constraint}`);};
      if(!source) invalid("chunk_id",item.chunk_id,"an actually visible source ID");
      if(!ids.includes(item.chunk_id)) invalid("chunk_id",item.chunk_id,"the same [cite:chunk_id] in answer");
      if(offset<0) invalid("quote",item.quote,`a unique exact contiguous substring (source span) of ${item.chunk_id}; decoded JSON text must match source`);
      if(source!.text.indexOf(item.quote,offset+1)>=0) invalid("quote",item.quote,"a unique source span; this text occurs 2 or more times in the source");
      if(!answerText.includes(item.quote)) invalid("quote",item.quote,"appear verbatim in answer; for a faithful paraphrase use exact_quotes:[] and keep actual source citations, or quote the original text explicitly in answer");
      const start = Array.from(source!.text.slice(0, offset)).length;
      return { chunk_id: item.chunk_id, quote: item.quote, start, end: start + codepoints(item.quote) };
    });
    return { status: raw.status as BusinessStatus, answer_kind: kind as AnswerKind, answer: raw.answer, exact_quotes: exact };
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    throw new RuntimeFailure("ANSWER_SCHEMA_ERROR", error instanceof Error ? error.message : "Invalid final answer structure");
  }
}
