import {
  proxyActivities,
  executeChild,
  isCancellation,
  CancellationScope,
  ActivityCancellationType,
  condition,
} from "@temporalio/workflow";
import type * as activities from "./repair-activities";
import { evaluateSuite } from "./evaluation-workflow";
const io = proxyActivities<
  Pick<
    typeof activities,
    | "prepareRepair"
    | "beginRepairAttempt"
    | "createRepairEvaluation"
    | "decideRepairAttempt"
  >
>({ startToCloseTimeout: "15 seconds", retry: { maximumAttempts: 5 } });
const heavy = proxyActivities<
  Pick<typeof activities, "generateRepairCandidate">
>({
  startToCloseTimeout: "16 minutes",
  scheduleToCloseTimeout: "35 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2, initialInterval: "5 seconds" },
});
const cleanup = proxyActivities<Pick<typeof activities, "endRepair">>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});
export async function repairImplementation(jobId: string) {
  let expired = false;
  try {
    const context = await io.prepareRepair(jobId);
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
        for (let number = 1; number <= context.attempt_limit; number++) {
          const attemptId = await io.beginRepairAttempt(jobId, number);
          const generated = await heavy.generateRepairCandidate(attemptId);
          if (!generated.ready) {
            await cleanup.endRepair(
              jobId,
              "needs_attention",
              generated.reason,
              generated.code,
            );
            return;
          }
          const evaluationId = await io.createRepairEvaluation(attemptId);
          await executeChild(evaluateSuite, {
            workflowId: `repair-evaluation-${evaluationId}`,
            args: [jobId, evaluationId],
            workflowIdReusePolicy: "REJECT_DUPLICATE",
          });
          if ((await io.decideRepairAttempt(attemptId)).done) return;
        }
        await cleanup.endRepair(
          jobId,
          "needs_attention",
          "The three-attempt limit was reached.",
          "REPAIR_LIMIT",
        );
      } finally {
        finished = true;
        await monitor;
      }
    });
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      cleanup.endRepair(
        jobId,
        expired
          ? "needs_attention"
          : isCancellation(error)
            ? "cancelled"
            : "failed",
        expired
          ? "The repair session reached its two-hour limit. Inspect its retained attempts before starting another session."
          : isCancellation(error)
            ? "The repair session was cancelled. Its previous baseline and attempts remain available."
            : "The repair worker could not finish. Inspect the retained baseline and service access before starting another session.",
        expired
          ? "REPAIR_LIMIT"
          : isCancellation(error)
            ? "CANCELLED"
            : "REPAIR_INTERRUPTED",
      ),
    );
    if (!expired && !isCancellation(error)) throw error;
  }
}
