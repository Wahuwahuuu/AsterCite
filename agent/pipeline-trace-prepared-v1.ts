import type { DomainState } from "./domain-memory.ts";
import type { TurnRecord } from "./ledger.ts";
import { pipelineTrace, type PipelineTrace, type StageTrace } from "./pipeline-trace.ts";
import type { PreparationRecord } from "./question-preparation.ts";

export interface PreparedStageTrace extends Omit<StageTrace, "stage" | "status"> {
  stage: Exclude<StageTrace["stage"], "NLU"> | "QuestionPreparation";
  status: StageTrace["status"] | "degraded";
}
export interface PreparedPipelineTrace extends Omit<PipelineTrace, "stages"> { stages: PreparedStageTrace[] }
export interface PreparedTurnRecord extends Omit<TurnRecord, "pipeline_trace"> {
  runtime_family: "question-preparation-v1";
  question_preparation: PreparationRecord;
  pipeline_trace?: PreparedPipelineTrace;
}

/** Reuse frozen responsibility accounting; the stage alias exists only in this projection. */
export function preparedPipelineTrace(record: TurnRecord, input: string, before: DomainState, after: DomainState,
  preparation: PreparationRecord): PreparedPipelineTrace {
  const projected = { ...record,
    requests: record.requests.map(request => request.stage === "question_preparation" ? { ...request, stage: "question_frame" } : request),
    stages: record.stages?.map(stage => stage.stage === "question_preparation" ? { ...stage, stage: "question_frame" } : stage) };
  const original = pipelineTrace(projected, input, before, after);
  const stages: PreparedStageTrace[] = original.stages.map(stage => {
    if (stage.stage !== "NLU") return stage as PreparedStageTrace;
    return { ...stage, stage: "QuestionPreparation", stage_id: `${record.user_turn_id}/question_preparation/1`,
      status: preparation.status === "fallback" ? "degraded" : preparation.status === "error" ? "error" : preparation.status === "skipped" ? "skipped" : "completed",
      reason: preparation.reason, output: preparation.result ?? { mode: preparation.status === "fallback" ? "original_question_fallback" : preparation.status } };
  });
  // Keep actual stage names and the first failed preparation in the public trace.
  const preserved = pipelineTrace(record, input, before, after).preserved_failures;
  return { ...original, stages, preserved_failures: preserved };
}
