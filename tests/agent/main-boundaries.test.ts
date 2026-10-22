import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage as reply, fauxToolCall as call, fauxThinking, fauxText } from "@earendil-works/pi-ai";
import { mainFixture, preparation, supported, final } from "./main-fixture.ts";
import type { RuntimeControls } from "../../agent/main-controls.ts";

const controls: RuntimeControls = { arm: "C", reflect: true, compaction: "off", reliability: "candidate", implementation_id: "1".repeat(64) };

test("candidate fallback, failed tools and closing share twelve requests and two searches", async () => {
  const searches = Array.from({ length: 9 }, (_, i) => reply([call("search_papers", { query: "catalog", limit: 5 }, { id: `search-${i}` })], { stopReason: "toolUse" }));
  const check = { checks: [{ need_id: "n1", status: "insufficient", gap: "No source excerpt" }], next_action: "refuse" };
  const f = await mainFixture([reply("wrong preparation"), ...searches, reply(JSON.stringify(check)), reply(JSON.stringify({ status: "refusal", answer: "No sufficient source was obtained." }))], [[0]], { controls });
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "bound/searches");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(r.requests.length, 12);
    assert.equal(f.faux.state.callCount, 12);
    assert.equal(f.calls.filter(c => c.method === "search_papers").length, 2);
    assert.ok(r.tools.some(t => t.status === "budget_rejected"));
  } finally { f.harness.dispose(); }
});

test("initial and supplemental retrieval share four executions without a second supplement", async () => {
  const gap = { checks: [{ need_id: "n1", status: "insufficient", gap: "Missing condition" }], next_action: "retrieve_more", next_queries: [{ query: "third", paper_ids: ["p1"] }, { query: "fourth", paper_ids: ["p1"] }] };
  const f = await mainFixture([reply(JSON.stringify({ ...preparation, queries: ["first", "second"] })), reply(JSON.stringify(gap)), reply(JSON.stringify(gap)), reply(JSON.stringify({ status: "refusal", answer: "These excerpts do not supply the condition." }))], [[0], [0], [1], [1]], { controls });
  try {
    const r = await f.harness.runTurn("p1 condition", ["p1"], "bound/retrieval");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.equal(f.calls.length, 4);
    assert.equal(r.requests.length, 4);
    assert.equal(r.retrieval_batches?.filter(b => b.stage === "retrieve_more").length, 1);
    assert.equal(r.business_status, "refusal");
  } finally { f.harness.dispose(); }
});

test("candidate adaptations and snapshots omit hidden thinking and redact secrets", async () => {
  const secret = "ONLY_A_FAKE_TEST_SECRET", hidden = "PRIVATE_THINKING_SENTINEL";
  const f = await mainFixture([reply([fauxThinking(hidden), fauxText(JSON.stringify(preparation))]), reply(JSON.stringify(supported)),
    reply([fauxThinking(hidden), fauxText(`${secret}\n${JSON.stringify(final)}`)])], [[0]], { controls, secrets: [secret] });
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "bound/visibility");
    assert.equal(r.status, "completed", r.error ?? "");
    assert.ok(r.reliability_adaptations.length);
    const data = JSON.stringify([r, f.harness.snapshot()]);
    assert.ok(!data.includes(secret));
    assert.ok(!data.includes(hidden));
  } finally { f.harness.dispose(); }
});

test("provider error and cancellation remain retained failures without another preparation attempt", async () => {
  const f = await mainFixture([reply("", { stopReason: "error", errorMessage: "Controlled failure" })], [[0]], { controls });
  try {
    const r = await f.harness.runTurn("p1 fact", ["p1"], "bound/provider");
    assert.equal(r.status, "error");
    assert.equal(f.faux.state.callCount, 1);
    assert.equal(f.calls.length, 0);
  } finally { f.harness.dispose(); }
  const c = await mainFixture([], [[0]], { controls });
  try {
    const abort = new AbortController(); abort.abort();
    const r = await c.harness.runTurn("p1 fact", ["p1"], "bound/cancel", abort.signal);
    assert.equal(r.failure_code, "CANCELLED");
    assert.equal(c.faux.state.callCount, 0);
  } finally { c.harness.dispose(); }
});
