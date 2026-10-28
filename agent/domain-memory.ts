import { createHash } from "node:crypto";
import { RuntimeFailure, codepoints, type Chunk, type EvidenceIdentity } from "./contracts.ts";
import type { FullFrame } from "./full-stages.ts";
import type { R2Check } from "./p2-r2.ts";

export interface DialogueRecord { turn_id: string; user_text: string; final_answer: string }
export interface UserConstraint {
  key: string; value: string; source_quote: string; source_turn: string; superseded_by: string | null;
}
export interface SourceBinding extends EvidenceIdentity {
  section: string; quote: string; source_start: number; source_end: number;
}
export interface ConclusionCandidate {
  id: string; need_id: string; text: string; source_turn: string; basis: "explicit" | "in_scope_inference";
  source_status: "verified" | "stale"; semantic_status: "pending"; sources: SourceBinding[];
}
export interface ReadingNote {source_turn:string;question:string;answer_excerpt:string;excerpt_truncated:boolean;paper_ids:string[];citations:string[];status:string}
export interface DomainState {
  version: 1; index_version: string; current_paper: { paper_id: string; source_turn: string } | null;
  comparison_order: string[]; comparison_dimensions: string[]; object_source_turn: string | null;
  user_constraints: UserConstraint[]; conclusions: ConclusionCandidate[];
  pending_inferences: Array<{ text: string; source_turn: string; reason: string }>;
  unresolved_questions: Array<{ need_id: string; text: string; gap: string; source_turn: string }>;
  reading_notes?:ReadingNote[];
}
const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Compare with the current trusted corpus map, never with a persisted model assertion. */
export function sourceMatches(chunk: Chunk, version: string, index: ReadonlyMap<string, EvidenceIdentity>): boolean {
  const known = index.get(chunk.chunk_id);
  return Boolean(known && chunk.index_version === version && known.index_version === version &&
    known.paper_id === chunk.paper_id && known.paragraph_id === chunk.paragraph_id &&
    known.start === chunk.start && known.end === chunk.end && typeof chunk.text === "string" &&
    codepoints(chunk.text) === chunk.end - chunk.start && hash(chunk.text) === known.text_sha256);
}

export class DomainMemory {
  readonly state: DomainState;
  constructor(indexVersion: string, restored?: DomainState) {
    this.state = restored ? structuredClone(restored) : { version: 1, index_version: indexVersion,
      current_paper: null, comparison_order: [], comparison_dimensions: [], object_source_turn: null,
      user_constraints: [], conclusions: [], pending_inferences: [], unresolved_questions: [] };
    if (this.state.version !== 1 || !Array.isArray(this.state.user_constraints) || !Array.isArray(this.state.conclusions) ||
      this.state.conclusions.some((entry) => entry.semantic_status !== "pending")) {
      throw new RuntimeFailure("INVALID_SNAPSHOT", "Memory version or semantic evidence level is invalid");
    }
  }
  activeConstraints(): UserConstraint[] { return this.state.user_constraints.filter((entry) => entry.superseded_by === null); }

  rememberAnswer(turn:string,question:string,answer:string,paperIds:readonly string[],citations:readonly string[],status:string):void{
    if(paperIds.length){
      this.state.object_source_turn=turn;
      this.state.current_paper=paperIds.length===1?{paper_id:paperIds[0],source_turn:turn}:null;
      this.state.comparison_order=paperIds.length>1?[...paperIds]:[];
      if(paperIds.length===1)this.state.comparison_dimensions=[];
    }
    const chars=Array.from(answer);
    const note:ReadingNote={source_turn:turn,question:Array.from(question).slice(0,512).join(''),answer_excerpt:chars.slice(0,1200).join(''),excerpt_truncated:chars.length>1200,paper_ids:[...paperIds],citations:[...citations],status};
    this.state.reading_notes=[...(this.state.reading_notes??[]).filter(item=>item.source_turn!==turn),note].slice(-4);
  }

  applyFrame(frame: FullFrame, turn: string): void {
    for (const update of frame.constraints) if (update.replaces && !this.activeConstraints().some((old) => old.key === update.replaces)) {
      throw new RuntimeFailure("FRAME_ERROR", `constraints.replaces: value=${update.replaces}; required an active user constraint key`);
    }
    for (const update of frame.constraints) {
      for (const old of this.activeConstraints()) if (old.key === update.key || old.key === update.replaces) old.superseded_by = turn;
      this.state.user_constraints.push({ key: update.key, value: update.value, source_quote: update.source_quote,
        source_turn: turn, superseded_by: null });
    }
    if (!frame.ambiguity && frame.ordered_targets.length) {
      this.state.object_source_turn = turn;
      this.state.current_paper = frame.ordered_targets.length === 1 ? { paper_id: frame.ordered_targets[0], source_turn: turn } : null;
      this.state.comparison_order = frame.ordered_targets.length > 1 ? [...frame.ordered_targets] : [];
      this.state.comparison_dimensions = [...frame.comparison_dimensions];
    }
  }

