import { createHash } from "node:crypto";
import { RuntimeFailure, object } from "./contracts.ts";
import type { SessionSnapshot } from "./session-memory.ts";
import type { PreparedTurnRecord } from "./pipeline-trace-prepared-v1.ts";

export interface RuntimeControls {
  arm: "A" | "C";
  reflect: boolean;
  compaction: "native" | "off";
  reliability: "baseline" | "candidate";
  implementation_id: string;
}
export interface ControlledSnapshot {
  version: 2;
  controls: RuntimeControls;
  index_version: string;
  state_sha256: string;
  binding_sha256: string;
  state: SessionSnapshot;
}
export interface ControlledTurnRecord extends PreparedTurnRecord {
  answer_policy?:'workbench-v1';
  runtime_controls: RuntimeControls & { auto_compaction_enabled: boolean };
  reliability_adaptations: Array<{ stage: string; request_id: string | null; kind: string; original_response: string }>;
}
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown) => createHash("sha256").update(canonicalJSON(value)).digest("hex");
export function parseRuntimeControls(value: unknown): RuntimeControls {
  const v = object(value);
  if (Object.keys(v).sort().join() !== "arm,compaction,implementation_id,reflect,reliability" ||
      typeof v.arm !== "string" || !["A", "C"].includes(v.arm) || typeof v.reflect !== "boolean" || v.arm === "A" && v.reflect ||
      typeof v.compaction !== "string" || !["native", "off"].includes(v.compaction) ||
      typeof v.reliability !== "string" || !["baseline", "candidate"].includes(v.reliability) ||
      typeof v.implementation_id !== "string" || !/^[a-f0-9]{64}$/u.test(v.implementation_id)) {
    throw new RuntimeFailure("INVALID_CONFIG", "Controls require A/C, explicit Reflect/compaction/reliability and a fixed implementation identity; A has no Reflect");
  }
  return structuredClone(v) as unknown as RuntimeControls;
}
export function wrapSnapshot(state: SessionSnapshot, controls: RuntimeControls): ControlledSnapshot {
  controls = parseRuntimeControls(controls);
  const core = { version: 2 as const, controls, index_version: state.index_version, state_sha256: fingerprint(state) };
  return { ...core, binding_sha256: fingerprint(core), state: structuredClone(state) };
}
export function unwrapSnapshot(value: ControlledSnapshot, controls: RuntimeControls, index: string): SessionSnapshot {
  const v = object(value), actual = parseRuntimeControls(v.controls);
  const state = v.state as SessionSnapshot;
  const core = { version: v.version, controls: actual, index_version: v.index_version, state_sha256: v.state_sha256 };
  if (Object.keys(v).sort().join() !== "binding_sha256,controls,index_version,state,state_sha256,version" || v.version !== 2 ||
      canonicalJSON(actual) !== canonicalJSON(parseRuntimeControls(controls)) || v.index_version !== index || state?.index_version !== index ||
      state?.profile !== (controls.arm === "A" ? "A" : "B") || fingerprint(state) !== v.state_sha256 || fingerprint(core) !== v.binding_sha256) {
    throw new RuntimeFailure("INVALID_SNAPSHOT", "Snapshot state, implementation, component or index binding differs");
  }
  return structuredClone(state);
}
