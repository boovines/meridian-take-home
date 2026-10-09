import {
  proxyActivities,
  startChild,
  CancellationScope,
  isCancellation,
  ActivityCancellationType,
  condition,
  getExternalWorkflowHandle,
  ParentClosePolicy,
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";
import type * as activities from "./grouped-activities";
import { executeWorkflow } from "./execution-workflow";
import { repairImplementation } from "./repair-workflow";
const io = proxyActivities<
  Pick<typeof activities, "advanceGroupedExecution" | "endOwnedJob">
>({ startToCloseTimeout: "20 seconds", retry: { maximumAttempts: 5 } });
const capture = proxyActivities<
  Pick<typeof activities, "captureGroupedEmails">
>({
  startToCloseTimeout: "3 minutes",
  scheduleToCloseTimeout: "7 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2 },
});
const cleanup = proxyActivities<
  Pick<typeof activities, "endGroupedExecution" | "fenceGroupedExecution">
>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});
export async function executeGroupedEmails(id: string) {
  const started = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  try {
    while (true) {
      const tick = await io.advanceGroupedExecution(id);
      if (tick.done) return;
      if (tick.capture) {
        await capture.captureGroupedEmails(id);
        continue;
      }
      for (const child of tick.cancel) {
        if (started.has(child))
          await getExternalWorkflowHandle(`job-${child}`).cancel();
        await io.endOwnedJob(child);
      }
      for (const child of tick.start) {
        if (started.has(child.id)) continue;
        const handle = await startChild(
          child.kind === "repair" ? repairImplementation : executeWorkflow,
          {
            workflowId: `job-${child.id}`,
            args: [child.id],
            workflowIdReusePolicy: "REJECT_DUPLICATE",
            parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
          },
        );
        started.add(child.id);
        // Each worker persists its terminal result even if its Temporal execution
        // fails. A sibling failure never cancels independent work.
        const settled = handle
          .result()
          .then(
            () => {},
            () => {},
          )
          .finally(() => pending.delete(child.id));
        pending.set(child.id, settled);
      }
      await condition(() => false, 1000);
    }
  } catch (error) {
    let cause: unknown = error;
    while (cause instanceof Error && "cause" in cause && cause.cause)
      cause = cause.cause;
    const code = cause instanceof ApplicationFailure ? cause.type : null;
    const cancelled = isCancellation(error) || code === "GROUP_CANCELLED";
    await CancellationScope.nonCancellable(async () => {
      await cleanup.fenceGroupedExecution(id);
      const children = [...pending.entries()];
      for (const [child] of children) {
        try {
          await getExternalWorkflowHandle(`job-${child}`).cancel();
        } catch {
          /* already terminal */
        }
      }
      await Promise.all(children.map(([, settled]) => settled));
      await cleanup.endGroupedExecution(
        id,
        cancelled
          ? "The selected-email operation was cancelled. Completed results remain available."
          : code === "GROUP_TIME_LIMIT"
            ? "The selected-email operation reached its shared active-time limit. Completed results remain available."
            : "The selected-email operation could not continue. Inspect the retained group and source history.",
        cancelled,
      );
    });
    if (!cancelled) throw error;
  }
}
