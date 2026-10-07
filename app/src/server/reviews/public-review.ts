import type { ReviewRun } from "../../domain/review";
import { DomainError } from "../../domain/canvas";
import { getDatabase } from "../database";
export function publicReview(run: ReviewRun) {
  const { initial_snapshot, analyzed_snapshot, ...summary } = run;
  void initial_snapshot;
  void analyzed_snapshot;
  return summary;
}
export async function requireReview(workflowId: string, reviewId: string) {
  if (
    !(
      await (
        await getDatabase()
      ).query("SELECT id FROM review_runs WHERE id=$1 AND workflow_id=$2", [
        reviewId,
        workflowId,
      ])
    ).rows.length
  )
    throw new DomainError(
      404,
      "NOT_FOUND",
      "Review not found on this workflow.",
    );
}
