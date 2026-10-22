/** Bounded host formatting and routing adapters; no Gold, fuzzy source matching or extra model. */
import { RuntimeFailure, type Chunk } from "./contracts.ts";
import { parseFinalAnswer, type AnswerKind } from "./final-answer.ts";
import { parseQuestionPreparation, type PreparationContext } from "./question-preparation.ts";
import { parseFullCheck } from "./full-stages-main-v2.ts";
import type { QuestionFrame } from "./p2-stages.ts";
import type { R2Check } from "./p2-r2.ts";

export type Audit = (kind: string) => void;

/** A single complete terminal object only; arbitrary prose is never turned into an answer. */
export function decodeCandidateJSON(response: string, audit: Audit = () => {}): string {
  if (Array.from(response).length > 16000) throw new Error("JSON response exceeds the declared visible-text bound");
  let text = response.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(text);
  if (fence) text = fence[1].trim();
  const objects: Array<{ start: number; end: number; text: string }> = [];
  let start = -1, depth = 0, quoted = false, escaped = false, changed = false, out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (start < 0) {
      if (ch !== "{") continue;
      start = i; depth = 1; out = "{"; quoted = false; escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) { escaped = false; out += ch; }
      else if (ch === "\\") { escaped = true; out += ch; }
      else if (ch === '"') { quoted = false; out += ch; }
      else if (ch.charCodeAt(0) < 32) { out += JSON.stringify(ch).slice(1, -1); changed = true; }
      else out += ch;
    } else {
      out += ch;
      if (ch === '"') quoted = true;
      else if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) { objects.push({ start, end: i + 1, text: out }); start = -1; }
    }
  }
  if (start >= 0 || objects.length !== 1 || text.slice(objects[0].end).trim() || text.trimStart().startsWith("[")) throw new Error("Expected one complete terminal JSON object; multiple/truncated candidates rejected");
  const json = objects[0].text;
  JSON.parse(json); // validates arrays, escapes, values and syntax before the key scan
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (ch === "{") stack.push(new Set());
    else if (ch === "[") stack.push(null);
    else if (ch === "}" || ch === "]") stack.pop();
    else if (ch === '"') {
      const from = i; let escape = false;
      for (i++; i < json.length; i++) {
        if (escape) escape = false;
        else if (json[i] === "\\") escape = true;
        else if (json[i] === '"') break;
      }
      let next = i + 1; while (/\s/u.test(json[next] ?? "") && next < json.length) next++;
      if (json[next] === ":") {
        const key = JSON.parse(json.slice(from, i + 1)) as string, keys = stack.at(-1);
        if (!keys || keys.has(key)) throw new Error(`Duplicate JSON field rejected: ${key}`);
        keys.add(key);
      }
    }
  }
  if (objects[0].start > 0) audit("terminal_json_envelope_extracted");
  if (changed) audit("json_string_control_characters_escaped");
  return json;
}

export function parseCandidateFinal(response: string, evidence: ReadonlyMap<string, Chunk>, allowAnswer: boolean, ambiguity: boolean, kind?: AnswerKind, audit?: Audit) {
  let json: string;
  try { json = decodeCandidateJSON(response, audit); }
  catch (error) { throw new RuntimeFailure("ANSWER_SCHEMA_ERROR", error instanceof Error ? error.message : "Invalid JSON"); }
  return parseFinalAnswer(json, evidence, allowAnswer, ambiguity, kind);
}

export function parseCandidatePreparation(response: string, context: PreparationContext, audit: Audit = () => {}) {
  const json = decodeCandidateJSON(response, audit), value = JSON.parse(json);
  const raw = value.preparation ?? value;
  const prepared = parseQuestionPreparation(json, context);
  if (["paper_discovery", "session_control"].includes(prepared.frame.intent) && prepared.frame.ordered_targets.length && Array.isArray(raw.queries) && raw.queries.length) {
    audit("catalog_query_conflict_original_question_fallback");
    throw new RuntimeFailure("PREPARATION_ERROR", "Nonfactual intent conflicts with a resolved paper and retrieval queries; preserve the original question and fall back to autonomous retrieval");
  }
  return prepared;
}

export function parseCandidateCheck(response: string, frame: QuestionFrame, allowed: ReadonlySet<string>, evidence: ReadonlyMap<string, Chunk>, previous?: R2Check, audit: Audit = () => {}) {
  try {
    const json = decodeCandidateJSON(response, audit), raw = JSON.parse(json);
    if (Array.isArray(raw.checks)) for (const item of raw.checks) {
      if (!item || typeof item !== "object") continue;
      const prior = previous?.checks.find(c => c.need_id === item.need_id);
      const upgrading = Boolean(item.status === "supported" && prior && prior.status !== "supported");
      if (!upgrading && item.gap_resolution != null) audit("unused_gap_resolution_ignored");
      if (Array.isArray(item.support_spans)) {
        if (item.support_spans.length > 2) audit("bounded_multi_span_support");
        for (const span of item.support_spans) {
          if (!span || typeof span.quote !== "string") continue;
          const source = evidence.get(span.chunk_id);
          if (!source || source.text.includes(span.quote)) continue;
          const restored = span.quote.replace(/\\(["\\])/gu, "$1"), at = source.text.indexOf(restored);
          if (restored !== span.quote && at >= 0 && source.text.indexOf(restored, at + 1) < 0) {
            span.quote = restored; audit("source_proven_quote_escape_restored");
          }
        }
      }
    }
    return parseFullCheck(JSON.stringify(raw), frame, allowed, evidence, previous);
  } catch (error) { throw new RuntimeFailure("CHECK_ERROR", error instanceof Error ? error.message : "Invalid candidate check"); }
}
