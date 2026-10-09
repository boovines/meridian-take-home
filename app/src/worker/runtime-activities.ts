import { invocationFailure } from "../server/runtime/invoke-step";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DomainError } from "../domain/errors";
import type { ScheduleStep, RuntimeProjection } from "../domain/runtime";
import { RUNTIME_DEADLINE_POLICY, RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime-policy";
import { getDatabase } from "../server/database";
import { RunService } from "../server/runtime/run-service";
import { StepService } from "../server/runtime/step-service";
import { answerScriptedHuman as scriptedAnswer } from "../server/evaluations/scripted-human";
import { HumanService } from "../server/runtime/human-service";
import { invokeInSandbox } from "../server/integrations/sandbox-step";
import {
  reasonForStep,
  extractForStep,
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
  const deadline = AbortSignal.timeout(RUNTIME_DEADLINE_POLICY.step_ms);
  try {
    heartbeat();
    return await new StepService(await getDatabase()).execute(
      data,
      {
        invoke: invokeInSandbox,
        reason: reasonForStep,
        extract: extractForStep,
        model: runtimeModelConfiguration(),
      },
      AbortSignal.any([cancellationSignal(), deadline]),
      resume,
    );
  } catch (error) {
    if (cancellationSignal().aborted) throw error;
    if (deadline.aborted && !(error instanceof DomainError)) throw ApplicationFailure.nonRetryable(
      "The step exceeded its 12-minute execution allowance. No incomplete result was accepted; inspect its last recorded stage and reduce work per step.",
      "STEP_EXECUTION_TIMEOUT",
    );
    throw ApplicationFailure.create({
      message:
        error instanceof DomainError
          ? `${error.code}: ${error.message}`
          : "The execution worker failed.",
      type: error instanceof DomainError ? error.code : "ExecutionFailure",
      nonRetryable: error instanceof DomainError,
      details: [{ failure_category: error instanceof DomainError ? invocationFailure(error).category : "infrastructure" }],
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
