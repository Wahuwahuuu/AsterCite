import { createHash } from "node:crypto";
import { InMemoryCredentialStore, InMemoryModelsStore, fauxProvider, type FauxResponseStep, type Model, type Api } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MainPaperHarness, type MainHarnessOptions } from "../../agent/session-main-v2.ts";
import type { Chunk, WorkerTransport } from "../../agent/contracts.ts";

export const PREPARED_INDEX = "prepared-fixture";
export const SOURCE_TEXTS = ["A😀 source supports the fact.", "New source supplies the missing condition."];
export const SOURCE_IDS = SOURCE_TEXTS.map((text, i) => `${PREPARED_INDEX}:p1:s0:p${i}:c0-${Array.from(text).length}`);
export const preparation = { intent: "answer", targets: ["p1"], rewrite: "p1 requested fact", queries: ["first"] };
export const supported = { checks: [{ need_id: "n1", status: "supported", basis: "explicit", finding: "The source supports the fact.", support_spans: [{ chunk_id: SOURCE_IDS[0], quote: "A😀 source" }] }], next_action: "answer" };
export const final = { status: "answer", answer: `The source supports the fact [cite:${SOURCE_IDS[0]}]`, exact_quotes: [] };

export async function mainFixture(responses: FauxResponseStep[], batches = [[0]], extra: Partial<MainHarnessOptions> = {}, profile: "A" | "B" = "B") {
  const chunks: Chunk[] = SOURCE_TEXTS.map((text, i) => ({ paper_id: "p1", paragraph_id: `p1:s0:p${i}`, chunk_id: SOURCE_IDS[i], citation: `[${SOURCE_IDS[i]}]`,
    section: "Results", text, start: 0, end: Array.from(text).length, index_version: PREPARED_INDEX, truncated: false }));
  const faux = fauxProvider({ tokensPerSecond: 0 }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  const calls: Array<{ method: string; params: unknown }> = [];
  let retrieves = 0;
  const worker: WorkerTransport = { async request(method, params) {
    calls.push({ method, params });
    if (method === "search_papers") return { backend: "rrf_rerank", index_version: PREPARED_INDEX, papers: [{ paper_id: "p1", title: "Paper One", abstract: "CATALOG_ONLY" }] };
    return { backend: "rrf_rerank", index_version: PREPARED_INDEX, chunks: (batches[Math.min(retrieves++, batches.length - 1)] ?? []).map(i => chunks[i]) };
  } };
  const harness = await MainPaperHarness.create({ cwd: process.cwd(), modelRuntime: runtime, model: faux.getModel() as Model<Api>, worker,
    knownPaperIds: new Set(["p1"]), controls: { arm: profile === "A" ? "A" : "C", reflect: profile === "B", compaction: "off", reliability: "baseline", implementation_id: "1".repeat(64) }, questionPreparation: "light-v1",
    p2: { profile, executionVersion: "full-v1", answerContract: "full-v1-json", indexVersion: PREPARED_INDEX,
      evidenceIndex: new Map(chunks.map(chunk => [chunk.chunk_id, { ...chunk, index_version: PREPARED_INDEX, text_sha256: createHash("sha256").update(chunk.text).digest("hex") }])),
      publicPapers: [{ paper_id: "p1", title: "Paper One", abstract: "CATALOG_ONLY" }], nlu: profile === "B", reflect: extra.controls?.reflect ?? profile === "B", structuredMemory: profile === "B" }, ...extra });
  return { harness, faux, calls, chunks };
}
