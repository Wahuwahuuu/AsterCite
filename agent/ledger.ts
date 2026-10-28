import { randomUUID, createHash } from "node:crypto";
import type { AssistantMessage, Model, Api, TranscriptContext } from "@earendil-works/pi-ai";
import { RuntimeFailure, TOOL_NAMES, errorText, redactText, codepoints } from "./contracts.ts";

export interface ToolContextEvidence {
  tool_call_id: string;
  tool_name: string;
  is_error: boolean;
  text_content_codepoints: number;
  text_content_sha256: string;
  visible_chunks: Array<{ paper_id: string; chunk_id: string; text_codepoints: number; text_sha256: string;
    paragraph_id?: string; start?: number; end?: number; index_version?: string }>;
}

/** Fingerprint actual model-visible text content, never details or assistant reasoning. */
export function toolContextEvidence(context: TranscriptContext): ToolContextEvidence[] {
  const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  return context.messages.filter((message) => message.role === "toolResult").map((message) => {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    const visible: ToolContextEvidence["visible_chunks"] = [];
    if (message.toolName === "retrieve_chunks" && !message.isError) {
      for (const block of message.content) {
        if (block.type !== "text") continue;
        try {
          const data: unknown = JSON.parse(block.text);
          if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).chunks)) continue;
          for (const value of (data as { chunks: unknown[] }).chunks) {
            if (!value || typeof value !== "object") continue;
            const chunk = value as Record<string, unknown>;
            if (typeof chunk.paper_id === "string" && typeof chunk.chunk_id === "string" && typeof chunk.text === "string") {
              visible.push({ paper_id: chunk.paper_id, chunk_id: chunk.chunk_id, text_codepoints: codepoints(chunk.text), text_sha256: sha256(chunk.text),
                ...(typeof chunk.paragraph_id === "string" ? { paragraph_id: chunk.paragraph_id } : {}),
                ...(Number.isInteger(chunk.start) ? { start: chunk.start as number } : {}),
                ...(Number.isInteger(chunk.end) ? { end: chunk.end as number } : {}),
                ...(typeof chunk.index_version === "string" ? { index_version: chunk.index_version }
                  : typeof (data as Record<string, unknown>).index_version === "string" ? { index_version: (data as Record<string, unknown>).index_version as string } : {}),
              });
            }
          }
        } catch { /* A Pi validation error is ordinary visible text, not a JSON evidence result. */ }
      }
    }
    return { tool_call_id: message.toolCallId, tool_name: message.toolName, is_error: message.isError,
      text_content_codepoints: codepoints(text), text_content_sha256: sha256(text), visible_chunks: visible };
  });
}

export interface ObservedUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  totalTokens: number | null;
}
export interface RequestRecord {
  request_id: string;
  user_turn_id: string;
  phase: "agent" | "compaction" | "auxiliary";
  stage?: string;
  provider: string;
  model_id: string;
  admitted: boolean;
  http_attempts: number;
  http_status: number | null;
  provider_response_id: string | null;
  tool_context: ToolContextEvidence[];
  status: "running" | "completed" | "error" | "aborted" | "budget_rejected";
  elapsed_ms: number;
  usage_status: "reported" | "unknown";
  usage: ObservedUsage;
  pricing_status: "unknown";
  error: string | null;
}
export interface ToolRecord {
  tool_attempt_id: string;
  tool_call_id: string;
  user_turn_id: string;
  model_request_id: string | null;
  tool_name: string;
  status: "running" | "completed" | "error" | "budget_rejected" | "rejected";
  paper_ids: string[];
  chunk_ids: string[];
  backend: string | null;
  index_version: string | null;
  visible_chunks: Array<{ paper_id: string; paragraph_id: string; chunk_id: string; start: number; end: number; text_codepoints: number }>;
  elapsed_ms: number;
  error: string | null;
  executed?: boolean;
  query?: string;
  effective_query?: string;
  query_normalization?: string;
  execution_source?: "model" | "host_plan";
  plan_request_id?: string | null;
}
export interface TurnRecord {
  user_turn_id: string;
  declared_scope: string[];
  status: "running" | "completed" | "error" | "aborted" | "budget_exceeded" | "timeout";
  final_answer: string;
  elapsed_ms: number;
  agent_settled: boolean;
  compaction_events: Array<{ type: "start" | "end"; reason: string; aborted?: boolean }>;
  requests: RequestRecord[];
  tools: ToolRecord[];
  error: string | null;
  citation_validity: { cited_ids: string[]; unknown_ids: string[]; missing: boolean; range_valid: boolean; semantic_support: "not_evaluated" };
  profile?: "A" | "B";
  execution_surface?: "cli"|"batch";
  session_recovery?: { snapshot_revalidated:true; index_version:string; recovered_dialogue_turns:number; native_compaction_entries:number };
  compaction_control?: { trigger:"host_planned"; keep_recent_tokens:50; natural_settings_restored:boolean };
  components?: { nlu: boolean; reflect: boolean; structured_memory: boolean };
  final_request_id?: string | null;
  internal_drafts?: string[];
  stages?: Array<{ stage: string; status: string; value?: unknown; error?: string; request_id?: string;
    frame_id?: string; response_text?: string; response_truncated?: boolean; normalizer?: "bare_json" | "single_fence" }>;
  citation_corrections?: Array<{ original_answer: string; corrected_answer: string; request_id: string | null }>;
  closing_reason?: string | null;
  failure_code?: string | null;
  retrieval_batches?: Array<{ stage: string; plan_request_id: string; planned: number; executed: number;
    skipped_duplicates: number; new_chunk_ids: string[] }>;
  business_status?: "answer" | "partial" | "refusal" | "clarification" | null;
  final_structure?: import("./final-answer.ts").FinalAnswer;
  citation_attribution?:import('./citation-attribution.ts').ClaimAttribution[];
  generation_failures?: Array<{ code: string; error: string; response_text: string; request_id: string | null }>;
  pipeline_trace?: import("./pipeline-trace.ts").PipelineTrace;
}

