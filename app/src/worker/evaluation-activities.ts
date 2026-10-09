import { finishEvaluationWithRepair } from "../server/evaluations/automatic-repair";
import { startRepairWorkflow } from "../server/integrations/temporal";
import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { getDatabase } from "../server/database";
import { DomainError } from "../domain/errors";
import type { RuntimeError } from "../domain/runtime";
import { RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime-policy";
import { EvaluationService } from "../server/evaluations/evaluation-service";
import { EvaluationExecutionService } from "../server/evaluations/execution-service";
import { validateInSandbox } from "../server/integrations/sandbox-project";
import { invokeInSandbox } from "../server/integrations/sandbox-step";
import {
  reasonForStep,
  extractForStep,
  runtimeModelConfiguration,
} from "../server/integrations/openai-step";
export async function prepareEvaluation(id: string, evaluationId?: string) {
  const context = await new EvaluationService(await getDatabase()).prepare(
    id,
    evaluationId,
  );
  return context
    ? {
        evaluation_id: context.evaluation.id,
        deadline_at: context.deadline_at,
        result_ids: context.results.map((r) => r.id),
      }
    : null;
}
export async function beginEvaluationCase(id: string) {
  return new EvaluationService(await getDatabase()).beginCase(id);
}
export async function scoreWorkflowCase(id: string) {
  return new EvaluationExecutionService(await getDatabase()).workflow(id);
}
export async function endEvaluation(
  id: string,
  error?: RuntimeError,
  cancelled = false,
  evaluationId?: string,
) {
  const next = await finishEvaluationWithRepair(
    await getDatabase(),
    id,
    error,
    cancelled,
    evaluationId,
  );
  if (next && ["queued", "cancel_requested"].includes(next.status)) await startRepairWorkflow(next.id);
}
export async function checkEvaluationBuild(
  id: string,
): Promise<{ ok: true } | { ok: false; error: RuntimeError }> {
  const pulse = setInterval(
    () => heartbeat(),
    RUNTIME_HEARTBEAT_POLICY.interval_ms,
  );
  try {
    heartbeat();
    await new EvaluationExecutionService(await getDatabase()).build(
      id,
      validateInSandbox,
      AbortSignal.any([cancellationSignal(), AbortSignal.timeout(70000)]),
    );
    return { ok: true };
  } catch (error) {
    if (cancellationSignal().aborted) throw error;
    const implementation =
      error instanceof DomainError && error.code === "PROJECT_BUILD_FAILED";
    // Only the isolated compiler's bounded diagnostic belongs in repair evidence.
    // Provider errors may include private request details and are not code failures.
    const diagnostic =
      implementation &&
      error.details !== null &&
      typeof error.details === "object" &&
      "diagnostic" in error.details &&
      typeof error.details.diagnostic === "string"
        ? error.details.diagnostic.slice(0, 2400)
        : "";
    return {
      ok: false,
      error: {
        code:
          error instanceof DomainError ? error.code : "BUILD_CHECK_UNAVAILABLE",
        message:
          error instanceof DomainError
            ? error.message + (diagnostic ? `\n${diagnostic}` : "")
            : "The isolated build check could not run.",
        category: implementation ? "implementation" : "infrastructure",
      },
    };
  } finally {
    clearInterval(pulse);
  }
}
export async function evaluateStepCase(id: string) {
  const pulse = setInterval(
    () => heartbeat(),
    RUNTIME_HEARTBEAT_POLICY.interval_ms,
  );
  try {
    heartbeat();
    await new EvaluationExecutionService(await getDatabase()).step(
      id,
      {
        invoke: invokeInSandbox,
        reason: reasonForStep,
        extract: extractForStep,
        model: runtimeModelConfiguration(),
      },
      AbortSignal.any([cancellationSignal(), AbortSignal.timeout(150000)]),
    );
  } finally {
    clearInterval(pulse);
  }
}

export async function failEvaluationCase(id: string) {
  return new EvaluationService(await getDatabase()).recordCase(id, {
    error: {
      code: "CASE_EXECUTION_ERROR",
      message:
        "This case's worker could not finish. Other independent cases can still run.",
      category: "infrastructure",
    },
  });
}
