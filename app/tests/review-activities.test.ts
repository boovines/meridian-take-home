import { beforeEach, expect, it, vi } from "vitest";
import { DomainError } from "../src/domain/errors";
import { REVIEW_CONTEXT_TOO_LARGE_MESSAGE } from "../src/server/reviews/review-context";
const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  finish: vi.fn(),
  publish: vi.fn(),
  review: vi.fn(),
}));
vi.mock("../src/server/database", () => ({ getDatabase: async () => ({}) }));
vi.mock("../src/server/reviews/review-service", () => ({
  ReviewService: class {
    prepare = mocks.prepare;
    finish = mocks.finish;
    publish = mocks.publish;
  },
}));
vi.mock("../src/server/integrations/openai-reviewer", () => ({
  reviewWithOpenAI: mocks.review,
}));
vi.mock("@temporalio/activity", () => ({
  heartbeat: vi.fn(),
  cancellationSignal: () => new AbortController().signal,
}));
import { performReview } from "../src/worker/review-activities";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockResolvedValue({});
});
it("ends oversized reviews with the safe specific message instead of retrying unchanged input", async () => {
  mocks.review.mockRejectedValue(
    new DomainError(
      413,
      "REVIEW_CONTEXT_TOO_LARGE",
      "private diagnostic must not leak",
    ),
  );
  await performReview("review-id");
  expect(mocks.finish).toHaveBeenCalledExactlyOnceWith(
    "review-id",
    "failed",
    REVIEW_CONTEXT_TOO_LARGE_MESSAGE,
  );
  expect(mocks.publish).not.toHaveBeenCalled();
});
it("keeps unexpected failures retryable without exposing provider or customer details", async () => {
  mocks.review.mockRejectedValue(new Error("private provider payload"));
  await expect(performReview("review-id")).rejects.toMatchObject({
    message: "Review could not complete.",
    nonRetryable: false,
  });
  expect(mocks.finish).not.toHaveBeenCalled();
});
