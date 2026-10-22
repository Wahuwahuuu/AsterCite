import assert from "node:assert/strict";
import test from "node:test";
import { DomainMemory } from "../../agent/domain-memory.ts";
import { parseQuestionPreparation, rawQuestionFrame } from "../../agent/question-preparation.ts";

const papers = [{ paper_id: "p1", title: "Encoder Study", abstract: "catalog only" }, { paper_id: "p2", title: "Attention Study", abstract: "catalog only" }];
const context = { original: "比较 p2 和 p1 的编码器，用中文回答", allowed: new Set(["p1", "p2"]), publicPapers: papers, frameId: "turn/preparation", history: [], activeConstraints: [] };
const prepared = { intent: "compare", targets: ["p2", "p1"], rewrite: "Compare the encoders of p2 and p1", queries: ["encoder architecture"], constraints: [{ key: "answer_language", value: "中文", source_quote: "用中文回答" }] };

test("light preparation assigns scope and IDs, preserving original question and comparison order", () => {
  const value = parseQuestionPreparation(JSON.stringify(prepared), context);
  assert.equal(value.frame.frame_id, "turn/preparation");
  assert.equal(value.frame.question_text, context.original);
  assert.equal(value.frame.intent, "comparison");
  assert.deepEqual(value.frame.ordered_targets, ["p2", "p1"]);
  assert.deepEqual(value.frame.queries, [{ query: "encoder architecture", paper_ids: ["p2", "p1"] }]);
  assert.deepEqual(value.frame.information_needs.map(need => need.need_id), ["n1"]);
  assert.match(value.frame.information_needs[0].text, /complete original_question/);
  assert.equal(value.rewrite, prepared.rewrite);
});

test("single fence and a declared preparation wrapper are accepted; unknown intent stays factual", () => {
  const value = parseQuestionPreparation("```json\n" + JSON.stringify({ preparation: { ...prepared, intent: "unknown" } }) + "\n```", context);
  assert.equal(value.frame.intent, "single_paper_qa");
  assert.ok(value.warnings.includes("unknown_intent_defaulted_to_answer"));
  assert.equal(value.wrapper, "preparation");
});

test("optional output fields have deterministic defaults without inventing an answer", () => {
  const value = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: ["p1"] }), { ...context, original: "What is p1's encoder?" });
  assert.equal(value.rewrite, "What is p1's encoder?");
  assert.deepEqual(value.frame.constraints, []);
  assert.deepEqual(value.frame.queries, [{ query: "What is p1's encoder?", paper_ids: ["p1"] }]);
  assert.ok(value.warnings.includes("rewrite_defaulted_to_original"));
});

test("scope violations, invented constraint quotes, duplicate JSON keys and answer envelopes require fallback", () => {
  for (const text of [JSON.stringify({ ...prepared, targets: ["p3"] }), JSON.stringify({ ...prepared, constraints: [{ key: "language", value: "English", source_quote: "English" }] }),
    '{"intent":"answer","intent":"compare"}', JSON.stringify({ status: "answer", answer: "previous final response" })]) {
    assert.throws(() => parseQuestionPreparation(text, context), error => (error as { code?: string }).code === "PREPARATION_ERROR");
  }
});

test("explicit catalog objects fill missing model targets and prevent bogus ambiguity", () => {
  const value = parseQuestionPreparation(JSON.stringify({ ...prepared, targets: [], clarification: { question: "Which paper?", reference_quote: "p2" } }), context);
  assert.deepEqual(value.frame.ordered_targets, ["p2", "p1"]);
  assert.equal(value.frame.ambiguity, null);
  assert.ok(value.warnings.includes("explicit_targets_used"));
  assert.ok(value.warnings.includes("clarification_ignored_for_resolved_object"));
});

test("host catalog matching does not reintroduce an explicitly excluded paper", () => {
  const value = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: ["p2"], rewrite: "Describe p2's encoder", queries: ["encoder"] }), { ...context, original: "不要使用 p1，只回答 p2 的编码器" });
  assert.deepEqual(value.frame.ordered_targets, ["p2"]);
  assert.deepEqual(value.frame.queries[0].paper_ids, ["p2"]);
});

