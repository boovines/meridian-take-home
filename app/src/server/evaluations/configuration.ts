import { EXTRACTION_BATCH_POLICY, extractionInstructions } from "../../domain/extraction";
import { EVALUATION_RECOVERY_POLICY } from "../../domain/evaluation-recovery";
import { isDeepStrictEqual } from "node:util";
import { runtimeModelConfiguration } from "../integrations/openai-step";
import { DomainError } from "../../domain/errors";
import {
  DEMO_LIMITS,
  type Json,
} from "../../domain/runtime";
import { RUNTIME_DEADLINE_POLICY, RUNTIME_HEARTBEAT_POLICY, EVALUATION_SCHEDULING_POLICY } from "../../domain/runtime-policy";
import { openAITokenPreflightPolicy } from "../integrations/openai-preflight";
/** Snapshot non-secret execution settings. Generated prompts/schemas are fixed by the immutable code version. */
export function evaluationConfiguration(): Json {
  return {
    contract_version: 1,
    deadlines: { ...RUNTIME_DEADLINE_POLICY },
    case_recovery: JSON.parse(JSON.stringify(EVALUATION_RECOVERY_POLICY)),
    runtime: runtimeModelConfiguration(),
    extraction: { provider: "openai", instructions: extractionInstructions, batching: { ...EXTRACTION_BATCH_POLICY } },
    limits: { ...DEMO_LIMITS },
    activity_heartbeat: { ...RUNTIME_HEARTBEAT_POLICY },
    scheduling: { ...EVALUATION_SCHEDULING_POLICY },
    fresh_extraction: true,
    inference_preflight:
      process.env.INFERENCE_BUDGET_LEDGER || process.env.INFERENCE_BUDGET_USD
        ? JSON.parse(JSON.stringify(openAITokenPreflightPolicy))
        : null,
  };
}
export function assertEvaluationConfiguration(recorded: Json) {
  const current = evaluationConfiguration() as Record<string, Json>;
  // Historical evaluations did not record scheduling and ran sequentially.
  // Preserve that behavior across retries and all rounds of a confirmation.
  if (recorded && typeof recorded === "object" && !Array.isArray(recorded) && !("scheduling" in recorded)) delete current.scheduling;
  if (recorded && typeof recorded === "object" && !Array.isArray(recorded) && !("case_recovery" in recorded)) delete current.case_recovery;
  if (!isDeepStrictEqual(recorded, current))
    throw new DomainError(
      409,
      "EVALUATION_CONFIGURATION_CHANGED",
      "Execution settings changed. Stop this sequence and inspect the retained results before evaluating a new configuration.",
    );
}

export function evaluationCaseConcurrency(recorded: Json): number {
  assertEvaluationConfiguration(recorded);
  return recorded && typeof recorded === "object" && !Array.isArray(recorded) && "scheduling" in recorded
    ? EVALUATION_SCHEDULING_POLICY.case_concurrency : 1;
}
