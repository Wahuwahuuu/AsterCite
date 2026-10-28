import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure, object, codepoints, type WorkerTransport, type SearchResult, type RetrieveResult, type Chunk, type P2HarnessConfig } from "./contracts.ts";
import type { TurnLedger } from "./ledger.ts";

export interface ToolContext {
  knownPaperIds: ReadonlySet<string>;
  getLedger(): TurnLedger;
  getScope(): readonly string[];
  p2?: P2HarnessConfig;
  recoverToolErrors?:boolean;
}

function failTool(ctx:ToolContext,ledger:TurnLedger,error:unknown):void{
  const recoverable=!(error instanceof RuntimeFailure)||['TOOL_ERROR','WORKER_ERROR','WORKER_TIMEOUT','RETRIEVAL_ERROR','INTERNAL_ERROR','QUERY_TOO_LONG','MODEL_OOM','WORKER_EXIT','WORKER_CLOSED','WORKER_WRITE_ERROR'].includes(error.code);
  if(!ctx.recoverToolErrors||!recoverable)ledger.fail(error instanceof RuntimeFailure?error.code:'TOOL_ERROR',error);
}

function query(text: string): void {
  if (!text.trim() || codepoints(text) > 1000) throw new RuntimeFailure("INVALID_PARAMS", "Query must contain 1..1000 Unicode codepoints");
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const effective = value ?? fallback;
  if (!Number.isInteger(effective) || effective < 1 || effective > maximum) throw new RuntimeFailure("INVALID_PARAMS", "Tool result count is outside its allowed range");
  return effective;
}
function metadata(value: unknown): Record<string, unknown> {
  const data = object(value);
  if (typeof data.backend !== "string" || typeof data.index_version !== "string") throw new RuntimeFailure("INVALID_RESPONSE", "Worker response is missing index metadata");
  return data;
}

function searchResult(value: unknown, ctx: ToolContext, limit: number): SearchResult {
  const data = metadata(value);
  if (!Array.isArray(data.papers) || data.papers.length > 10) throw new RuntimeFailure("INVALID_RESPONSE", "Invalid paper result list");
  const papers = data.papers.map((value) => {
    const paper = object(value);
    if (typeof paper.paper_id !== "string" || !ctx.knownPaperIds.has(paper.paper_id) ||
      typeof paper.title !== "string" || typeof paper.abstract !== "string" || codepoints(paper.abstract) > 1200) {
      throw new RuntimeFailure("INVALID_RESPONSE", "Invalid paper result");
    }
    return { paper_id: paper.paper_id, title: paper.title, abstract: paper.abstract };
  });
  const scope = ctx.getScope();
  return { papers: papers.filter((paper) => scope.length === 0 || scope.includes(paper.paper_id)).slice(0, limit),
    backend: data.backend as string, index_version: data.index_version as string };
}

