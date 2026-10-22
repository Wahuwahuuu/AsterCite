import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { DomainMemory, sourceMatches } from "../../agent/domain-memory.ts";
import { parseFullFrame, parseFullCheck } from "../../agent/full-stages.ts";
import type { Chunk } from "../../agent/contracts.ts";

const chunk: Chunk = { paper_id: "p1", paragraph_id: "p1:s0:p0", chunk_id: "idx:p1:s0:p0:c0",
  section: "Results", text: "A😀 reliable source.", start: 3, end: 22, index_version: "idx" };
const index = new Map([[chunk.chunk_id, { ...chunk, index_version: "idx", text_sha256: createHash("sha256").update(chunk.text).digest("hex") }]]);
const frame = (original: string, updates: unknown[] = [], targets = ["p1"]) => parseFullFrame(JSON.stringify({
  intent: targets.length === 2 ? "comparison" : "single_paper_qa", follow_up: true, candidate_papers: targets,
  ordered_targets: targets, information_needs: ["fact"], queries: [{ query: "fact", paper_ids: targets }],
  constraints: updates, comparison_dimensions: targets.length === 2 ? ["method"] : [] }), original, new Set(["p1", "p2"]));

test("latest correction supersedes only the corresponding USER constraint with both turn sources retained", () => {
  const memory = new DomainMemory("idx");
  memory.applyFrame(frame("Only English", [{ key: "language", value: "English", source_quote: "English" }]), "t1");
  memory.applyFrame(frame("Actually Dutch", [{ key: "language", value: "Dutch", source_quote: "Dutch", replaces: "language" }]), "t2");
  assert.deepEqual(memory.activeConstraints().map((x) => [x.value, x.source_turn]), [["Dutch", "t2"]]);
  assert.equal(memory.state.user_constraints[0].superseded_by, "t2");
  assert.equal(memory.state.conclusions.length, 0);
  memory.applyFrame(frame("Compare p2 with p1", [], ["p2", "p1"]), "t3");
  assert.deepEqual(memory.state.comparison_order, ["p2", "p1"]);
  memory.applyFrame(frame("Now p1"), "t4");
  assert.equal(memory.state.current_paper?.paper_id, "p1");
  assert.deepEqual(memory.state.comparison_order, []);
});

test("quote identity verifies Unicode offsets but model supported never becomes a confirmed semantic fact", () => {
  // End-start is a Unicode codepoint range, not a UTF-16 string length.
  assert.equal(Array.from(chunk.text).length, chunk.end - chunk.start);
  assert.equal(sourceMatches(chunk, "idx", index), true);
  const memory = new DomainMemory("idx"), f = frame("fact");
  const check = parseFullCheck(JSON.stringify({ checks: [{ need_id: "n1", status: "supported", basis: "explicit",
    finding: "MODEL_CLAIM", support_spans: [{ chunk_id: chunk.chunk_id, quote: "reliable" }] }], next_action: "answer" }), f, new Set(["p1"]), new Map([[chunk.chunk_id, chunk]]));
  memory.applyCheck(check, f, new Map([[chunk.chunk_id, chunk]]), "t1");
  assert.equal(memory.state.conclusions[0].semantic_status, "pending");
  assert.equal(memory.state.conclusions[0].sources[0].source_start, 6);
  const summary = memory.summary([{ turn_id: "t1", user_text: "fact", final_answer: "ANSWER_IS_NOT_A_SOURCE" }], true);
  assert.match(summary, /pending/); assert.match(summary, /conversation_only/);
  memory.revalidate("different-index", index);
  assert.equal(memory.state.conclusions[0].source_status, "stale");
  assert.equal(memory.projection().conclusion_candidates.length, 0);
  assert.ok(memory.state.pending_inferences.length > 0);
});

test("unresolved gaps remain separate and summary is entirely a projection of existing records", () => {
  const memory = new DomainMemory("idx"), f = frame("fact");
  const check = parseFullCheck(JSON.stringify({ checks: [{ need_id: "n1", status: "insufficient", gap: "condition missing" }], next_action: "refuse" }), f, new Set(["p1"]), new Map());
  memory.applyCheck(check, f, new Map(), "t1");
  assert.equal(memory.state.unresolved_questions[0].gap, "condition missing");
  assert.equal(memory.state.conclusions.length, 0);
  assert.match(memory.summary([], true), /condition missing/);
  assert.equal(sourceMatches({ ...chunk, text: "tampered" }, "idx", index), false);
});
