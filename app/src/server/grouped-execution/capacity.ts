import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "../database";
import { DomainError } from "../../domain/errors";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { activeGroupParent } from "./ownership";
/** A human response may wake several child workflows at once. Acquire shared
 * capacity immediately before heavy work, not just when dispatching a child. */
export async function withGroupedCapacity<T>(
  db: Database,
  parentId: string,
  jobId: string,
  work: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const token = randomUUID();
  while (true) {
    signal.throwIfAborted();
    const acquired = await db.transaction(async (tx) => {
      const job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      await activeGroupParent(
        tx,
        parentId,
        job.workflow_id,
        job.plan_version_id,
      );
      if (
        (job.parent_job_id !== parentId &&
          !(job.id === parentId && job.kind === "grouped")) ||
        !["queued", "running", "waiting_for_human"].includes(job.status)
      )
        throw new DomainError(
          409,
          "GROUP_CHILD_INACTIVE",
          "This child no longer accepts work.",
        );
      await tx.query(
        "DELETE FROM grouped_activity_leases WHERE parent_job_id=$1 AND expires_at<=now()",
        [parentId],
      );
      const limit = Number(
        (
          (
            await tx.query(
              "SELECT limits FROM grouped_executions WHERE job_id=$1",
              [parentId],
            )
          ).rows[0].limits as { concurrent_children: number }
        ).concurrent_children,
      );
      const active = Number(
        (
          await tx.query(
            "SELECT count(*) AS n FROM grouped_activity_leases WHERE parent_job_id=$1",
            [parentId],
          )
        ).rows[0].n,
      );
      if (!Number.isFinite(limit) || limit < 1)
        throw new DomainError(
          503,
          "GROUP_CAPACITY_INVALID",
          "The saved execution capacity is invalid.",
        );
      if (active >= limit) return false;
      signal.throwIfAborted();
      await tx.query(
        "INSERT INTO grouped_activity_leases(token,parent_job_id,job_id,expires_at) VALUES($1,$2,$3,now()+interval '60 seconds')",
        [token, parentId, jobId],
      );
      return true;
    });
    if (acquired) break;
    await delay(250, undefined, { signal });
  }
  const lost = new AbortController(),
    combined = AbortSignal.any([signal, lost.signal]);
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void db
      .query(
        "UPDATE grouped_activity_leases SET expires_at=now()+interval '60 seconds' WHERE token=$1 AND expires_at>now() RETURNING token",
        [token],
      )
      .then(
        (result) => {
          if (!result.rows.length)
            lost.abort(new Error("Grouped execution capacity lease expired."));
        },
        () =>
          lost.abort(
            new Error("Grouped execution capacity could not be renewed."),
          ),
      )
      .finally(() => {
        renewing = false;
      });
  }, 5000);
  try {
    const value = await work(combined);
    combined.throwIfAborted();
    return value;
  } finally {
    clearInterval(timer);
    await db.query("DELETE FROM grouped_activity_leases WHERE token=$1", [
      token,
    ]);
  }
}
