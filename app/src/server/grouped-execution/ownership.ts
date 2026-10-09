import type { Queryable } from "../database";
import type { WorkflowJob } from "../../domain/engineering";
import { DomainError } from "../../domain/errors";
import { jobById } from "../engineering/job-service";
export async function activeGroupParent(
  tx: Queryable,
  parentId: string,
  workflowId: string,
  planId: string,
) {
  const parent = await jobById(tx, parentId);
  if (
    parent.kind !== "grouped" ||
    parent.parent_job_id ||
    parent.workflow_id !== workflowId ||
    parent.plan_version_id !== planId
  )
    throw new DomainError(
      422,
      "INVALID_PARENT_OPERATION",
      "Child work must use the grouped operation’s approved plan.",
    );
  if (
    !["queued", "running", "waiting_for_human"].includes(parent.status) ||
    new Date(parent.deadline_at).getTime() <= Date.now()
  )
    throw new DomainError(
      409,
      "PARENT_INACTIVE",
      "The grouped operation no longer accepts work.",
    );
  return parent;
}
export async function assertJobParentActive(tx: Queryable, job: WorkflowJob) {
  if (job.parent_job_id)
    await activeGroupParent(
      tx,
      job.parent_job_id,
      job.workflow_id,
      job.plan_version_id,
    );
}
