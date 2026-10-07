import {
  proxyActivities,
  CancellationScope,
  isCancellation,
  ActivityCancellationType,
} from "@temporalio/workflow";
import type * as activities from "./activities";
const { performReview } = proxyActivities<
  Pick<typeof activities, "performReview">
>({
  startToCloseTimeout: "2 minutes",
  scheduleToCloseTimeout: "4 minutes",
  heartbeatTimeout: "20 seconds",
  retry: { maximumAttempts: 2, initialInterval: "2 seconds" },
});
const { endReview } = proxyActivities<Pick<typeof activities, "endReview">>({
  startToCloseTimeout: "15 seconds",
  retry: { maximumAttempts: 3 },
});
export async function reviewDraft(reviewId: string): Promise<void> {
  try {
    await performReview(reviewId);
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      endReview(reviewId, isCancellation(error) ? "cancelled" : "failed"),
    );
    throw error;
  }
}

const { generateImplementation } = proxyActivities<
  Pick<typeof activities, "generateImplementation">
>({
  startToCloseTimeout: "16 minutes",
  scheduleToCloseTimeout: "35 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2, initialInterval: "5 seconds" },
});
const { endGeneration } = proxyActivities<
  Pick<typeof activities, "endGeneration">
>({ startToCloseTimeout: "15 seconds", retry: { maximumAttempts: 5 } });
export async function generateAgent(id: string): Promise<void> {
  try {
    await generateImplementation(id);
  } catch (error) {
    await CancellationScope.nonCancellable(() =>
      endGeneration(id, isCancellation(error) ? "cancelled" : "failed"),
    );
    throw error;
  }
}

export { executeWorkflow } from "./execution-workflow";
