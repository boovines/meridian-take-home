import type { Database } from "../server/database";
import type { WorkflowJob } from "../domain/engineering";
import { dispatchOperation } from "../server/workflows/dispatch";
import { deliverHumanAnswers } from "../server/runtime/dispatch";
import { JobService } from "../server/engineering/job-service";
import { ReviewService } from "../server/reviews/review-service";
import { startReviewWorkflow } from "../server/integrations/temporal";

// Queue rows are durable dispatch intents. Temporal owns execution/retries; this
// process only delivers stable IDs, so duplicate delivery never starts two runs.
export async function deliverOutbox(db: Database) {
  const expired = await db.query(
    "SELECT * FROM workflow_jobs WHERE kind='generation' AND status IN ('queued','running','cancel_requested') AND deadline_at<now() ORDER BY deadline_at,id LIMIT 20",
  );
  for (const row of expired.rows) {
    const job = row as unknown as WorkflowJob;
    await new JobService(db).finish(job.id, "failed", {
      code: "JOB_EXPIRED",
      message:
        "The operation exceeded its time limit. Start a new generation when the worker is available.",
    });
  }
  const jobs = await db.query(
    "SELECT * FROM workflow_jobs WHERE kind IN ('generation','execution') AND status IN ('queued','cancel_requested') ORDER BY created_at,id LIMIT 20",
  );
  for (const row of jobs.rows)
    await dispatchOperation(row as unknown as WorkflowJob);
  await deliverHumanAnswers(db);
  const reviews = await db.query(
    "SELECT id,deadline_at FROM review_runs WHERE status='queued' ORDER BY created_at LIMIT 20",
  );
  for (const review of reviews.rows) {
    if (new Date(String(review.deadline_at)).getTime() < Date.now())
      await new ReviewService(db).finish(
        String(review.id),
        "failed",
        "The review expired before the worker could complete it. Try again.",
      );
    else await startReviewWorkflow(String(review.id));
  }
}
export function startOutbox(db: Database) {
  let pending = false;
  const poll = async () => {
    if (pending) return;
    pending = true;
    try {
      await deliverOutbox(db);
    } catch {
      console.warn("Dispatch reconciliation will retry.");
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => {
    void poll();
  }, 5000);
  void poll();
  return () => clearInterval(timer);
}
