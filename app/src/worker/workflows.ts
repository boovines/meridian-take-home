import {
  proxyActivities,
  CancellationScope,
  isCancellation,
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
