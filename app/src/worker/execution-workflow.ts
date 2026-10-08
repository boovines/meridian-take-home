import {
  proxyActivities,
  CancellationScope,
  isCancellation,
  ActivityCancellationType,
  defineSignal,
  setHandler,
  condition,
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";
import type * as activities from "./runtime-activities";
import { RuntimeEngine } from "../domain/runtime-engine";
import { RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime";
const io = proxyActivities<
  Pick<
    typeof activities,
    | "prepareExecution"
    | "prepareCaseExecution"
    | "answerScriptedHuman"
    | "projectExecution"
    | "readHumanResponse"
  >
>({ startToCloseTimeout: "15 seconds", retry: { maximumAttempts: 5 } });
const cleanup = proxyActivities<
  Pick<typeof activities, "endExecution" | "endCaseExecution">
>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});
const steps = proxyActivities<Pick<typeof activities, "executeOccurrence">>({
  startToCloseTimeout: "3 minutes",
  scheduleToCloseTimeout: "7 minutes",
  heartbeatTimeout: RUNTIME_HEARTBEAT_POLICY.timeout_ms,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2, initialInterval: "3 seconds" },
});
export const humanAnswered = defineSignal<[string]>("humanAnswered");
export async function executeWorkflow(jobId: string) {
  return executeCaptured(jobId);
}
export async function executeEvaluationCase(runId: string) {
  return executeCaptured("", runId);
}
async function executeCaptured(jobId: string, runId?: string) {
  const finish = (result: Parameters<typeof cleanup.endExecution>[1]) =>
    runId
      ? cleanup.endCaseExecution(runId, result)
      : cleanup.endExecution(jobId, result);
  const answered = new Set<string>();
  let changed = 0;
  setHandler(humanAnswered, (id) => {
    answered.add(id);
    changed++;
  });
  let engine: RuntimeEngine | undefined;
  let limit = false;
  try {
    const context = runId
      ? await io.prepareCaseExecution(runId)
      : await io.prepareExecution(jobId);
    if (!context) return;
    const scope = new CancellationScope();
    engine = new RuntimeEngine(context.run.id, context.definition, {
      now: () => Date.now(),
      scriptedHuman: !!runId,
      changed: () => {
        changed++;
      },
      rethrow: (error) => {
        if (isCancellation(error)) throw error;
      },
      describeFailure: (error) => {
        let cause: unknown = error;
        while (cause instanceof Error && "cause" in cause && cause.cause)
          cause = cause.cause;
        const type = cause instanceof ApplicationFailure ? cause.type : null;
        return {
          code: type || "RUNTIME_FAILED",
          message:
            cause instanceof Error
              ? cause.message.slice(0, 2000)
              : "The runtime worker failed.",
          category:
            type === "RUN_LIMIT" || type === "STEP_RETRY_LIMIT"
              ? "implementation"
              : type === "MISSING_HUMAN_FIXTURE"
                ? "input"
                : "infrastructure",
        };
      },
      project: (p) => io.projectExecution(context.run.id, p),
      step: (data, resume) => steps.executeOccurrence(data, resume),
      human: async (id, stopped) => {
        if (runId) {
          const response = await io.answerScriptedHuman(runId, id);
          if (!response.ok)
            throw ApplicationFailure.nonRetryable(
              response.message,
              "MISSING_HUMAN_FIXTURE",
            );
          return;
        }
        if ((await io.readHumanResponse(id)).status === "answered") return;
        await condition(() => answered.has(id) || stopped());
      },
    });
    let finished = false;
    await scope.run(async () => {
      const monitor = (async () => {
        while (!finished) {
          const revision = changed;
          if (engine!.isWaiting()) {
            await condition(() => finished || changed !== revision);
            continue;
          }
          const remaining = engine!.remaining();
          if (remaining <= 0) {
            limit = true;
            scope.cancel();
            return;
          }
          await condition(() => finished || changed !== revision, remaining);
        }
      })();
      // Cancellation can reject the monitor while an activity is still stopping.
      // Observe it immediately; awaiting the original promise in finally still
      // propagates its error through the workflow's normal cleanup handler.
      void monitor.catch(() => {});
      try {
        const result = await engine!.run();
        await finish(result);
      } finally {
        finished = true;
        changed++;
        await monitor;
      }
    });
  } catch (error) {
    const status = limit
      ? "needs_attention"
      : isCancellation(error)
        ? "cancelled"
        : "failed";
    const projection = engine?.projection();
    if (projection && engine)
      projection.active_elapsed_ms = engine.activeElapsed();
    await CancellationScope.nonCancellable(() =>
      finish({
        status,
        projection,
        error:
          status === "cancelled"
            ? null
            : {
                code: limit ? "RUN_LIMIT" : "RUNTIME_FAILED",
                message: limit
                  ? "The run reached its active execution time limit."
                  : "The runtime could not finish. Inspect step history and retry.",
                category: limit ? "implementation" : "infrastructure",
              },
      }),
    );
    if (!runId && !limit && !isCancellation(error)) throw error;
  }
}
