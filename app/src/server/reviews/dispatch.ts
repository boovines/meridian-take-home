import type { ReviewRun } from "../../domain/review";
import { getDatabase } from "../database";
import { ReviewService } from "./review-service";
import {
  startReviewWorkflow,
  cancelReviewWorkflow,
} from "../integrations/temporal";
export function fixtureReviews() {
  return (
    process.env.MERIDIAN_REVIEW_PROVIDER === "fixture" &&
    process.env.MERIDIAN_DATABASE === "local" &&
    process.env.MERIDIAN_LOCAL_DEMO === "true"
  );
}
export async function dispatchReview(run: ReviewRun) {
  if (run.status !== "queued" && run.status !== "running") return run;
  const reviews = new ReviewService(await getDatabase());
  if (fixtureReviews()) {
    const { fixtureReview } = await import("../../../tests/fixtures/reviewer");
    const input = await reviews.prepare(run.id);
    if (!input) return run;
    return reviews.publish(
      run.id,
      fixtureReview(
        input.board,
        input.discussion.threads.some((t) => t.kind === "finding"),
      ),
    );
  }
  try {
    await startReviewWorkflow(run.id);
    return run;
  } catch {
    return reviews.finish(
      run.id,
      "failed",
      "Could not start the review worker. Your draft is available; check the worker connection and try again.",
    );
  }
}
export async function cancelReview(runId: string) {
  const result = await new ReviewService(await getDatabase()).finish(
    runId,
    "cancelled",
  );
  // Database cancellation wins immediately; late worker results cannot publish.
  if (!fixtureReviews())
    try {
      await cancelReviewWorkflow(runId);
    } catch {
      console.warn(
        "Review cancelled locally; worker cancellation could not be delivered.",
      );
    }
  return result;
}