export function emptyUsage(): ObservedUsage {
  return { input: null, output: null, cacheRead: null, cacheWrite: null, reasoning: null, totalTokens: null };
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function optionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Extract counts only. Raw stream data and reasoning text are never stored. */
export function observeUsage(data: unknown, record: RequestRecord): void {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const frame = data as Record<string, unknown>;
  let usage: Record<string, unknown> | undefined;
  if (frame.usage && typeof frame.usage === "object" && !Array.isArray(frame.usage)) usage = optionalObject(frame.usage);
  if (frame.type === "message_start" && frame.message && typeof frame.message === "object") {
    const message = optionalObject(frame.message);
    if (message.usage && typeof message.usage === "object" && !Array.isArray(message.usage)) usage = optionalObject(message.usage);
  }
  if (!usage) return;
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens);
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  const promptDetails = optionalObject(usage.prompt_tokens_details);
  const outputDetails = optionalObject(usage.completion_tokens_details);
  const cacheRead = number(usage.cache_read_input_tokens ?? promptDetails.cached_tokens);
  const cacheWrite = number(usage.cache_creation_input_tokens);
  if (prompt !== null) record.usage.input = cacheRead !== null && cacheRead > prompt ? null : prompt - (cacheRead ?? 0);
  if (output !== null) record.usage.output = output;
  if (cacheRead !== null) record.usage.cacheRead = cacheRead;
  if (cacheWrite !== null) record.usage.cacheWrite = cacheWrite;
  const reasoning = number(outputDetails.reasoning_tokens);
  if (reasoning !== null) record.usage.reasoning = reasoning;
  const total = number(usage.total_tokens);
  if (total !== null) record.usage.totalTokens = total;
  if (Object.values(record.usage).some((value) => value !== null)) record.usage_status = "reported";
}

export class TurnLedger {
  readonly record: TurnRecord;
  readonly maxRequests: number;
  readonly maxToolCalls: number;
  phase: RequestRecord["phase"] = "agent";
  stage = "agent";
  closing = false;
  readonly p2Mode: boolean;
  failureCode: string | undefined;
  private started = Date.now();
  private admittedRequests = 0;
  private readonly toolCounts = new Map<string, number>();
  private readonly toolStarted = new Map<string, number>();
  private readonly claimedToolIds = new Set<string>();
  private readonly secrets: readonly string[];