function retrieveResult(value: unknown, requested: readonly string[], topK: number, ctx: ToolContext, originalQuery: string): RetrieveResult {
  const data = metadata(value);
  if (!Array.isArray(data.chunks) || data.chunks.length > topK) throw new RuntimeFailure("INVALID_RESPONSE", "Invalid chunk result list");
  const chunks = data.chunks.map((value): Chunk => {
    const chunk = object(value);
    for (const key of ["text", "paper_id", "paragraph_id", "chunk_id", "section"]) {
      if (typeof chunk[key] !== "string") throw new RuntimeFailure("INVALID_RESPONSE", "Invalid chunk result");
    }
    if (!requested.includes(chunk.paper_id as string) || !Number.isInteger(chunk.start) || !Number.isInteger(chunk.end) ||
      (chunk.start as number) < 0 || (chunk.end as number) <= (chunk.start as number) ||
      (chunk.end as number) - (chunk.start as number) !== codepoints(chunk.text as string) || codepoints(chunk.text as string) > 2000) {
      throw new RuntimeFailure("INVALID_RESPONSE", "Invalid chunk range or paper scope");
    }
    if (ctx.p2) {
      const identity = ctx.p2.evidenceIndex.get(chunk.chunk_id as string);
      const hash = createHash("sha256").update(chunk.text as string, "utf8").digest("hex");
      if (data.index_version !== ctx.p2.indexVersion || chunk.index_version !== ctx.p2.indexVersion ||
        chunk.citation !== `[${chunk.chunk_id}]` || chunk.truncated !== false || !identity ||
        identity.index_version !== ctx.p2.indexVersion || identity.paper_id !== chunk.paper_id ||
        identity.paragraph_id !== chunk.paragraph_id || identity.start !== chunk.start || identity.end !== chunk.end || identity.text_sha256 !== hash) {
        throw new RuntimeFailure("INVALID_RESPONSE", "Evidence does not match the current index and source map");
      }
    }
    return { text: chunk.text as string, paper_id: chunk.paper_id as string, paragraph_id: chunk.paragraph_id as string,
      chunk_id: chunk.chunk_id as string, section: chunk.section as string, start: chunk.start as number, end: chunk.end as number };
  });
  if (ctx.p2) for (const chunk of chunks) { chunk.citation = `[${["r2", "full-v1"].includes(ctx.p2.executionVersion ?? "") ? "cite:" : ""}${chunk.chunk_id}]`; chunk.index_version = ctx.p2.indexVersion; chunk.truncated = false; }
  const result: RetrieveResult = { chunks, backend: data.backend as string, index_version: data.index_version as string };
  if (ctx.p2 && ["query", "effective_query", "query_normalization"].some((key) => Object.hasOwn(data, key))) {
    if (data.query !== originalQuery || typeof data.effective_query !== "string" || !data.effective_query.trim() ||
      codepoints(data.effective_query) > 1000 || data.query_normalization !== "public_metadata_prefix_v1") {
      throw new RuntimeFailure("INVALID_RESPONSE", "Invalid retrieval query normalization metadata");
    }
    result.query = originalQuery; result.effective_query = data.effective_query; result.query_normalization = data.query_normalization;
  }
  return result;
}

/** Same deterministic validation before P2 reservation and at the worker boundary. */
export function validatePaperParams(name: string, value: unknown, ctx: ToolContext): void {
  const params = object(value);
  if (typeof params.query !== "string") throw new RuntimeFailure("INVALID_PARAMS", "Query must be text");
  query(params.query);
  if (name === "search_papers") { bounded(params.limit as number | undefined, 5, 10); return; }
  if (name !== "retrieve_chunks") throw new RuntimeFailure("TOOL_NOT_ALLOWED", "Tool is outside the allowed registry");
  bounded(params.top_k as number | undefined, 5, 5);
  if (!Array.isArray(params.paper_ids) || params.paper_ids.length < 1 || params.paper_ids.length > 4 ||
    new Set(params.paper_ids).size !== params.paper_ids.length || params.paper_ids.some((id) => typeof id !== "string" || !ctx.knownPaperIds.has(id))) {
    throw new RuntimeFailure("INVALID_PARAMS", "Paper IDs must be distinct known corpus IDs");
  }
  const scope = ctx.getScope();
  if (scope.length && params.paper_ids.some((id) => !scope.includes(id as string))) throw new RuntimeFailure("SCOPE_VIOLATION", "Retrieval cannot expand the user-declared paper scope");
}

