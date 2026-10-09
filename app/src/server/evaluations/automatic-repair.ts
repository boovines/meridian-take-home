import type { Database } from "../database";
import type { RuntimeError } from "../../domain/runtime";
import type { WorkflowJob } from "../../domain/engineering";
import { DomainError } from "../../domain/errors";
import { repairBlocker } from "../../domain/repair";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { RepairService } from "../repairs/service";
import { EvaluationService, evaluationById, resultsByEvaluation } from "./evaluation-service";

/** Finish the initial evaluation and reserve its optional repair atomically.
 * Dispatch happens after commit; retrying returns the same queued repair job.
 * Candidate evaluations never start another session or reset the attempt limit.
 */
export async function finishEvaluationWithRepair(
  db: Database,
  jobId: string,
  error?: RuntimeError,
  cancelled = false,
  evaluationId?: string,
): Promise<WorkflowJob | null> {
  return db.transaction(async tx => {
    const owner = await jobById(tx, jobId);
    await workflow(tx, owner.workflow_id, true);
    const job = await jobById(tx, jobId);
    await new EvaluationService(db).finishInTransaction(tx, job, error, cancelled, evaluationId);
    const source = job.source_request;
    if (evaluationId || job.kind !== "evaluation" || !source || typeof source !== "object" || Array.isArray(source) || source.auto_repair !== true) return null;
    const initial = (await tx.query("SELECT id FROM evaluation_runs WHERE job_id=$1 AND run_key='initial'", [jobId])).rows[0];
    if (!initial) return null;
    // A replay after commit must deliver the existing handoff, never create another.
    const prior = (await tx.query("SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND kind='repair' AND request_key=$2", [job.workflow_id, initial.id])).rows[0];
    if (prior) return prior as unknown as WorkflowJob;
    const finished = await evaluationById(tx, String(initial.id));
    if (cancelled || job.status === "cancel_requested" || finished.status === "cancelled" || finished.verdict === "passed") return null;
    let blocker = repairBlocker(finished, await resultsByEvaluation(tx, finished.id));
    if (!blocker) {
      try {
        return (await new RepairService(db).startInTransaction(tx, job.workflow_id, {
          request_key: finished.id,
          baseline_evaluation_id: finished.id,
        })).job;
      } catch (e) {
        // These checks run before inserts. Operational/database failures must roll
        // back and retry instead of losing the durable handoff.
        if (!(e instanceof DomainError) || !["SUITE_CHANGED", "SUITE_NOT_LOCKED", "PLAN_NOT_APPROVED"].includes(e.code)) throw e;
        blocker = e.message;
      }
    }
    await tx.query("UPDATE workflow_jobs SET status='failed',phase='automatic repair needs attention',error_code='AUTO_REPAIR_BLOCKED',error_message=$2,updated_at=now() WHERE id=$1", [jobId, blocker]);
    return null;
  });
}
