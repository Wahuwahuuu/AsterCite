import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { mainFixture, preparation, supported, final, SOURCE_IDS } from "./main-fixture.ts";
import { decodeCandidateJSON, parseCandidateFinal, parseCandidateCheck } from "../../agent/main-reliability-v2.ts";
import { rawQuestionFrame } from "../../agent/question-preparation.ts";
import type { RuntimeControls } from "../../agent/main-controls.ts";

const controls = (extra: Partial<RuntimeControls> = {}): RuntimeControls => ({ arm: "C", reflect: true, compaction: "off", reliability: "candidate", implementation_id: "1".repeat(64), ...extra });

test("bounded JSON recovery preserves decoded Unicode/control characters and rejects duplicate or ambiguous objects", () => {
  const input = 'Draft text\n{"answer":"a😀\nb\tc","nested":{"x":1}}', events: string[] = [];
  assert.deepEqual(JSON.parse(decodeCandidateJSON(input, k => events.push(k))), { answer: "a😀\nb\tc", nested: { x: 1 } });
  assert.deepEqual(events, ["terminal_json_envelope_extracted", "json_string_control_characters_escaped"]);
  for (const invalid of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"a":1,"a":2}}', '{} {}', '{"x":"unfinished', '{"x":1} trailing', '[{"x":1}]', '{"x":"\\q"}', 'Plain answer without a model-provided envelope']) assert.throws(() => decodeCandidateJSON(invalid));
  assert.deepEqual(JSON.parse(decodeCandidateJSON('```json\n{"a":[{"x":1},{"x":2}]}\n```')), { a: [{ x: 1 }, { x: 2 }] });
  assert.throws(() => decodeCandidateJSON("x".repeat(16001)), /bound/);
});



test("candidate ignores only irrelevant gap metadata, preserving original text and requiring real source", async () => {
  const bad = { ...supported, checks: [{ ...supported.checks[0], gap_resolution: "x".repeat(900) }] };
  const f = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify(bad)), reply(JSON.stringify(final))], [[0]], { controls: controls() });
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "repair/gap");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.requests.length, 3);
    assert.ok(r.reliability_adaptations.some(a => a.kind === "unused_gap_resolution_ignored" && a.original_response === JSON.stringify(bad)));
    assert.ok(f.harness.memory.state.conclusions.every(c => c.semantic_status === "pending"));
    const evidence = new Map(f.chunks.map(c => [c.chunk_id, c])), frame = rawQuestionFrame("p1 fact", "gap/frame");
    const previous = parseCandidateCheck(JSON.stringify({ checks: [{ need_id: "n1", status: "insufficient", gap: "missing fact" }], next_action: "refuse" }), frame, new Set(["p1"]), evidence);
    assert.throws(() => parseCandidateCheck(JSON.stringify(bad), frame, new Set(["p1"]), evidence, previous), /gap_resolution/);
    assert.throws(() => parseCandidateCheck(JSON.stringify(supported), frame, new Set(["p1"]), evidence, previous), /gap_resolution/);
  } finally { f.harness.dispose(); }
});

test("wrong nonfactual routing falls back once to the original question and still retrieves/Reflects", async () => {
  const f = await mainFixture([reply(JSON.stringify({ ...preparation, intent: "find_papers" })),
    reply([call("retrieve_chunks", { query: "original", paper_ids: ["p1"] })], { stopReason: "toolUse" }), reply(JSON.stringify(supported)), reply(JSON.stringify(final))], [[0]], { controls: controls() });
  try {
    const r = await f.harness.runTurn("Which fact does p1 report?", ["p1"], "repair/route");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.question_preparation.status, "fallback");
    assert.ok(r.requests.some(q => q.stage === "evidence_check"));
    assert.equal(f.calls.length, 1);
    assert.ok(r.reliability_adaptations.some(a => a.kind === "catalog_query_conflict_original_question_fallback"));
  } finally { f.harness.dispose(); }
});

test("candidate final formatting applies equally to A and keeps source citations", async () => {
  const response = 'Visible draft\n' + JSON.stringify(final).replace("The source supports", "The source\nsupports");
  const f = await mainFixture([reply([call("retrieve_chunks", { query: "fact", paper_ids: ["p1"] })], { stopReason: "toolUse" }), reply(response)], [[0]], { controls: controls({ arm: "A", reflect: false }), maxRequests: 2 }, "A");
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "repair/A");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.requests.length, 2);
    assert.ok(r.final_answer.includes("\n"));
    assert.deepEqual(r.citation_validity.cited_ids, [SOURCE_IDS[0]]);
    assert.equal(r.reliability_adaptations.length, 2);
  } finally { f.harness.dispose(); }
});

test("source-proof escape restoration remains exact; final unused quotes and invented spans stay invalid", async () => {
  const f = await mainFixture([]);
  try {
    const c = { ...f.chunks[0], text: 'An exact "quoted" phrase.' }, evidence = new Map([[c.chunk_id, c]]), frame = rawQuestionFrame("p1 fact", "quote/frame");
    const check = { ...supported, checks: [{ ...supported.checks[0], support_spans: [{ chunk_id: c.chunk_id, quote: 'An exact \\"quoted\\" phrase.' }] }] };
    const parsed = parseCandidateCheck(JSON.stringify(check), frame, new Set(["p1"]), evidence);
    assert.equal(parsed.checks[0].support_spans[0].quote, c.text);
    const invented = { ...supported, checks: [{ ...supported.checks[0], support_spans: [{ chunk_id: c.chunk_id, quote: "An invented phrase." }] }] };
    assert.throws(() => parseCandidateCheck(JSON.stringify(invented), frame, new Set(["p1"]), evidence), /exact substring/);
    assert.throws(() => parseCandidateFinal(JSON.stringify({ ...final, exact_quotes: [{ chunk_id: c.chunk_id, quote: c.text }] }), evidence, true, false), /appear verbatim/);
    assert.throws(() => parseCandidateFinal(JSON.stringify({ status: "answer", answer: "No source [cite:invented]" }), evidence, true, false), /currently visible/);
    const repeated = { ...c, text: `${c.text} ${c.text}` };
    assert.throws(() => parseCandidateCheck(JSON.stringify({ ...check, checks: [{ ...check.checks[0], support_spans: [{ chunk_id: c.chunk_id, quote: c.text }] }] }), frame, new Set(["p1"]), new Map([[c.chunk_id, repeated]])), /unique exact/);
  } finally { f.harness.dispose(); }
});
