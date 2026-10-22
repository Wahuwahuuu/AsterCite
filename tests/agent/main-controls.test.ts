import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage as reply, fauxToolCall as call } from "@earendil-works/pi-ai";
import { mainFixture, preparation, supported, final, SOURCE_IDS } from "./main-fixture.ts";
import { parseRuntimeControls, wrapSnapshot, unwrapSnapshot, type RuntimeControls } from "../../agent/main-controls.ts";

const controls = (extra: Partial<RuntimeControls> = {}): RuntimeControls => ({ arm: "C", reflect: true, compaction: "off", reliability: "baseline", implementation_id: "1".repeat(64), ...extra });

test("controls require exact scalar types without coercing arrays or objects", () => {
  const valid = controls();
  for (const key of ["arm", "compaction", "reliability", "implementation_id"] as const) {
    assert.throws(() => parseRuntimeControls({ ...valid, [key]: [valid[key]] }), /Controls require/);
    assert.throws(() => parseRuntimeControls({ ...valid, [key]: { toString: () => valid[key] } }), /Controls require/);
  }
  assert.throws(() => parseRuntimeControls({ ...valid, reflect: "true" }), /Controls require/);
  assert.deepEqual(parseRuntimeControls(valid), valid);
});

test("C Reflect off keeps preparation, Memory and final source validation with no Check or supplement", async () => {
  const f = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify(final))], [[0]], { controls: controls({ reflect: false }), maxRequests: 2 });
  try {
    const result = await f.harness.runTurn("p1 fact", ["p1"], "control/off");
    assert.equal(result.status, "completed", result.error ?? "");
    assert.deepEqual(result.requests.map(q => q.stage), ["question_preparation", "generate"]);
    assert.equal(f.calls.length, 1);
    assert.equal(result.pipeline_trace?.stages.find(s => s.stage === "Reflect")?.status, "skipped");
    assert.equal(f.harness.memory.state.current_paper?.paper_id, "p1");
    assert.equal(f.harness.snapshot().state.dialogue.length, 1);
    assert.equal(result.runtime_controls.reflect, false);
  } finally { f.harness.dispose(); }
  const bad = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify({ status: "answer", answer: "Unsupported [cite:invisible]" }))], [[0]], { controls: controls({ reflect: false }), maxRequests: 2 });
  try { assert.equal((await bad.harness.runTurn("p1 fact", ["p1"], "control/invalid")).failure_code, "INVALID_CITATION"); }
  finally { bad.harness.dispose(); }
});

test("A remains autonomous, without preparation or Reflect requests", async () => {
  const f = await mainFixture([reply([call("retrieve_chunks", { query: "fact", paper_ids: ["p1"] })], { stopReason: "toolUse" }), reply(JSON.stringify(final))], [[0]], {}, "A");
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "control/A");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.runtime_controls.arm, "A");
    assert.ok(!r.requests.some(q => q.phase === "auxiliary"));
    assert.equal(r.requests.length, 2);
  } finally { f.harness.dispose(); }
});

test("native compression changes actual Pi context and recovery keeps binding, source checks and settings", async () => {
  const f = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify(supported)), reply(JSON.stringify(final)),
    context => { assert.match(JSON.stringify(context), /native_compaction_summary/); return reply(JSON.stringify(preparation)); }, reply(JSON.stringify(supported)), reply(JSON.stringify(final))], [[0]], { controls: controls({ compaction: "native" }) });
  let snapshot;
  try {
    assert.equal((await f.harness.runTurn("p1 fact", ["p1"], "control/c1")).status, "completed");
    const before = f.harness.settings.getCompactionSettings();
    f.harness.requestCompaction();
    const r = await f.harness.runTurn("And the same fact?", ["p1"], "control/c2");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.ok(r.compaction_events.some(e => e.type === "end" && e.reason === "manual"));
    assert.deepEqual(f.harness.settings.getCompactionSettings(), before);
    snapshot = f.harness.snapshot();
    assert.ok(snapshot.state.entries.some(e => e.type === "compaction"));
    assert.equal(f.faux.state.callCount, 6, "host summary adds no model request");
  } finally { f.harness.dispose(); }
  const resumed = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify(supported)), reply(JSON.stringify(final))], [[0]], { controls: controls({ compaction: "native" }), controlledSnapshot: snapshot });
  try {
    const r = await resumed.harness.runTurn("Continue on it", ["p1"], "control/c3");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.session_recovery?.snapshot_revalidated, true);
    assert.equal(resumed.harness.session.autoCompactionEnabled, true);
    assert.ok(resumed.harness.memory.state.conclusions.every(c => c.semantic_status === "pending"));
    assert.ok(resumed.harness.session.messages.some(m => m.role === "compactionSummary"));
  } finally { resumed.harness.dispose(); }
});

test("off uses real Pi settings, rejects forced compaction and remains off after restore", async () => {
  const f = await mainFixture([reply(JSON.stringify(preparation)), reply(JSON.stringify(supported)), reply(JSON.stringify(final))]);
  let snapshot;
  try {
    assert.equal(f.harness.session.autoCompactionEnabled, false);
    assert.throws(() => f.harness.requestCompaction(), /native compression/);
    await f.harness.runTurn("p1 fact", ["p1"], "control/off1");
    snapshot = f.harness.snapshot();
  } finally { f.harness.dispose(); }
  const resumed = await mainFixture([], [[0]], { controlledSnapshot: snapshot });
  try { assert.equal(resumed.harness.session.autoCompactionEnabled, false); }
  finally { resumed.harness.dispose(); }
});

test("snapshot cannot cross component, implementation, index or repair identities or altered state", async () => {
  const f = await mainFixture([]);
  try {
    const snapshot = f.harness.snapshot();
    for (const delta of [{ reflect: false }, { compaction: "native" as const }, { reliability: "candidate" as const }, { implementation_id: "2".repeat(64) }]) {
      assert.throws(() => unwrapSnapshot(snapshot, controls(delta), snapshot.index_version), /binding differs/);
    }
    assert.throws(() => unwrapSnapshot(snapshot, controls(), "other-index"), /binding differs/);
    const changed = structuredClone(snapshot); changed.state.dialogue.push({ turn_id: "fake", user_text: "fake", final_answer: "fake" });
    assert.throws(() => unwrapSnapshot(changed, controls(), snapshot.index_version), /binding differs/);
    assert.deepEqual(unwrapSnapshot(wrapSnapshot(snapshot.state, controls()), controls(), snapshot.index_version), snapshot.state);
    assert.throws(() => parseRuntimeControls(controls({ arm: "A" })), /A has no Reflect/);
    await assert.rejects(mainFixture([], [[0]], { snapshot: snapshot.state }), /raw snapshot/);
  } finally { f.harness.dispose(); }
});

test("Reflect off fallback still closes only after actual retrieval, with shared bounded requests", async () => {
  const f = await mainFixture([reply("bad prep"), reply([call("retrieve_chunks", { query: "original", paper_ids: ["p1"] })], { stopReason: "toolUse" }), reply(JSON.stringify(final))], [[0]], { controls: controls({ reflect: false }) });
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "control/fallback");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.question_preparation.status, "fallback");
    assert.ok(!r.requests.some(q => q.stage?.startsWith("evidence_check")));
    assert.ok(r.citation_validity.cited_ids.includes(SOURCE_IDS[0]));
  } finally { f.harness.dispose(); }
});
