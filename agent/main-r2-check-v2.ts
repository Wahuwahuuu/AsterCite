import { object, RuntimeFailure, type Chunk } from "./contracts.ts";
import { stageObject, parseEvidenceCheck, type QuestionFrame } from "./p2-stages.ts";
import type { R2Check } from "./p2-r2.ts";

export function parseR2Check(response: string, frame: QuestionFrame, allowed: ReadonlySet<string>,
  evidence: ReadonlyMap<string, Chunk>, previous?: R2Check, supportQuoteLimit:200|2000=200, gapLimit:500|1000=500): R2Check {
  try {
    if(supportQuoteLimit!==200&&supportQuoteLimit!==2000)throw new Error("Invalid declared support span limit");
    if(gapLimit!==500&&gapLimit!==1000)throw new Error("Invalid declared gap limit");
    const value = stageObject(response);
    if (Object.keys(value).sort().join() !== "checks,next_action,next_queries" || !Array.isArray(value.checks)) throw new Error("Invalid R2 Check fields");
    const raw = value.checks.map(object);
    const legacy = { ...value, checks: raw.map((item) => {
      const required = ["basis", "evidence_ids", "finding", "gap", "gap_resolution", "need_id", "status", "support_spans"];
      const missing = required.filter((key) => !Object.hasOwn(item, key));
      const extra = Object.keys(item).filter((key) => !required.includes(key));
      if (missing.length || extra.length || !Array.isArray(item.evidence_ids) || !Array.isArray(item.support_spans)) {
        throw new Error(`R2 need fields: missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(extra)}. All eight fields are mandatory; evidence_ids and support_spans must be arrays, including [] when insufficient. Null arrays are invalid.`);
      }
      const { support_spans: _spans, gap_resolution: _resolution, ...need } = item; return need;
    }) };
    const base = parseEvidenceCheck(JSON.stringify(legacy), frame, allowed, new Set(evidence.keys()),gapLimit);
    const checks = base.checks.map((need, index) => {
      const item = raw[index];
      if (!Array.isArray(item.support_spans) || item.support_spans.length > 6) throw new Error("Invalid support span list");
      const spans = item.support_spans.map((entry) => {
        const span = object(entry);
        if (Object.keys(span).sort().join() !== "chunk_id,quote" || typeof span.chunk_id !== "string" || typeof span.quote !== "string") throw new Error("Span requires chunk_id and exact quote");
        const chunk = evidence.get(span.chunk_id);
        const quote = span.quote;
        if (!chunk || !quote.trim() || Array.from(quote).length > supportQuoteLimit || !need.evidence_ids.includes(chunk.chunk_id)) throw new Error("Invalid span source/length");
        const offset = chunk.text.indexOf(quote);
        if (offset < 0 || chunk.text.indexOf(quote, offset + 1) >= 0) throw new Error("Quote must match a unique exact source substring");
        const start = Array.from(chunk.text.slice(0, offset)).length, end = start + Array.from(quote).length;
        if (Array.from(chunk.text).slice(start, end).join("") !== quote) throw new Error("Unicode span reconstruction failed");
        return { chunk_id: chunk.chunk_id, start, end, quote };
      });
      const prior = previous?.checks.find((entry) => entry.need_id === need.need_id);
      const upgrading = Boolean(prior && prior.status !== "supported" && need.status === "supported");
      if (need.status === "supported") {
        if (!spans.length || need.evidence_ids.some((id) => !spans.some((span) => span.chunk_id === id))) throw new Error("Every support ID needs an exact span");
        if (upgrading) {
          if (typeof item.gap_resolution !== "string" || !item.gap_resolution.trim() || Array.from(item.gap_resolution).length > 500) throw new Error("Upgrade requires bounded gap_resolution");
          const old = previous!.checks.flatMap((entry) => entry.support_spans);
          if (!spans.some((span) => !old.some((other) => other.chunk_id === span.chunk_id && other.start === span.start && other.end === span.end))) throw new Error("Upgrade requires a new supporting span");
        } else if (item.gap_resolution !== null) throw new Error("No prior gap to resolve");
      } else if (spans.length || item.gap_resolution !== null) throw new Error("Unresolved need cannot claim support spans");
      return { ...need, support_spans: spans, gap_resolution: item.gap_resolution as string | null };
    });
    return { ...base, checks };
  } catch (error) { throw new RuntimeFailure("CHECK_ERROR", error instanceof Error ? error.message : "Invalid R2 Check"); }
}
