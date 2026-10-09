import type { Queryable } from "../database";
// Extend only by durable human waiting time; retries and answers do not renew
// the active-time allowance or the attempt budget.
export async function pauseRecoveryClock(
  tx: Queryable,
  jobId: string,
  waiting: boolean,
) {
  if (waiting) {
    await tx.query(
      "UPDATE repair_sessions SET paused_at=coalesce(paused_at,now()) WHERE job_id=$1 AND origin='run' AND status='running'",
      [jobId],
    );
  } else {
    await tx.query(
      "UPDATE workflow_jobs j SET deadline_at=j.deadline_at+(now()-s.paused_at) FROM repair_sessions s WHERE s.job_id=j.id AND j.id=$1 AND s.origin='run' AND s.status='running' AND s.paused_at IS NOT NULL",
      [jobId],
    );
    await tx.query(
      "UPDATE repair_sessions SET paused_at=NULL WHERE job_id=$1 AND origin='run' AND status='running' AND paused_at IS NOT NULL",
      [jobId],
    );
  }
}
