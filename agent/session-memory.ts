import type { Extension, FileEntry, SessionEntry, SessionManager, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { RuntimeFailure, redactText, type Chunk, type P2HarnessConfig, type RetrieveResult } from "./contracts.ts";
import { DomainMemory, sourceMatches, type DialogueRecord, type DomainState } from "./domain-memory.ts";

export const MEMORY_EXTENSION = "<inline:pipaper-safe-compaction>";
export interface SessionSnapshot {
  version: 1; profile: "A" | "B"; index_version: string; entries: FileEntry[];
  domain_state: DomainState; dialogue: DialogueRecord[]; final_signatures: string[];
  answer_policy?:'workbench-v1';
}

/** This explicit extension adds no tools, commands, providers or discovery. */
export function nativeMemoryExtension(summary: () => string): Extension {
  const extension: Extension = { path: MEMORY_EXTENSION, resolvedPath: MEMORY_EXTENSION,
    sourceInfo: { path: MEMORY_EXTENSION, source: "inline", scope: "temporary", origin: "top-level" },
    handlers: new Map(), tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
  extension.handlers.set("session_before_compact", [async (event) => {
    const preparation = (event as SessionBeforeCompactEvent).preparation;
    return { compaction: { summary: summary(), firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore, details: { kind: "pipaper_deterministic_compaction_v1", summary_model_calls: 0 } } };
  }]);
  return extension;
}

export function assistantSignature(message: { timestamp: number; content: Array<{ type: string; text?: string }> }): string {
  return JSON.stringify([message.timestamp, message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")]);
}

/** Keep tree IDs while removing thinking, provider metadata and non-final text. */
export function safeSessionEntries(manager: SessionManager, finals: ReadonlySet<string>, secrets: readonly string[]): FileEntry[] {
  const entries = [manager.getHeader()!, ...manager.getBranch()].map((entry): FileEntry => {
    if (entry.type !== "message") return structuredClone(entry);
    const message = entry.message;
    if (message.role === "assistant") {
      const content = message.content.filter((block) => block.type === "toolCall" || block.type === "text" && finals.has(assistantSignature(message))).map((block) =>
        block.type === "text" ? { type: "text" as const, text: block.text } : block);
      return { ...entry, message: { role: "assistant", content, timestamp: message.timestamp, api: message.api,
        provider: message.provider, model: message.model, usage: message.usage, stopReason: message.stopReason } };
    }
    if (message.role === "toolResult") return { ...entry, message: { role: "toolResult", toolCallId: message.toolCallId,
      toolName: message.toolName, content: message.content.filter((block) => block.type === "text"), isError: message.isError, timestamp: message.timestamp } };
    return structuredClone(entry);
  });
  return JSON.parse(redactText(JSON.stringify(entries), secrets)) as FileEntry[];
}

/** A persisted envelope is trusted only after matching every actual source byte with the current corpus. */
export function restoreSnapshot(snapshot: SessionSnapshot, config: P2HarnessConfig): { snapshot: SessionSnapshot; chunks: Map<string, Chunk> } {
  if (snapshot.version !== 1 || snapshot.profile !== config.profile || !Array.isArray(snapshot.entries) || snapshot.entries[0]?.type !== "session" ||
    !Array.isArray(snapshot.dialogue) || !Array.isArray(snapshot.final_signatures)) throw new RuntimeFailure("INVALID_SNAPSHOT", "Session profile/header/version mismatch");
  const restored = structuredClone(snapshot), chunks = new Map<string, Chunk>();
  const ids = new Set<string>();
  for (const entry of restored.entries.slice(1) as SessionEntry[]) {
    if (!entry.id || ids.has(entry.id) || entry.parentId !== null && !ids.has(entry.parentId)) {
      throw new RuntimeFailure("INVALID_SNAPSHOT", "Session tree contains duplicate IDs or unresolved parent");
    }
    ids.add(entry.id);
    const valid = (value: unknown): RetrieveResult => {
      const result = value as RetrieveResult;
      if (!result || !Array.isArray(result.chunks)) throw new RuntimeFailure("INVALID_SNAPSHOT", "Malformed persisted evidence");
      const accepted = result.chunks.filter((chunk) => sourceMatches(chunk, config.indexVersion, config.evidenceIndex));
      for (const chunk of accepted) chunks.set(chunk.chunk_id, chunk);
      return { chunks: accepted, backend: "restored_source_revalidated", index_version: config.indexVersion };
    };
    if (entry.type === "custom_message" && entry.customType === "pipaper_host_evidence") {
      if (typeof entry.content !== "string") throw new RuntimeFailure("INVALID_SNAPSHOT", "Host evidence must be text");
      const value = JSON.parse(entry.content);
      entry.content = JSON.stringify({ source: "pipaper_host_evidence", evidence_message_id: value.evidence_message_id,
        tool_call_id: value.tool_call_id, result: valid(value.result) });
      delete entry.details;
    }
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "retrieve_chunks" && !entry.message.isError) {
      entry.message.content = entry.message.content.filter((block) => block.type === "text").map((block) => ({ type: "text" as const,
        text: JSON.stringify(valid(JSON.parse(block.text))) }));
    }
  }
  const memory = new DomainMemory(config.indexVersion, restored.domain_state);
  memory.revalidate(config.indexVersion, config.evidenceIndex, chunks);
  restored.domain_state = memory.state; restored.index_version = config.indexVersion;
  for (const entry of restored.entries) if (entry.type === "compaction") {
    // Never accept a persisted/model-generated summary as an additional fact source.
    entry.summary = memory.summary(restored.dialogue, config.profile === "B" && config.structuredMemory !== false);
    entry.details = { kind: "pipaper_deterministic_compaction_v1", restored_and_revalidated: true };
  }
  return { snapshot: restored, chunks };
}
