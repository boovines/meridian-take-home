import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { getDatabase } from "../server/database";
import { GroupedCoordinator } from "../server/grouped-execution/coordinator";
import { groupedExecutionState } from "../server/grouped-execution/state";
import { GroupedExecutionService } from "../server/grouped-execution/service";
import { GmailCaptureService } from "../server/inputs/gmail-capture";
import { gmailReader } from "../server/integrations/composio-gmail";
import { DomainError } from "../domain/errors";
import { RunService } from "../server/runtime/run-service";
import { RepairService } from "../server/repairs/service";
import { jobById, JobService } from "../server/engineering/job-service";
export async function advanceGroupedExecution(id: string) {
  try {
    return await new GroupedCoordinator(await getDatabase()).advance(id);
  } catch (error) {
    if (error instanceof DomainError)
      throw ApplicationFailure.nonRetryable(error.message, error.code);
    throw error;
  }
}
export async function captureGroupedEmails(id: string) {
  const timer = setInterval(() => heartbeat(), 5000);
  try {
    heartbeat();
    const db = await getDatabase(),
      state = await groupedExecutionState(db, id);
    if (state.record.input_bundle_id) return;
    const signal = AbortSignal.any([
      cancellationSignal(),
      AbortSignal.timeout(120000),
    ]);
    const bundle = await new GmailCaptureService(
      db,
      gmailReader(),
    ).captureSelection(
      state.job.workflow_id,
      state.job.source_request.message_ids as string[],
      signal,
    );
    await new GroupedExecutionService(db).attachCapture(id, String(bundle.id));
  } finally {
    clearInterval(timer);
  }
}
export async function endGroupedExecution(
  id: string,
  reason: string,
  cancelled: boolean,
) {
  await new GroupedCoordinator(await getDatabase()).stop(id, reason, cancelled);
}
export async function endOwnedJob(id: string) {
  const db = await getDatabase(),
    job = await jobById(db, id);
  if (!job.parent_job_id)
    throw new Error("Only parent-owned jobs may use grouped cleanup.");
  if (job.kind === "execution")
    await new RunService(db).finish(id, { status: "cancelled", error: null });
  else if (job.kind === "repair")
    await new RepairService(db).finish(
      id,
      "cancelled",
      "The group input was superseded. Its history is retained.",
      "GROUP_SUPERSEDED",
    );
}

export async function fenceGroupedExecution(id: string) {
  const db = await getDatabase(),
    job = await jobById(db, id);
  if (job.kind !== "grouped") throw new Error("Expected a grouped parent.");
  await new JobService(db).requestCancel(job.workflow_id, id);
}