  constructor(userTurnId: string, declaredScope: string[], secrets: readonly string[] = [], maxRequests = 12, maxToolCalls = 2, p2Mode = false) {
    this.maxRequests = maxRequests;
    this.maxToolCalls = maxToolCalls;
    this.secrets = secrets;
    this.p2Mode = p2Mode;
    this.record = {
      user_turn_id: userTurnId, declared_scope: [...declaredScope], status: "running", final_answer: "",
      elapsed_ms: 0, agent_settled: false, compaction_events: [], requests: [], tools: [], error: null,
      citation_validity: { cited_ids: [], unknown_ids: [], missing: true, range_valid: true, semantic_support: "not_evaluated" },
    };
  }

  fail(code: string, error: unknown): void {
    const terminal = (value: string | undefined) => value === "BUDGET_EXCEEDED" || value === "CANCELLED" || value === "ABORTED" || value === "TOOL_NOT_ALLOWED" || value === "DUPLICATE_TOOL_ID" || Boolean(value?.includes("TIMEOUT"));
    if (!this.failureCode || (terminal(code) && !terminal(this.failureCode))) {
      this.failureCode = code;
      this.record.error = errorText(error, this.secrets);
    }
  }

  errorText(error: unknown): string { return errorText(error, this.secrets); }
  get mustStop(): boolean {
    if (this.p2Mode && this.failureCode) return true;
    return this.failureCode === "BUDGET_EXCEEDED" || this.failureCode === "CANCELLED" ||
      this.failureCode === "ABORTED" || this.failureCode === "TOOL_NOT_ALLOWED" || this.failureCode === "DUPLICATE_TOOL_ID" || Boolean(this.failureCode?.includes("TIMEOUT"));
  }
  get requestCount(): number { return this.admittedRequests; }
  get remainingRequests(): number { return this.maxRequests - this.admittedRequests; }
  toolCount(name: string): number { return this.toolCounts.get(name) ?? 0; }
  toolLimit(name: string): number { return this.p2Mode ? name === "retrieve_chunks" ? 4 : 2 : this.maxToolCalls; }
  close(reason: string): void { this.closing = true; this.record.closing_reason ??= reason; }

  beginRequest(model: Model<Api>): RequestRecord {
    const stopped = this.mustStop;
    const finalStage = this.phase === "agent" && (this.stage === "generate" || this.stage === "closing" || this.stage === "citation_repair");
    const reserved = this.p2Mode && this.admittedRequests >= this.maxRequests - 1 && !finalStage;
    const admitted = !stopped && !reserved && this.admittedRequests < this.maxRequests;
    const record: RequestRecord = {
      request_id: randomUUID(), user_turn_id: this.record.user_turn_id, phase: this.phase,
      provider: model.provider, model_id: model.id, admitted, http_attempts: 0, http_status: null, provider_response_id: null, tool_context: [],
      status: admitted ? "running" : "budget_rejected", elapsed_ms: 0, usage_status: "unknown",
      ...(this.p2Mode ? { stage: this.stage } : {}),
      usage: emptyUsage(), pricing_status: "unknown", error: null,
    };
    this.record.requests.push(record);
    if (!admitted) {
      if (stopped) {
        record.error = this.record.error ?? `Turn stopped before model request (${this.failureCode})`;
      } else {
        record.error = reserved ? "Final model request is reserved for closing" : "Model request budget exhausted";
        if (!this.failureCode) this.fail("BUDGET_EXCEEDED", new RuntimeFailure("BUDGET_EXCEEDED", record.error));
      }
    } else this.admittedRequests++;
    return record;
  }

