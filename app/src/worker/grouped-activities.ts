import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { getDatabase } from "../server/database";
import { GroupedCoordinator } from "../server/grouped-execution/coordinator";
import { groupedExecutionState } from "../server/grouped-execution/state";
import { GroupedGmailCapture } from "../server/inputs/grouped-gmail-capture";
import { CAPTURE_LIMITS } from "../domain/gmail-capture";
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
      AbortSignal.timeout(CAPTURE_LIMITS.attempt_ms),
    ]);
    await new GroupedGmailCapture(db, gmailReader()).capture(id, signal);
  } catch (error) {
    if (error instanceof DomainError)
      throw ApplicationFailure.create({
        message: error.message,
        type: error.code,
        nonRetryable: [
          "GMAIL_AUTH_REQUIRED",
          "GMAIL_NOT_CONFIGURED",
          "GMAIL_DOWNLOAD_HOST",
          "GMAIL_MESSAGE_CHANGED",
          "CAPTURE_TOO_LARGE",
          "PARENT_INACTIVE",
          "GROUP_CANCELLED",
        ].includes(error.code),
      });
    if (error instanceof Error && error.name === "TimeoutError")
      throw ApplicationFailure.create({
        message:
          "Email capture reached its time limit. Completed downloads are retained; try fewer emails if the automatic retry also fails.",
        type: "GMAIL_CAPTURE_TIMEOUT",
      });
    throw error;
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
      "This child operation was cancelled. Its history is retained.",
      "GROUP_CHILD_CANCELLED",
    );
}

export async function fenceGroupedExecution(id: string) {
  const db = await getDatabase(),
    job = await jobById(db, id);
  if (job.kind !== "grouped") throw new Error("Expected a grouped parent.");
  await new JobService(db).requestCancel(job.workflow_id, id);
}
