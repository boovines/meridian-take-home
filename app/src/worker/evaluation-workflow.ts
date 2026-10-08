import {
  proxyActivities,
  executeChild,
  isCancellation,
  CancellationScope,
  ActivityCancellationType,
  condition,
} from "@temporalio/workflow";
import type * as activities from "./evaluation-activities";
import { executeEvaluationCase } from "./execution-workflow";
import { RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime";
const io = proxyActivities<
  Pick<
    typeof activities,
    | "prepareEvaluation"
    | "beginEvaluationCase"
    | "scoreWorkflowCase"
    | "failEvaluationCase"
  >
>({ startToCloseTimeout: "15 seconds", retry: { maximumAttempts: 5 } });
const heavy = proxyActivities<
  Pick<typeof activities, "checkEvaluationBuild" | "evaluateStepCase">
>({
  startToCloseTimeout: "3 minutes",
  scheduleToCloseTimeout: "7 minutes",
  heartbeatTimeout: RUNTIME_HEARTBEAT_POLICY.timeout_ms,
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2, initialInterval: "3 seconds" },
});
const cleanup = proxyActivities<Pick<typeof activities, "endEvaluation">>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});
export async function evaluateSuite(jobId: string, evaluationId?: string) {
  let expired = false;
  try {
    const context = await io.prepareEvaluation(jobId, evaluationId);
    if (!context) return;
    const scope = new CancellationScope();
    let finished = false;
    await scope.run(async () => {
      const monitor = (async () => {
        const remaining = Math.max(
          0,
          new Date(context.deadline_at).getTime() - Date.now(),
        );
        if (remaining === 0 || !(await condition(() => finished, remaining))) {
          expired = true;
          scope.cancel();
        }
      })();
      // Cancellation can reject the monitor while an activity is still stopping.
      // Observe it immediately; awaiting the original promise in finally still
      // propagates its error through the workflow's normal cleanup handler.
      void monitor.catch(() => {});
      try {
        const build = await heavy.checkEvaluationBuild(context.evaluation_id);
        if (!build.ok) {
          await cleanup.endEvaluation(jobId, build.error, false, evaluationId);
          return;
        }
        for (const id of context.result_ids) {
          const task = await io.beginEvaluationCase(id);
          if (task.skip) continue;
          try {
            if (task.kind === "workflow") {
              await executeChild(executeEvaluationCase, {
                workflowId: `execution-${task.run_id}`,
                args: [task.run_id],
                workflowIdReusePolicy: "REJECT_DUPLICATE",
              });
              await io.scoreWorkflowCase(id);
            } else await heavy.evaluateStepCase(id);
          } catch (error) {
            if (isCancellation(error)) throw error;
            await io.failEvaluationCase(id);
          }
        }
        await cleanup.endEvaluation(jobId, undefined, false, evaluationId);
      } finally {
        finished = true;
        await monitor;
      }
    });
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      cleanup.endEvaluation(
        jobId,
        expired
          ? {
              code: "EVALUATION_LIMIT",
              message:
                "The suite reached the operation time limit. Remaining cases were not accepted as passes.",
              category: "infrastructure",
            }
          : isCancellation(error)
            ? undefined
            : {
                code: "EVALUATION_INTERRUPTED",
                message:
                  "The evaluation worker could not finish the full suite. Inspect case history and retry.",
                category: "infrastructure",
              },
        !expired && isCancellation(error),
        evaluationId,
      ),
    );
    if (!evaluationId && !expired && !isCancellation(error)) throw error;
  }
}