export function createPaperTools(worker: WorkerTransport, ctx: ToolContext): ToolDefinition[] {
  const search: ToolDefinition<typeof searchSchema> = {
    name: "search_papers", label: "Search papers", description: "Find papers in the fixed corpus. Only the user-declared paper scope may be used.",
    promptSnippet: "Find corpus papers by query; respect the declared paper scope.", parameters: searchSchema, executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const ledger = ctx.getLedger();
      const entry = ledger.beginTool("search_papers", toolCallId);
      const started = Date.now();
      try {
        query(params.query);
        const limit = bounded(params.limit, 5, 10);
        if (ctx.p2) ledger.dispatchedTool(toolCallId);
        const result = searchResult(await worker.request("search_papers", { query: params.query,
          limit: ctx.p2 ? limit : ctx.getScope().length ? 10 : limit,
          ...(ctx.p2 ? { allowed_paper_ids: [...(ctx.getScope().length ? ctx.getScope() : ctx.knownPaperIds)] } : {}),
        }, signal), ctx, limit);
        if (ctx.p2 && result.index_version !== ctx.p2.indexVersion) throw new RuntimeFailure("INVALID_RESPONSE", "Paper catalog index identity differs from the configured index");
        entry.paper_ids = result.papers.map((paper) => paper.paper_id);
        entry.backend = result.backend; entry.index_version = result.index_version;
        entry.status = "completed";
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        entry.status = "error";
        entry.error = ledger.errorText(error);
        failTool(ctx,ledger,error);
        throw error;
      } finally { entry.elapsed_ms = Date.now() - started; }
    },
  };
  const retrieve: ToolDefinition<typeof retrieveSchema> = {
    name: "retrieve_chunks", label: "Retrieve evidence", description: "Retrieve source text from 1..4 explicitly chosen corpus paper IDs. Cite chunk IDs and use only these excerpts as evidence.",
    promptSnippet: "Retrieve source chunks for permitted paper IDs; cite chunk IDs.", parameters: retrieveSchema, executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const ledger = ctx.getLedger();
      const entry = ledger.beginTool("retrieve_chunks", toolCallId);
      const started = Date.now();
      try {
        query(params.query);
        const topK = bounded(params.top_k, 5, 5);
        if (params.paper_ids.length < 1 || params.paper_ids.length > 4 || new Set(params.paper_ids).size !== params.paper_ids.length ||
          params.paper_ids.some((id) => !ctx.knownPaperIds.has(id))) throw new RuntimeFailure("INVALID_PARAMS", "Paper IDs must be distinct known corpus IDs");
        const scope = ctx.getScope();
        if (scope.length && params.paper_ids.some((id) => !scope.includes(id))) throw new RuntimeFailure("SCOPE_VIOLATION", "Retrieval cannot expand the user-declared paper scope");
        if (ctx.p2) ledger.dispatchedTool(toolCallId);
        const result = retrieveResult(await worker.request("retrieve_chunks", { query: params.query, paper_ids: params.paper_ids, top_k: topK,
          ...(ctx.p2 ? { allowed_paper_ids: [...(ctx.getScope().length ? ctx.getScope() : ctx.knownPaperIds)] } : {}),
        }, signal), params.paper_ids, topK, ctx, params.query);
        if (ctx.p2) { entry.query = params.query; entry.effective_query = result.effective_query ?? params.query;
          entry.query_normalization = result.query_normalization ?? "none"; }
        entry.paper_ids = params.paper_ids;
        entry.chunk_ids = result.chunks.map((chunk) => chunk.chunk_id);
        entry.backend = result.backend; entry.index_version = result.index_version;
        entry.visible_chunks = result.chunks.map(({ paper_id, paragraph_id, chunk_id, start, end, text }) => ({
          paper_id, paragraph_id, chunk_id, start, end, text_codepoints: codepoints(text),
        }));
        entry.status = "completed";
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } catch (error) {
        entry.status = "error";
        entry.error = ledger.errorText(error);
        failTool(ctx,ledger,error);
        throw error;
      } finally { entry.elapsed_ms = Date.now() - started; }
    },
  };
  return [search, retrieve];
}

const searchSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }, { additionalProperties: false });
const retrieveSchema = Type.Object({ query: Type.String({ minLength: 1, maxLength: 1000 }), paper_ids: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4, uniqueItems: true }), top_k: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }, { additionalProperties: false });
