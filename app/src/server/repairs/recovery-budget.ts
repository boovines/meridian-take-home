import { GroupedBudget } from "../grouped-execution/budget";
import { randomUUID } from "node:crypto";
import type { Database } from "../database";
import { DomainError } from "../../domain/errors";
import { workflow } from "../workflows/store";
import {
  withInferenceBudget,
  combineInferenceBudgets,
  type InferenceBudgetGuard,
} from "../integrations/inference-budget";

/** One durable ceiling for diagnosis, generation, reruns and regression calls. */
export class RecoveryBudget implements InferenceBudgetGuard {
  constructor(
    private db: Database,
    private sessionId: string,
  ) {}
  async reserve(
    provider: string,
    usd: number,
    metadata: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(usd) || usd <= 0)
      throw new Error("Positive finite reservation required.");
    signal?.throwIfAborted();
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      const scope = (
        await tx.query(
          "SELECT workflow_id FROM repair_sessions WHERE id=$1 AND origin='run'",
          [this.sessionId],
        )
      ).rows[0];
      if (!scope)
        throw new DomainError(
          409,
          "RECOVERY_INACTIVE",
          "Recovery session unavailable.",
        );
      await workflow(tx, String(scope.workflow_id), true);
      const row = (
        await tx.query(
          `SELECT s.status,s.recovery_limits,j.status AS job_status,j.deadline_at
        FROM repair_sessions s JOIN workflow_jobs j ON j.id=s.job_id WHERE s.id=$1`,
          [this.sessionId],
        )
      ).rows[0];
      if (
        row.status !== "running" ||
        row.job_status !== "running" ||
        new Date(String(row.deadline_at)).getTime() <= Date.now()
      )
        throw new DomainError(
          409,
          "RECOVERY_INACTIVE",
          "This recovery cannot start another paid request.",
        );
      const ceiling = Number(
        (row.recovery_limits as Record<string, unknown>).max_spend_usd,
      );
      const used = Number(
        (
          await tx.query(
            "SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) AS used FROM recovery_inference_charges WHERE session_id=$1",
            [this.sessionId],
          )
        ).rows[0].used,
      );
      if (
        !Number.isFinite(ceiling) ||
        ceiling <= 0 ||
        !Number.isFinite(used) ||
        used + usd > ceiling
      )
        throw new DomainError(
          503,
          "INFERENCE_BUDGET_LIMIT",
          "Recovery reached its reserved and recorded inference allowance. Inspect the retained attempts before starting further work.",
        );
      signal?.throwIfAborted();
      await tx.query(
        "INSERT INTO recovery_inference_charges(id,session_id,provider,reserved_usd,metadata) VALUES($1,$2,$3,$4,$5)",
        [id, this.sessionId, provider, usd, metadata],
      );
    });
    return {
      id,
      settle: async (actual: number, details: Record<string, unknown> = {}) => {
        if (!Number.isFinite(actual) || actual < 0)
          throw new Error("Invalid reported usage.");
        const updated = await this.db.query(
          "UPDATE recovery_inference_charges SET actual_usd=$2,state='settled',metadata=metadata || $3::jsonb WHERE id=$1 AND state='reserved' RETURNING id",
          [id, actual, JSON.stringify(details)],
        );
        if (!updated.rows.length)
          throw new Error("Reservation already settled or missing.");
      },
      annotate: async (details: Record<string, unknown>) => {
        await this.db.query(
          "UPDATE recovery_inference_charges SET metadata=metadata || $2::jsonb WHERE id=$1",
          [id, JSON.stringify(details)],
        );
      },
    };
  }
}

// Resolve through the durable job, including evaluations owned by recovery.
// Non-recovery activities retain their existing operator-budget behavior.
export async function withRecoveryBudget<T>(
  db: Database,
  jobId: string,
  work: () => Promise<T>,
) {
  const session = (
    await db.query(
      "SELECT id FROM repair_sessions WHERE job_id=$1 AND origin='run'",
      [jobId],
    )
  ).rows[0];
  const job = (
    await db.query(
      "SELECT id,kind,parent_job_id FROM workflow_jobs WHERE id=$1",
      [jobId],
    )
  ).rows[0];
  const parentId = job?.kind === "grouped" ? job.id : job?.parent_job_id;
  const parent = parentId ? new GroupedBudget(db, String(parentId)) : null;
  const recovery = session ? new RecoveryBudget(db, String(session.id)) : null;
  const budget =
    parent && recovery
      ? combineInferenceBudgets(parent, recovery)
      : (parent ?? recovery);
  return budget ? withInferenceBudget(budget, work) : work();
}
