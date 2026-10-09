import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { getDatabase } from "../server/database";
import { ReviewService } from "../server/reviews/review-service";
import { reviewWithOpenAI } from "../server/integrations/openai-reviewer";
import { DomainError } from "../domain/errors";
import { REVIEW_CONTEXT_TOO_LARGE_MESSAGE } from "../server/reviews/review-context";
export async function performReview(id: string) {
  const reviews = new ReviewService(await getDatabase());
  const pulse = setInterval(() => heartbeat(), 5000);
  try {
    heartbeat();
    const input = await reviews.prepare(id);
    if (!input) return;
    const output = await reviewWithOpenAI(
      input,
      AbortSignal.any([cancellationSignal(), AbortSignal.timeout(90000)]),
    );
    await reviews.publish(id, output);
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === "REVIEW_CONTEXT_TOO_LARGE"
    ) {
      await reviews.finish(id, "failed", REVIEW_CONTEXT_TOO_LARGE_MESSAGE);
      return;
    }
    if (
      error instanceof DomainError &&
      ["REVIEW_INACTIVE", "REVIEW_EXPIRED"].includes(error.code)
    )
      return;
    // Do not put provider requests, prompts, or customer data in Temporal failure messages.
    throw ApplicationFailure.create({
      message: "Review could not complete.",
      type: "ReviewFailure",
      nonRetryable: error instanceof DomainError,
      details:
        error instanceof DomainError ? [{ code: error.code }] : undefined,
    });
  } finally {
    clearInterval(pulse);
  }
}
export async function endReview(id: string, status: "cancelled" | "failed") {
  await new ReviewService(await getDatabase()).finish(
    id,
    status,
    status === "failed"
      ? "Review could not finish. Your board is unchanged; try again."
      : undefined,
  );
}