  endRequest(record: RequestRecord, message: AssistantMessage, started: number): void {
    record.status = message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed";
    record.elapsed_ms = Date.now() - started;
    if (message.responseId) record.provider_response_id = this.errorText(new Error(message.responseId));
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      record.error = errorText(new Error(message.errorMessage ?? "Model request failed"), this.secrets);
      this.fail(message.stopReason === "aborted" ? "ABORTED" : "MODEL_ERROR", new Error(record.error));
    }
  }

  beginTool(name: string, toolCallId: string, stage: "start" | "execute" = "execute"): ToolRecord {
    const existing = this.record.tools.findLast((entry) => entry.tool_call_id === toolCallId);
    if (existing) {
      if (stage === "execute" && existing.tool_name === name && existing.status === "running" && !this.claimedToolIds.has(toolCallId)) {
        this.claimedToolIds.add(toolCallId); return existing;
      }
      const error = new RuntimeFailure("DUPLICATE_TOOL_ID", "Provider repeated a tool call ID");
      this.record.tools.push({ ...existing, tool_attempt_id: randomUUID(), tool_name: name, status: "rejected", elapsed_ms: 0, error: error.message,
        paper_ids: [], chunk_ids: [], visible_chunks: [], backend: null, index_version: null,
        model_request_id: this.record.requests.findLast((entry) => entry.admitted)?.request_id ?? null });
      this.fail(error.code, error); throw error;
    }
    const count = (this.toolCounts.get(name) ?? 0) + 1;
    if (!this.p2Mode) this.toolCounts.set(name, count);
    const record: ToolRecord = {
      tool_attempt_id: randomUUID(), tool_call_id: toolCallId, user_turn_id: this.record.user_turn_id, tool_name: name,
      model_request_id: this.record.requests.findLast((entry) => entry.admitted)?.request_id ?? null,
      status: !this.p2Mode && count > this.maxToolCalls ? "budget_rejected" : "running", paper_ids: [], chunk_ids: [],
      backend: null, index_version: null, visible_chunks: [], elapsed_ms: 0, error: null,
    };
    this.record.tools.push(record);
    this.toolStarted.set(toolCallId, Date.now());
    if (stage === "execute") this.claimedToolIds.add(toolCallId);
    if (!(TOOL_NAMES as readonly string[]).includes(name)) {
      record.status = "rejected"; record.error = "Tool is outside the allowed registry";
      this.fail("TOOL_NOT_ALLOWED", new RuntimeFailure("TOOL_NOT_ALLOWED", record.error));
      throw new RuntimeFailure("TOOL_NOT_ALLOWED", record.error);
    }
    if (!this.p2Mode && count > this.maxToolCalls) {
      this.fail("BUDGET_EXCEEDED", new RuntimeFailure("BUDGET_EXCEEDED", `${name} tool budget exhausted`));
      record.error = `${name} tool budget exhausted`;
      throw new RuntimeFailure("BUDGET_EXCEEDED", `${name} tool budget exhausted`);
    }
    return record;
  }

  /** Synchronous reservation runs before asynchronous worker dispatch, including parallel batches. */
  admitTool(name: string, toolCallId: string): boolean {
    const entry = this.record.tools.findLast((item) => item.tool_call_id === toolCallId);
    if (!entry || entry.status !== "running") return false;
    if (this.mustStop || this.closing || this.toolCount(name) >= this.toolLimit(name)) {
      entry.status = "budget_rejected";
      entry.executed = false;
      entry.error = this.closing ? "Retrieval is closed; answer with currently visible evidence" : `${name} tool budget exhausted`;
      return false;
    }
    this.toolCounts.set(name, this.toolCount(name) + 1);
    entry.executed = false;
    return true;
  }
  dispatchedTool(toolCallId: string): void {
    const entry = this.record.tools.findLast((item) => item.tool_call_id === toolCallId);
    if (entry) entry.executed = true;
  }
  rejectTool(toolCallId: string, error: unknown): void {
    const entry = this.record.tools.findLast((item) => item.tool_call_id === toolCallId);
    if (entry) { entry.status = "rejected"; entry.error = this.errorText(error); entry.executed = false; }
  }

  endTool(toolCallId: string, isError: boolean): void {
    const entry = this.record.tools.findLast((entry) => entry.tool_call_id === toolCallId);
    if (!entry) return;
    entry.elapsed_ms = Date.now() - (this.toolStarted.get(toolCallId) ?? Date.now());
    if (entry.status === "running") {
      entry.status = isError ? "error" : "completed";
      if (isError) entry.error = "Pi rejected or failed the tool call";
    }
  }

  finish(answer: string): TurnRecord {
    if (this.p2Mode) this.record.failure_code = this.failureCode ?? null;
    this.record.final_answer = answer;
    this.record.elapsed_ms = Date.now() - this.started;
    this.record.status = this.failureCode === "BUDGET_EXCEEDED" ? "budget_exceeded"
      : this.failureCode?.includes("TIMEOUT") ? "timeout"
      : this.failureCode === "ABORTED" || this.failureCode === "CANCELLED" ? "aborted"
      : this.failureCode ? "error" : "completed";
    // Redact every saved leaf, including citation IDs and provider error identifiers.
    const redact = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "string") (value as Record<string, unknown>)[key] = redactText(entry, this.secrets);
        else redact(entry);
      }
    };
    redact(this.record);
    return this.record;
  }
}
