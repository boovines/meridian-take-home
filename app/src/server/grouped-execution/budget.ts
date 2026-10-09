import { randomUUID } from "node:crypto";
import type { Database } from "../database";
import { DomainError } from "../../domain/errors";
import type { InferenceBudgetGuard } from "../integrations/inference-budget";
import { workflow } from "../workflows/store";
import { activeGroupParent } from "./ownership";
import { jobById } from "../engineering/job-service";
/** One durable parent allowance includes grouping, children, repair and grading. */
export class GroupedBudget implements InferenceBudgetGuard {
  constructor(
    private db: Database,
    private jobId: string,
  ) {}
  async reserve(
    provider: string,
    usd: number,
    metadata: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(usd) || usd <= 0)
      throw new Error("Positive finite reservation required.");
    const id = randomUUID();
    signal?.throwIfAborted();
    await this.db.transaction(async (tx) => {
      const job = await jobById(tx, this.jobId);
      await workflow(tx, job.workflow_id, true);
      await activeGroupParent(tx, job.id, job.workflow_id, job.plan_version_id);
      const row = (
        await tx.query(
          "SELECT limits FROM grouped_executions WHERE job_id=$1",
          [job.id],
        )
      ).rows[0];
      const ceiling = Number(
        (row?.limits as { spend_usd: number } | undefined)?.spend_usd,
      );
      const used = Number(
        (
          await tx.query(
            "SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) AS used FROM grouped_inference_charges WHERE parent_job_id=$1",
            [job.id],
          )
        ).rows[0].used,
      );
      if (
        !Number.isFinite(ceiling) ||
        !Number.isFinite(used) ||
        ceiling <= 0 ||
        used + usd > ceiling
      )
        throw new DomainError(
          503,
          "INFERENCE_BUDGET_LIMIT",
          "The selected-email operation reached its shared inference allowance. Retained reservations survive restarts.",
        );
      signal?.throwIfAborted();
      await tx.query(
        "INSERT INTO grouped_inference_charges(id,parent_job_id,provider,reserved_usd,metadata) VALUES($1,$2,$3,$4,$5)",
        [id, job.id, provider, usd, metadata],
      );
    });
    return {
      id,
      settle: async (actual: number, details: Record<string, unknown> = {}) => {
        if (!Number.isFinite(actual) || actual < 0)
          throw new Error("Invalid reported usage.");
        const rows = await this.db.query(
          "UPDATE grouped_inference_charges SET actual_usd=$2,state='settled',metadata=metadata || $3::jsonb WHERE id=$1 AND state='reserved' RETURNING id",
          [id, actual, JSON.stringify(details)],
        );
        if (!rows.rows.length)
          throw new Error("Reservation already settled or missing.");
      },
      annotate: async (details: Record<string, unknown>) => {
        await this.db.query(
          "UPDATE grouped_inference_charges SET metadata=metadata || $2::jsonb WHERE id=$1",
          [id, JSON.stringify(details)],
        );
      },
    };
  }
}
