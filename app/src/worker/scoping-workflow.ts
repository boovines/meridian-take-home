import {
  proxyActivities,
  CancellationScope,
  isCancellation,
} from "@temporalio/workflow";
import type * as activities from "./scoping-activities";
const { performScoping } = proxyActivities<
  Pick<typeof activities, "performScoping">
>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "4 minutes",
  heartbeatTimeout: "20 seconds",
  retry: { maximumAttempts: 2, initialInterval: "2 seconds" },
});
const { endScoping } = proxyActivities<Pick<typeof activities, "endScoping">>({
  startToCloseTimeout: "15 seconds",
  retry: { maximumAttempts: 3 },
});
export async function scopeWorkflow(id: string) {
  try {
    await performScoping(id);
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      endScoping(id, isCancellation(error) ? "cancelled" : "failed"),
    );
    throw error;
  }
}
