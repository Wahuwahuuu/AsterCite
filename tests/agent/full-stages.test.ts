import assert from "node:assert/strict";
import test from "node:test";
import { parseFullFrame, parseFullCheck } from "../../agent/full-stages.ts";
import { parseQuestionFrame } from "../../agent/p2-stages.ts";
import { parseR2Check } from "../../agent/p2-r2.ts";
import type { Chunk } from "../../agent/contracts.ts";
import { DomainMemory } from "../../agent/domain-memory.ts";

const source: Chunk = { paper_id: "p1", paragraph_id: "p1:s0:p0", chunk_id: "full:p1:s0:p0:c0-15",
  section: "Results", text: "A😀 real source.", start: 0, end: 15, index_version: "full" };
const allowed = new Set(["p1"]), evidence = new Map([[source.chunk_id, source]]);
const frame = parseQuestionFrame(JSON.stringify({ question_text: "question", candidate_papers: ["p1"], ordered_targets: ["p1"],
  information_needs: ["explain the finding"], queries: [{ query: "finding", paper_ids: ["p1"] }], ambiguity: null, user_constraints: [] }), "question", allowed);
const support = { need_id: "n1", status: "supported", basis: "explicit", finding: "finding paraphrase",
  support_spans: [{ chunk_id: source.chunk_id, quote: source.text }] };

test("insufficient checks normalize missing source lists without inventing evidence", () => {
  const response = JSON.stringify({ checks: [{ need_id: "n1", status: "insufficient", gap: "The requested condition is absent." }], next_action: "retrieve_more", next_queries: [{ query: "condition", paper_ids: ["p1"] }] });
  assert.throws(() => parseR2Check(response, frame, allowed, new Map()), /evidence_ids/);
  const normalized = parseFullCheck(response, frame, allowed, new Map());
  assert.equal(normalized.next_action, "retrieve_more");
  assert.deepEqual(normalized.checks[0].evidence_ids, []);
  assert.deepEqual(normalized.checks[0].support_spans, []);
  assert.equal(normalized.checks[0].finding, null);
});

test("supported derives only source IDs and exact Unicode offsets, permitting paraphrased findings", () => {
  const result = parseFullCheck(JSON.stringify({ checks: [support], next_action: "answer" }), frame, allowed, evidence);
  assert.deepEqual(result.checks[0].evidence_ids, [source.chunk_id]);
  assert.equal(result.checks[0].support_spans[0].end, Array.from(source.text).length);
  for (const bad of [{ ...support, support_spans: null }, { ...support, basis: undefined },
    { ...support, evidence_ids: ["fake"] }, { ...support, gap: "contradiction" }]) {
    assert.throws(() => parseFullCheck(JSON.stringify({ checks: [bad], next_action: "answer" }), frame, allowed, evidence));
  }
});

test("insufficient, conflicting and partial branches retain gaps and forbid affirmative answer", () => {
  const gap = { need_id: "n1", status: "insufficient", gap: "Missing required condition" };
  const result = parseFullCheck(JSON.stringify({ checks: [gap], next_action: "refuse" }), frame, allowed, evidence);
  assert.equal(result.checks[0].basis, null);
  assert.throws(() => parseFullCheck(JSON.stringify({ checks: [gap], next_action: "answer" }), frame, allowed, evidence));
  assert.throws(() => parseFullCheck(JSON.stringify({ checks: [{ ...gap, status: "conflicting", evidence_ids: [source.chunk_id] }], next_action: "refuse" }), frame, allowed, evidence));
  const other = { ...source, chunk_id: "second" }, both = new Map([...evidence, [other.chunk_id, other] as [string, Chunk]]);
  assert.equal(parseFullCheck(JSON.stringify({ checks: [{ ...gap, status: "conflicting", evidence_ids: [source.chunk_id, other.chunk_id] }], next_action: "refuse" }), frame, allowed, both).checks[0].status, "conflicting");
});

test("need IDs bind meaning independently of finding text and reject missing/duplicate/unknown IDs", () => {
  for (const checks of [[], [support, support], [{ ...support, need_id: "n999" }]]) {
    assert.throws(() => parseFullCheck(JSON.stringify({ checks, next_action: "answer" }), frame, allowed, evidence));
  }
});

test("new support after a gap needs an actual new exact source span and an explanation", () => {
  const prior = parseFullCheck(JSON.stringify({ checks: [{ need_id: "n1", status: "insufficient", gap: "condition" }], next_action: "refuse" }), frame, allowed, evidence);
  assert.throws(() => parseFullCheck(JSON.stringify({ checks: [support], next_action: "answer" }), frame, allowed, evidence, prior), /gap_resolution/);
  assert.equal(parseFullCheck(JSON.stringify({ checks: [{ ...support, gap_resolution: "new source supplies the condition" }], next_action: "answer" }), frame, allowed, evidence, prior).checks[0].status, "supported");
});

