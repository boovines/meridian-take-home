import {
  proxyActivities,
  executeChild,
  isCancellation,
  CancellationScope,
  ActivityCancellationType,
  ChildWorkflowCancellationType,
  condition,
} from "@temporalio/workflow";
import type * as activities from "./evaluation-activities";
import { executeEvaluationCase } from "./execution-workflow";
import { RUNTIME_HEARTBEAT_POLICY } from "../domain/runtime-policy";
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
        const runCase = async (id: string, parallel = false) => {
          const task = await io.beginEvaluationCase(id);
          if (task.skip) return;
          try {
            if (task.kind === "workflow") {
              await executeChild(executeEvaluationCase, {
                workflowId: `execution-${task.run_id}`,
                args: [task.run_id],
                workflowIdReusePolicy: "REJECT_DUPLICATE",
                ...(parallel ? { cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED } : {}),
              });
              await io.scoreWorkflowCase(id);
            } else await heavy.evaluateStepCase(id);
          } catch (error) {
            if (isCancellation(error)) throw error;
            await io.failEvaluationCase(id);
          }
        };
        // Older activity results have no concurrency field. Their command order
        // remains unchanged on replay; new evaluations freeze their own setting.
        const concurrency = context.case_concurrency ?? 1;
        if (concurrency === 1) {
          for (const id of context.result_ids) await runCase(id);
        } else {
          const casesScope = new CancellationScope();
          await casesScope.run(async () => {
            let next = 0;
            let stopped = false;
            const lane = async () => {
              while (!stopped && next < context.result_ids.length) {
                const id = context.result_ids[next++];
                try {
                  await runCase(id, true);
                } catch (error) {
                  stopped = true;
                  casesScope.cancel();
                  throw error;
                }
              }
            };
            // Drain all active children before cleanup or a repair handoff.
            const lanes = await Promise.allSettled(Array.from(
              { length: Math.min(concurrency, context.result_ids.length) }, lane,
            ));
            const failures = lanes.filter(result => result.status === "rejected");
            const failure = failures.find(result => !isCancellation(result.reason)) ?? failures[0];
            if (failure) throw failure.reason;
          });
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
