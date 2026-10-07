import type { WorkflowJob } from "../../domain/engineering";
import type { Database } from "../database";
import {
  startExecutionWorkflow,
  cancelGenerationWorkflow,
  temporalClient,
} from "../integrations/temporal";
export async function dispatchExecution(job: WorkflowJob) {
  if (!["queued", "cancel_requested"].includes(job.status)) return;
  try {
    await startExecutionWorkflow(job.id);
    if (job.status === "cancel_requested")
      await cancelGenerationWorkflow(job.id);
  } catch {
    console.warn(
      "Execution dispatch deferred; the worker will retry delivery.",
    );
  }
}
export async function deliverHumanAnswers(db: Database) {
  const rows = (
    await db.query(
      `SELECT h.id,r.job_id FROM human_requests h JOIN workflow_runs r ON r.id=h.run_id WHERE h.status='answered' AND h.delivered_at IS NULL AND r.status IN ('running','waiting_for_human') ORDER BY h.answered_at,h.id LIMIT 20`,
    )
  ).rows;
  for (const row of rows) {
    try {
      await (await temporalClient()).workflow
        .getHandle(`job-${row.job_id}`)
        .signal("humanAnswered", row.id);
      await db.query(
        "UPDATE human_requests SET delivered_at=now() WHERE id=$1 AND status='answered' AND delivered_at IS NULL",
        [row.id],
      );
    } catch {
      console.warn("Human response delivery will retry.");
    }
  }
}
