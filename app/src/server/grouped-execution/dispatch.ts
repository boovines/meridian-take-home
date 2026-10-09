import type { WorkflowJob } from "../../domain/engineering";
import {
  startGroupedWorkflow,
  cancelGenerationWorkflow,
} from "../integrations/temporal";
export async function dispatchGrouped(job: WorkflowJob) {
  if (!["queued", "cancel_requested"].includes(job.status)) return;
  try {
    await startGroupedWorkflow(job.id);
    if (job.status === "cancel_requested")
      await cancelGenerationWorkflow(job.id);
  } catch {
    console.warn(
      "Selected-email dispatch deferred; the worker will retry delivery.",
    );
  }
}
