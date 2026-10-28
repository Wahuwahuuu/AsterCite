export const TOOL_NAMES = ["search_papers", "retrieve_chunks"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface SearchParams { query: string; limit?: number; allowed_paper_ids?: string[] }
export interface RetrieveParams { query: string; paper_ids: string[]; top_k?: number; allowed_paper_ids?: string[];section?:'abstract';content_type?:'text'|'table'|'equation'|'all';offset?:number;reading_mode?:'workbench-v1' }
export interface Paper { paper_id: string; title: string; abstract: string;abstract_truncated?:boolean;abstract_length?:number }
export interface Chunk {
  text: string;
  paper_id: string;
  paragraph_id: string;
  chunk_id: string;
  section: string;
  start: number;
  end: number;
  citation?: string;
  index_version?: string;
  truncated?: boolean;
  format?:'markdown';content_type?:'table'|'equation';source_url?:string;
}
export interface EvidenceIdentity {
  paper_id: string;
  paragraph_id: string;
  chunk_id: string;
  start: number;
  end: number;
  text_sha256: string;
  index_version: string;
}
export interface P2HarnessConfig {
  profile: "A" | "B";
  indexVersion: string;
  evidenceIndex: ReadonlyMap<string, EvidenceIdentity>;
  publicPapers: readonly Paper[];
  abstractSources?:ReadonlyMap<string,Chunk>;
  scientificSources?:ScientificReadingPort;
  commonPrompt?: string;
  executionVersion?: "r1" | "r2" | "full-v1";
  /** Full-project component ablation; both profiles retain real dialogue/native compaction. */
  structuredMemory?: boolean;
  nlu?: boolean;
  reflect?: boolean;
  answerContract?: "text" | "full-v1-json";
  stageOutputLimits?: { question_frame:number; evidence_check:number; generation:number };
}
export interface SearchResult { papers: Paper[]; backend: string; index_version: string }
export interface RetrieveResult { chunks: Chunk[]; backend: string; index_version: string;
  query?: string; effective_query?: string; query_normalization?: string;selection?:{offset:number;returned:number;total:number;next_offset:number;has_more:boolean;unavailable_papers?:string[];incomplete_sources?:string[]};reading_note?:string }
export interface ScientificParams {query:string;paper_ids:string[];top_k:number;offset:number;content_type:'table'|'equation'|'all'}
export interface ScientificReadingPort {sources:ReadonlyMap<string,Chunk>;identities:ReadonlyMap<string,EvidenceIdentity>;retrieve(params:ScientificParams,signal?:AbortSignal):Promise<RetrieveResult>}
export interface WorkerTransport {
  request(method: ToolName, params: SearchParams | RetrieveParams, signal?: AbortSignal): Promise<unknown>;
  readScientificSources?(params:ScientificParams,signal?:AbortSignal):Promise<unknown>;
  memoryOperation?(params:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>;
}

export class RuntimeFailure extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeFailure";
    this.code = code;
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeFailure("INVALID_RESPONSE", "Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/Bearer\s+[^\s"',}]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s"',}]+/gi, "$1[REDACTED]");
}
export function safeText(value: string, secrets: readonly string[] = []): string { return redactText(value, secrets).slice(0, 2000); }

export function errorText(error: unknown, secrets: readonly string[] = []): string {
  return safeText(error instanceof Error ? error.message : "Runtime operation failed", secrets);
}

export function codepoints(text: string): number { return Array.from(text).length; }