test("genuine missing antecedent asks a bounded question and avoids retrieval", () => {
  const value = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: [], rewrite: "它的编码器是什么？", queries: [], clarification: { question: "你指的是哪篇论文？", reference_quote: "它" } }), { ...context, original: "它的编码器是什么？" });
  assert.equal(value.frame.ambiguity, "你指的是哪篇论文？");
  assert.deepEqual(value.frame.queries, []);
});

test("a missing target in a large corpus enters discovery rather than selecting the first papers", () => {
  const value = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: [], rewrite: "Which encoder approach is described?", queries: ["encoder approach"] }), { ...context, original: "Which encoder approach is described?", allowed: new Set(["p1", "p2", "p3", "p4", "p5"]) });
  assert.equal(value.routing, "autonomous_discovery");
  assert.deepEqual(value.frame.ordered_targets, []);
  assert.deepEqual(value.frame.queries, []);
});

test("pronoun interpretation may use real history while same-key corrections preserve provenance", () => {
  const memory = new DomainMemory("index");
  const first = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: ["p1"], rewrite: "p1 encoder", constraints: [{ key: "language", value: "English", source_quote: "English" }] }), { ...context, original: "Tell me about p1 in English" });
  memory.applyFrame(first.frame, "first");
  const secondContext = { ...context, original: "改用中文回答它的编码器", history: [{ turn_id: "first", user_text: "Tell me about p1 in English", final_answer: "An encoder description." }], activeConstraints: memory.activeConstraints() };
  const second = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: ["p1"], rewrite: "Describe p1's encoder in Chinese", constraints: [{ key: "language", value: "Chinese", source_quote: "改用中文" }] }), secondContext);
  assert.equal(second.frame.follow_up, true);
  memory.applyFrame(second.frame, "second");
  assert.equal(memory.state.current_paper?.paper_id, "p1");
  assert.equal(memory.activeConstraints()[0].source_turn, "second");
  assert.equal(memory.state.user_constraints[0].superseded_by, "second");
});

test("repeated inherited constraints retain their original turn, while unanchored repetitions fail", () => {
  const old = { key: "language", value: "English", source_quote: "English", source_turn: "first", superseded_by: null };
  const prior = { turn_id: "first", user_text: "Answer in English", final_answer: "Done" };
  const input = JSON.stringify({ intent: "answer", targets: ["p1"], constraints: [{ key: "language", value: "English", source_quote: "English" }] });
  const value = parseQuestionPreparation(input, { ...context, original: "What about its encoder?", activeConstraints: [old], history: [prior] });
  assert.deepEqual(value.frame.constraints, []);
  assert.equal(value.frame.inherited_constraints?.[0].source_turn, "first");
  assert.throws(() => parseQuestionPreparation(input, { ...context, original: "What about its encoder?", activeConstraints: [old], history: [] }), /source_quote/);
});

test("host whole-question need remains when the model decomposes selected attributes", () => {
  const value = parseQuestionPreparation(JSON.stringify({ ...prepared, needs: ["encoder type", "training conditions"] }), context);
  assert.deepEqual(value.frame.information_needs.map(need => need.need_id), ["n1", "n2", "n3"]);
  assert.match(value.frame.information_needs[0].text, /every object, fact, condition/);
  assert.equal(rawQuestionFrame(context.original, context.frameId).question_text, context.original);
});

test("omitted comparison dimensions retain state for the same objects, and reset on an object switch", () => {
  const priorObjects = { targets: ["p1", "p2"], comparison_dimensions: ["training conditions"] };
  const followUp = parseQuestionPreparation(JSON.stringify(prepared), { ...context, priorObjects });
  assert.deepEqual(followUp.frame.comparison_dimensions, ["training conditions"]);
  const changed = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: ["p1"], rewrite: "p1 encoder" }), { ...context, original: "Now p1 encoder", priorObjects });
  assert.deepEqual(changed.frame.comparison_dimensions, []);
});

test("exact catalog ID detection handles adjacent Chinese text and avoids ID-prefix confusion", () => {
  const value = parseQuestionPreparation(JSON.stringify({ intent: "answer", targets: [], rewrite: "p1 encoder" }), { ...context, original: "p10不是这里的对象，请说p1的编码器" });
  assert.deepEqual(value.frame.ordered_targets, ["p1"]);
});
