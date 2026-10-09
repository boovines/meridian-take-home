import { withRecoveryBudget } from "../server/repairs/recovery-budget";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DomainError } from "../domain/errors";
import type { ScheduleStep, RuntimeProjection } from "../domain/runtime";
import { RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime";
import { getDatabase } from "../server/database";
import { RunService } from "../server/runtime/run-service";
import { StepService } from "../server/runtime/step-service";
import { answerScriptedHuman as scriptedAnswer } from "../server/evaluations/scripted-human";
import { HumanService } from "../server/runtime/human-service";
import { invokeInSandbox } from "../server/integrations/sandbox-step";
import { extractForStep } from "../server/integrations/extraction";
import {
  reasonForStep,
  runtimeModelConfiguration,
} from "../server/integrations/openai-step";
export async function prepareExecution(id: string) {
  return new RunService(await getDatabase()).prepare(id);
}
export async function projectExecution(id: string, p: RuntimeProjection) {
  return new RunService(await getDatabase()).project(id, p);
}
export async function endExecution(
  id: string,
  result: Parameters<RunService["finish"]>[1],
) {
  return new RunService(await getDatabase()).finish(id, result);
}
export async function readHumanResponse(id: string) {
  return new HumanService(await getDatabase()).response(id);
}
export async function executeOccurrence(data: ScheduleStep, resume = false) {
  const timer = setInterval(
    () => heartbeat(),
    RUNTIME_HEARTBEAT_POLICY.interval_ms,
  );
  try {
    heartbeat();
    const db = await getDatabase();
    const scope = (
      await db.query("SELECT job_id FROM workflow_runs WHERE id=$1", [
        data.run_id,
      ])
    ).rows[0];
    if (!scope) throw new DomainError(404, "NOT_FOUND", "Run not found.");
    return await withRecoveryBudget(db, String(scope.job_id), () =>
      new StepService(db).execute(
        data,
        {
          invoke: invokeInSandbox,
          reason: reasonForStep,
          extract: extractForStep,
          model: runtimeModelConfiguration(),
        },
        AbortSignal.any([cancellationSignal(), AbortSignal.timeout(150000)]),
        resume,
      ),
    );
  } catch (error) {
    if (cancellationSignal().aborted) throw error;
    throw ApplicationFailure.create({
      message:
        error instanceof DomainError
          ? `${error.code}: ${error.message}`
          : "The execution worker failed.",
      type: error instanceof DomainError ? error.code : "ExecutionFailure",
      nonRetryable: error instanceof DomainError,
    });
  } finally {
    clearInterval(timer);
  }
}

export async function prepareCaseExecution(id: string) {
  return new RunService(await getDatabase()).prepareCase(id);
}
export async function endCaseExecution(
  id: string,
  result: Parameters<RunService["finish"]>[1],
) {
  return new RunService(await getDatabase()).finishCase(id, result);
}
export async function answerScriptedHuman(runId: string, id: string) {
  return scriptedAnswer(await getDatabase(), runId, id);
}

export async function checkRecoveryCandidate(runId: string) {
  const timer = setInterval(
    () => heartbeat(),
    RUNTIME_HEARTBEAT_POLICY.interval_ms,
  );
  try {
    const { checkRecoveryBuild } = await import(
      "../server/repairs/recovery-build"
    );
    const { validateInSandbox } = await import(
      "../server/integrations/sandbox-project"
    );
    return await checkRecoveryBuild(
      await getDatabase(),
      runId,
      validateInSandbox,
      AbortSignal.any([cancellationSignal(), AbortSignal.timeout(70000)]),
    );
  } finally {
    clearInterval(timer);
  }
}