  applyCheck(check: R2Check, frame: FullFrame, evidence: ReadonlyMap<string, Chunk>, turn: string): void {
    this.state.unresolved_questions = check.checks.filter((need) => need.status !== "supported").map((need) => ({
      need_id: `${frame.frame_id}/${need.need_id}`, text: frame.information_needs.find((entry) => entry.need_id === need.need_id)!.text,
      gap: need.gap!, source_turn: turn }));
    for (const need of check.checks) {
      if (need.status !== "supported") continue;
      const sources = need.support_spans.map((span): SourceBinding => {
        const chunk = evidence.get(span.chunk_id)!;
        return { paper_id: chunk.paper_id, paragraph_id: chunk.paragraph_id, chunk_id: chunk.chunk_id,
          start: chunk.start, end: chunk.end, text_sha256: hash(chunk.text), index_version: chunk.index_version!,
          section: chunk.section, quote: span.quote, source_start: chunk.start + span.start, source_end: chunk.start + span.end };
      });
      const id = `${frame.frame_id}/${need.need_id}`;
      this.state.conclusions = this.state.conclusions.filter((entry) => entry.id !== id);
      this.state.conclusions.push({ id, need_id: need.need_id, text: need.finding!, source_turn: turn, basis: need.basis!,
        sources, source_status: "verified", semantic_status: "pending" });
      if (need.basis === "in_scope_inference") this.state.pending_inferences.push({ text: need.finding!, source_turn: turn, reason: "model_inference_semantics_pending" });
    }
  }

  revalidate(version: string, index: ReadonlyMap<string, EvidenceIdentity>, chunks?: ReadonlyMap<string, Chunk>): void {
    this.state.index_version = version;
    for (const candidate of this.state.conclusions) {
      const valid = candidate.sources.length > 0 && candidate.sources.every((source) => {
        const known = index.get(source.chunk_id), chunk = chunks?.get(source.chunk_id);
        if (!known || source.index_version !== version || known.index_version !== version ||
          ["paper_id", "paragraph_id", "start", "end", "text_sha256"].some((key) => source[key as keyof EvidenceIdentity] !== known[key as keyof EvidenceIdentity])) return false;
        return Boolean(chunk && sourceMatches(chunk, version, index) && source.source_start >= chunk.start && source.source_end <= chunk.end &&
          Array.from(chunk.text).slice(source.source_start - chunk.start, source.source_end - chunk.start).join("") === source.quote);
      });
      candidate.source_status = valid ? "verified" : "stale";
      if (!valid && !this.state.pending_inferences.some((entry) => entry.source_turn === candidate.source_turn && entry.text === candidate.text && entry.reason === "source_unverifiable")) {
        this.state.pending_inferences.push({ text: candidate.text, source_turn: candidate.source_turn, reason: "source_unverifiable" });
      }
    }
  }

  projection() {
    return { role: "fallible_domain_memory", index_version: this.state.index_version, current_paper: this.state.current_paper,
      comparison_order: this.state.comparison_order, comparison_dimensions: this.state.comparison_dimensions,
      user_constraints: this.activeConstraints(), conclusion_candidates: this.state.conclusions.filter((entry) => entry.source_status === "verified").slice(-24),
      pending_inferences: this.state.pending_inferences.slice(-12), unresolved_questions: this.state.unresolved_questions,
      ...(this.state.reading_notes?{reading_notes:this.state.reading_notes}:{}),
      instruction: "User constraints are user claims. Source spans are located; all model findings have pending semantics. Only separately visible source text permits citations; memory is not verified paper truth." };
  }

  summary(dialogue: readonly DialogueRecord[], useDomain: boolean): string {
    return JSON.stringify({ source: "pipaper_deterministic_compaction_v1", generation: "host_projection_no_model",
      conversation_only: this.state.reading_notes?dialogue.slice(-4).map(entry=>({turn_id:entry.turn_id,user_text:Array.from(entry.user_text).slice(0,512).join('')})):dialogue.slice(-8).map((entry) => ({ ...entry, final_answer: Array.from(entry.final_answer).slice(0, 1200).join("") })),
      ...(useDomain ? { domain_memory: this.projection() } : {}),
      evidence_rule: "Previous assistant answers and user assumptions are conversation only. Every conclusion remains semantic_status=pending. Citations require currently visible independently located source text." });
  }
}
