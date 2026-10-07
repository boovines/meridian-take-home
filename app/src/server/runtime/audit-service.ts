import type { AuditEvent, RecordAudit } from "../../domain/execution-audit";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { workflow } from "../workflows/store";

type AuditOwner =
  | { step_execution_id: string; case_result_id?: never }
  | { case_result_id: string; step_execution_id?: never };
export class ExecutionAuditService {
  constructor(
    private db: Database,
    private artifacts = new ArtifactService(db),
  ) {}

  recorder(workflowId: string, owner: AuditOwner, token: string): RecordAudit {
    let sequence = 0;
    const started = Date.now();
    return async (kind, payload, summary = {}) => {
      const bytes = Buffer.from(JSON.stringify(payload ?? null));
      if (bytes.length > 2_000_000)
        throw new DomainError(
          503,
          "AUDIT_UNAVAILABLE",
          "The execution audit payload exceeds its 2 MB limit.",
        );
      try {
        const artifact = await this.artifacts.create(
          workflowId,
          "trace",
          `${kind}.json`,
          "application/json",
          bytes,
        );
        await this.db.transaction(async (tx) => {
          // Use the same workflow lock as publication/cancellation. SQL also
          // checks invocation ownership, so late responses cannot append evidence.
          await workflow(tx, workflowId, true);
          await tx.query(
            "INSERT INTO execution_audit_events(workflow_id,step_execution_id,case_result_id,attempt_token,sequence,kind,artifact_id,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
            [
              workflowId,
              owner.step_execution_id ?? null,
              owner.case_result_id ?? null,
              token,
              ++sequence,
              kind,
              artifact.id,
              { ...summary, elapsed_ms: Date.now() - started },
            ],
          );
        });
      } catch {
        throw new DomainError(
          503,
          "AUDIT_UNAVAILABLE",
          "The execution audit could not be saved. No unrecorded model call will be started.",
        );
      }
    };
  }

  async list(workflowId: string, owner: AuditOwner): Promise<AuditEvent[]> {
    await workflow(this.db, workflowId);
    return (
      await this.db.query(
        `SELECT * FROM execution_audit_events WHERE workflow_id=$1 AND ${owner.step_execution_id ? "step_execution_id" : "case_result_id"}=$2 ORDER BY created_at,sequence`,
        [workflowId, owner.step_execution_id ?? owner.case_result_id],
      )
    ).rows as unknown as AuditEvent[];
  }

  async read(workflowId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM execution_audit_events WHERE workflow_id=$1 AND id=$2",
        [workflowId, id],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Execution audit event not found on this workflow.",
      );
    const { bytes } = await this.artifacts.read(
      workflowId,
      String(row.artifact_id),
    );
    return {
      event: row as unknown as AuditEvent,
      payload: JSON.parse(bytes.toString("utf8")) as unknown,
    };
  }
}
