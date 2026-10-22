import type { DomainState } from "./domain-memory.ts";
import type { RequestRecord, ToolRecord, TurnRecord, ObservedUsage } from "./ledger.ts";

export type PipelineStage = "Guardrails" | "NLU" | "Retrieve" | "Rerank" | "Reflect" | "Generate" | "Memory";
export interface StageTrace {
  stage_id: string; stage: PipelineStage; pass: number; status: "completed" | "skipped" | "error";
  reason: string | null; input: unknown; output: unknown; elapsed_ms: number | null;
  timing_basis: string; request_ids: string[]; tool_attempt_ids: string[];
  visible_evidence: unknown[]; usage: { known: ObservedUsage; missing_requests: number };
}
export interface PipelineTrace {
  user_turn_id: string; input: { user_text: string; scope: string[] }; engineering_status: TurnRecord["status"];
  business_status: TurnRecord["business_status"]; stages: StageTrace[]; elapsed_ms: number;
  state_changes: Array<{ field: string; before: unknown; after: unknown }>;
  preserved_failures: unknown[]; semantic_verdict: "not_evaluated";
}
function usage(requests: RequestRecord[]): StageTrace["usage"] {
  const keys = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"] as const;
  const known = Object.fromEntries(keys.map((key) => {
    const reported = requests.map((request) => request.usage[key]).filter((count): count is number => count !== null);
    return [key, reported.length ? reported.reduce((a, b) => a + b, 0) : null];
  })) as unknown as ObservedUsage;
  return { known, missing_requests: requests.filter((request) => request.usage_status === "unknown").length };
}
export function pipelineTrace(record: TurnRecord, input: string, before: DomainState, after: DomainState): PipelineTrace {
  const stages: StageTrace[] = [];
  const generationIds = new Set([record.final_request_id, ...(record.generation_failures ?? []).map(failure => failure.request_id)].filter((id): id is string => Boolean(id)));
  const isGeneration = (request: RequestRecord) => generationIds.has(request.request_id) || ["generate", "closing", "citation_repair"].includes(request.stage ?? "");
  const add = (stage: PipelineStage, pass: number, requests: RequestRecord[], tools: ToolRecord[], incoming: unknown,
    outgoing: unknown, reason: string | null = null, timing?: number | null) => {
    const status = reason ? "skipped" : requests.some((item) => item.status !== "completed") || tools.some((item) => item.status === "error") ? "error" : "completed";
    stages.push({ stage_id: `${record.user_turn_id}/${stage.toLowerCase()}/${pass}`, stage, pass, status, reason,
      input: incoming, output: outgoing, request_ids: requests.map((item) => item.request_id), tool_attempt_ids: tools.map((item) => item.tool_attempt_id),
      elapsed_ms: timing === undefined ? requests.reduce((a, b) => a + b.elapsed_ms, 0) + tools.reduce((a, b) => a + b.elapsed_ms, 0) : timing,
      timing_basis: stage === "Rerank" ? "inside_worker; isolated latency unavailable unless worker reports it" : "sum_of_actual_requests_and_tool_executions; nested work may overlap",
      visible_evidence: [...requests.flatMap((request) => request.tool_context.flatMap((proof) => proof.visible_chunks)), ...tools.flatMap((tool) => tool.visible_chunks)], usage: usage(requests) });
  };
  add("Guardrails", 1, [], [], { user_text: input, scope: record.declared_scope, allowed_tools: ["search_papers", "retrieve_chunks"] }, { input_scope_and_length_validated: true }, null, null);
  const nlu = record.requests.filter((item) => item.stage?.startsWith("question_frame"));
  const frame = record.stages?.findLast((item) => item.stage.startsWith("question_frame") && item.status === "completed")?.value;
  add("NLU", 1, nlu, [], { user_text: input, prior_domain_state: before }, frame ?? null, nlu.length ? null : "NLU disabled; autonomous interpretation uses the actual question and real dialogue");
  const batches = record.retrieval_batches?.length ? record.retrieval_batches : [{ stage: "agent", plan_request_id: "", planned: 0, executed: record.tools.length, skipped_duplicates: 0, new_chunk_ids: [] }];
  for (const [offset, batch] of batches.entries()) {
    const tools = record.tools.filter((tool) => batch.plan_request_id ? tool.plan_request_id === batch.plan_request_id : tool.execution_source !== "host_plan");
    const requests = record.requests.filter((item) => item.phase === "agent" && !isGeneration(item) && [batch.stage, "agent"].includes(item.stage ?? ""));
    add("Retrieve", offset + 1, requests, tools, { plan: batch, queries: tools.map((tool) => ({ query: tool.query, effective_query: tool.effective_query, paper_ids: tool.paper_ids })) }, tools.map((tool) => ({ status: tool.status, backend: tool.backend, index_version: tool.index_version, chunk_ids: tool.chunk_ids })), tools.length ? null : "no tool execution required by this branch");
    const reranked = tools.filter((tool) => tool.tool_name === "retrieve_chunks" && tool.backend === "rrf_rerank");
    add("Rerank", offset + 1, [], reranked, { retrieved_candidates: "worker_internal", profiles: tools.map((tool) => tool.backend) }, { final_chunk_ids: reranked.flatMap((tool) => tool.chunk_ids) }, reranked.length ? null : "configured retrieval profile/branch does not execute Cross-Encoder", null);
    const checkStage = offset === 0 ? "evidence_check" : "evidence_check_final";
    const checks = record.requests.filter((item) => item.stage === checkStage || item.stage === `${checkStage}_format_repair`);
    add("Reflect", offset + 1, checks, [], { user_text: input, frame, answer_draft: "excluded", visible_ids: checks.flatMap((item) => item.tool_context.flatMap((proof) => proof.visible_chunks.map((chunk) => chunk.chunk_id))) }, record.stages?.filter((item) => item.stage.startsWith(checkStage)) ?? [], checks.length ? null : "configuration omits Reflect or no new evidence for another check");
  }
  const generated = record.requests.filter(isGeneration);
  add("Generate", 1, generated, [], { question: input, citation_sources: generated.flatMap((item) => item.tool_context.flatMap((proof) => proof.visible_chunks)) }, { final: record.final_structure ?? record.final_answer, citation_validity: record.citation_validity }, generated.length ? null : "engineering failure prevented generation");
  if (record.generation_failures?.length && !record.final_structure) stages.at(-1)!.status = "error";
  for (const stage of stages) if (["NLU", "Reflect"].includes(stage.stage) && !stage.reason && record.stages?.some((item) => item.status !== "completed" && stage.request_ids.includes(item.request_id ?? "")) &&
    !record.stages?.some((item) => item.status === "completed" && stage.request_ids.includes(item.request_id ?? ""))) stage.status = "error";
  const compact = record.requests.filter((item) => item.phase === "compaction");
  add("Memory", 1, compact, [], before, { state: after, compaction: record.compaction_events, summary_policy: "host projection through Pi native hook", structured_updates: record.components?.structured_memory === false ? "disabled by configuration; real dialogue retained" : "configured domain updates" }, null, null);
  const changes = Object.keys(after).filter((key) => JSON.stringify(before[key as keyof DomainState]) !== JSON.stringify(after[key as keyof DomainState])).map((field) => ({ field, before: before[field as keyof DomainState], after: after[field as keyof DomainState] }));
  return { user_turn_id: record.user_turn_id, input: { user_text: input, scope: [...record.declared_scope] },
    engineering_status: record.status, business_status: record.business_status ?? null, stages, elapsed_ms: record.elapsed_ms, state_changes: changes,
    preserved_failures: [...(record.stages?.filter((item) => item.status !== "completed") ?? []), ...(record.generation_failures ?? []),
      ...record.requests.filter((item) => item.status !== "completed"), ...record.tools.filter((item) => ["error", "rejected", "budget_rejected"].includes(item.status))], semantic_verdict: "not_evaluated" };
}