test("NLU host assigns question and ID, uses separate intent/follow-up and binds user constraints to actual input", () => {
  const raw = { intent: "comparison", follow_up: true, candidate_papers: ["p1"], ordered_targets: ["p1"],
    information_needs: ["methods"], queries: [{ query: "method", paper_ids: ["p1"] }],
    constraints: [{ key: "focus", value: "methods", source_quote: "methods", replaces: "focus" }], comparison_dimensions: ["methods"] };
  const parsed = parseFullFrame(JSON.stringify(raw), "Compare methods", allowed, "turn/frame");
  assert.equal(parsed.frame_id, "turn/frame"); assert.equal(parsed.question_text, "Compare methods");
  assert.equal(parsed.information_needs[0].need_id, "n1"); assert.equal(parsed.follow_up, true);
  assert.throws(() => parseFullFrame(JSON.stringify({ ...raw, constraints: [{ key: "focus", value: "x", source_quote: "made up" }] }), "Compare methods", allowed), /constraints\[0\].source_quote/);
  assert.throws(() => parseFullFrame(JSON.stringify({ ...raw, intent: "follow_up" }), "Compare methods", allowed), /intent/);
  assert.throws(() => parseFullFrame(JSON.stringify({ ...raw, queries: [] }), "Compare methods", allowed), /queries/);
});

test("actual ambiguity permits clarification with empty retrieval; illegal query papers and JSON duplicate fields fail", () => {
  const raw = { intent: "single_paper_qa", follow_up: true, ambiguity: "Which of these papers?" };
  assert.equal(parseFullFrame(JSON.stringify(raw), "What about it?", allowed).queries.length, 0);
  assert.throws(() => parseFullFrame(JSON.stringify({ ...raw, queries: [{ query: "it", paper_ids: ["outside"] }] }), "What about it?", allowed));
  assert.throws(() => parseFullCheck('{"checks":[],"checks":[],"next_action":"refuse"}', frame, allowed, evidence), /Duplicate JSON key/);
});

test("branch diagnostics name the actual field, value and violated constraint", () => {
  assert.throws(() => parseFullCheck(JSON.stringify({ checks: [{ need_id: "n1", status: "sure" }], next_action: "answer" }), frame, allowed, evidence), /checks\[0\].status.*sure.*supported/);
});

test("long exact source quotes use source bounds while short-quote parsers stay strict", () => {
  const quote = "A" + "b".repeat(250) + "😀end";
  const chunk = { ...source, text: quote, end: Array.from(quote).length };
  const visible = new Map([[chunk.chunk_id, chunk]]);
  const response = { checks: [{ ...support, support_spans: [{ chunk_id: chunk.chunk_id, quote }] }], next_action: "answer" };
  const parsed = parseFullCheck(JSON.stringify(response), frame, allowed, visible);
  assert.equal(parsed.checks[0].support_spans[0].end, Array.from(quote).length);
  assert.equal(parsed.checks[0].gap_resolution, null);
  assert.throws(() => parseR2Check(JSON.stringify({ checks: [{ ...response.checks[0], gap: null, evidence_ids: [chunk.chunk_id], gap_resolution: null }], next_action: "answer", next_queries: [] }), frame, allowed, visible), /span source\/length/);
  assert.throws(() => parseFullCheck(JSON.stringify(response), frame, allowed, new Map()), /actually visible/);
});

test("full support bounds count Unicode codepoints and remain capped at the actual 2000-codepoint source window",()=> {
  const quote="😀".repeat(1996)+"|end",chunk={...source,text:quote,chunk_id:"full-window",end:2000};
  const check={checks:[{...support,support_spans:[{chunk_id:chunk.chunk_id,quote}]}],next_action:"answer"};
  assert.equal(parseFullCheck(JSON.stringify(check),frame,allowed,new Map([[chunk.chunk_id,chunk]])).checks[0].support_spans[0].end,2000);
  const longer="😀"+quote,bad={...chunk,text:longer,end:2001};
  assert.throws(()=>parseFullCheck(JSON.stringify({checks:[{...support,support_spans:[{chunk_id:chunk.chunk_id,quote:longer}]}],next_action:"answer"}),frame,allowed,new Map([[chunk.chunk_id,bad]])),/quote.*2000/);
});

test("inherited preferences require matching active constraints and actual user history", () => {
  const memory = new DomainMemory("fixture-index");
  const raw = { intent: "single_paper_qa", follow_up: false, candidate_papers: ["p1"], ordered_targets: ["p1"], information_needs: ["method"], queries: [{ query: "method", paper_ids: ["p1"] }], constraints: [{ key: "answer_language", value: "English", source_quote: "English" }], comparison_dimensions: [] };
  memory.applyFrame(parseFullFrame(JSON.stringify(raw), "Explain the method in English", allowed, "first/frame"), "first");
  const context = { active_constraints: memory.activeConstraints(), user_history: [{ turn_id: "first", user_text: "Explain the method in English", final_answer: "" }] };
  const followUp = JSON.stringify({ ...raw, follow_up: true });
  const inherited = parseFullFrame(followUp, "Explain its limitations", allowed, "second/frame", context);
  assert.deepEqual(inherited.constraints, []);
  assert.equal(inherited.inherited_constraints?.[0].source_turn, "first");
  memory.applyFrame(inherited, "second");
  assert.equal(memory.activeConstraints().length, 1);
  assert.throws(() => parseFullFrame(followUp, "Explain its limitations", allowed, "missing/frame", { ...context, user_history: [] }), /source_quote/);
  const corrected = { ...raw, constraints: [{ key: "answer_language", value: "Chinese", source_quote: "Chinese", replaces: "answer_language" }] };
  memory.applyFrame(parseFullFrame(JSON.stringify(corrected), "Please answer in Chinese", allowed, "third/frame", context), "third");
  assert.equal(memory.activeConstraints()[0].value, "Chinese");
  assert.equal(memory.state.user_constraints[0].superseded_by, "third");
});
