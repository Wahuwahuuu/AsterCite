import test from "node:test";
import assert from "node:assert/strict";
import { parseFinalAnswer } from "../../agent/final-answer.ts";
import type { Chunk } from "../../agent/contracts.ts";
const chunk = { chunk_id: "idx:p:s0:p0:c0", text: "A😀 original text." } as Chunk;
const sources = new Map([[chunk.chunk_id, chunk]]);
const answer = `Source paraphrase [cite:${chunk.chunk_id}]`;

test("final branches accept paraphrase but separately require exact source span declarations", () => {
  assert.equal(parseFinalAnswer(JSON.stringify({ status: "answer", answer }), sources, true, false).status, "answer");
  const quoted = parseFinalAnswer(JSON.stringify({ status: "partial", answer: `A😀 [cite:${chunk.chunk_id}]`, exact_quotes: [{ chunk_id: chunk.chunk_id, quote: "A😀" }] }), sources, false, false);
  assert.equal(quoted.exact_quotes[0].end, 2);
  assert.throws(() => parseFinalAnswer(JSON.stringify({ status: "answer", answer }), sources, false, false), /unresolved/);
  assert.throws(() => parseFinalAnswer(JSON.stringify({ status: "partial", answer }), sources, true, true), /ambiguity/);
  assert.throws(() => parseFinalAnswer(JSON.stringify({ status: "answer", answer, exact_quotes: [{ chunk_id: chunk.chunk_id, quote: "edited" }] }), sources, true, false), /source span/);
});

test("quote declarations must appear in both the answer and its visible source", () => {
  const raw = { status: "answer", answer, exact_quotes: [{ chunk_id: chunk.chunk_id, quote: "A😀" }] };
  assert.throws(() => parseFinalAnswer(JSON.stringify(raw), sources, true, false), /appear verbatim in answer/);
  assert.equal(parseFinalAnswer(JSON.stringify({ ...raw, exact_quotes: [] }), sources, true, false).answer, answer);
  const quoted = `A😀 [cite:${chunk.chunk_id}]`;
  assert.equal(parseFinalAnswer(JSON.stringify({ ...raw, answer: quoted }), sources, true, false).exact_quotes[0].end, 2);
});

test("quote diagnostics distinguish absent answer text, non-source text, duplicate source and invisible ID",()=> {
  const value=(quote:string,answerText=answer)=>JSON.stringify({status:"answer",answer:answerText,exact_quotes:[{chunk_id:chunk.chunk_id,quote}]});
  assert.throws(()=>parseFinalAnswer(value("A😀"),sources,true,false),/final\.exact_quotes\[0\]\.quote: value=.*appear verbatim in answer/);
  assert.throws(()=>parseFinalAnswer(value("invented",`invented [cite:${chunk.chunk_id}]`),sources,true,false),/unique exact contiguous substring/);
  const repeated=new Map([[chunk.chunk_id,{...chunk,text:"twice twice"}]]);
  assert.throws(()=>parseFinalAnswer(value("twice",`twice [cite:${chunk.chunk_id}]`),repeated,true,false),/occurs 2 or more times/);
  assert.throws(()=>parseFinalAnswer(value("A😀"),new Map(),true,false),/not currently visible/);
});

test("business insufficiency is valid while invalid citation and schema retain distinct engineering errors", () => {
  for (const status of ["refusal", "clarification"]) assert.equal(parseFinalAnswer(JSON.stringify({ status, answer: "Bounded lack of evidence or object question." }), new Map(), false, status === "clarification").status, status);
  assert.throws(() => parseFinalAnswer(JSON.stringify({ status: "answer", answer: "unsupported [cite:fake]" }), sources, true, false), /not currently visible/);
  assert.throws(() => parseFinalAnswer("not JSON", sources, true, false), /ANSWER_SCHEMA_ERROR|Unexpected token/);
});

test("catalog/session declarations do not bypass a known factual frame or legal source identity", () => {
  const value = JSON.stringify({ status: "answer", answer_kind: "catalog", answer: "Public paper p1 is in the catalog." });
  assert.equal(parseFinalAnswer(value, new Map(), true, false, "catalog").answer_kind, "catalog");
  assert.throws(() => parseFinalAnswer(value, sources, true, false, "paper_fact"), /answer_kind/);
  assert.throws(() => parseFinalAnswer(JSON.stringify({ status: "answer", answer_kind: "session_control", answer: "confirmed [cite:fake]" }), new Map(), true, false), /not currently visible/);
});
