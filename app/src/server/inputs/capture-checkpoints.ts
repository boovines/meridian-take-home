import type { GmailMessage } from "../../domain/gmail";
import {
  CAPTURE_LIMITS,
  type CaptureProgress,
} from "../../domain/gmail-capture";
import { DomainError } from "../../domain/errors";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { activeGroupParent } from "../grouped-execution/ownership";
export type CaptureItem = {
  key: string;
  ref: { artifact_id: string; message_id: string; name: string };
} & (
  | { kind: "message"; data: GmailMessage & { source_artifact_id: string } }
  | {
      kind: "document";
      data: {
        artifact_id: string;
        message_id: string;
        name: string;
        media_type: string;
        byte_size: number;
        sha256: string;
        capture_status: "ready" | "unavailable";
        capture_error?: { code: string; reason: string };
      };
    }
);
export class CaptureCheckpoints {
  constructor(
    private db: Database,
    private jobId: string,
  ) {}
  async owner(tx: Queryable) {
    let job = await jobById(tx, this.jobId);
    await workflow(tx, job.workflow_id, true);
    job = await jobById(tx, this.jobId);
    if (["cancel_requested", "cancelled"].includes(job.status))
      throw new DomainError(
        409,
        "GROUP_CANCELLED",
        "The selected-email operation was cancelled.",
      );
    await activeGroupParent(tx, job.id, job.workflow_id, job.plan_version_id);
    return job;
  }
  async read() {
    return this.db.transaction(async (tx) => {
      const job = await this.owner(tx);
      const items = (
        await tx.query(
          "SELECT payload FROM grouped_capture_items WHERE job_id=$1",
          [this.jobId],
        )
      ).rows.map((r) => r.payload as CaptureItem);
      const bundle = (
        await tx.query(
          "SELECT b.* FROM grouped_executions g JOIN input_bundles b ON b.id=g.input_bundle_id WHERE g.job_id=$1",
          [this.jobId],
        )
      ).rows[0];
      return { job, items, bundle };
    });
  }
  async save(item: CaptureItem) {
    return this.db.transaction(async (tx) => {
      const job = await this.owner(tx);
      if (item.kind === "document") {
        const stored = (
          await tx.query(
            "SELECT payload FROM grouped_capture_items WHERE job_id=$1",
            [this.jobId],
          )
        ).rows.map((r) => r.payload as CaptureItem);
        const bytes = stored
          .filter((i) => i.kind === "document")
          .reduce((n, i) => n + i.data.byte_size, 0);
        if (
          !stored.some((i) => i.key === item.key) &&
          bytes + item.data.byte_size > CAPTURE_LIMITS.bytes
        )
          throw new DomainError(
            413,
            "CAPTURE_TOO_LARGE",
            "This packet exceeds 50 MB. Select fewer emails.",
          );
      }
      await tx.query(
        "INSERT INTO grouped_capture_items(workflow_id,job_id,source_key,artifact_id,payload) VALUES($1,$2,$3,$4,$5) ON CONFLICT(job_id,source_key) DO NOTHING",
        [job.workflow_id, this.jobId, item.key, item.ref.artifact_id, item],
      );
      return (
        await tx.query(
          "SELECT payload FROM grouped_capture_items WHERE job_id=$1 AND source_key=$2",
          [this.jobId, item.key],
        )
      ).rows[0].payload as CaptureItem;
    });
  }
  async progress() {
    return this.db.transaction(async (tx) => {
      const job = await this.owner(tx);
      const items = (
        await tx.query(
          "SELECT payload FROM grouped_capture_items WHERE job_id=$1",
          [this.jobId],
        )
      ).rows.map((r) => r.payload as CaptureItem);
      const messages = items.filter((i) => i.kind === "message"),
        documents = items.filter((i) => i.kind === "document");
      const warnings = documents.flatMap((i) =>
        i.data.capture_error
          ? [
              {
                message_id: i.data.message_id,
                name: i.data.name,
                reason: i.data.capture_error.reason,
              },
            ]
          : [],
      );
      const progress: CaptureProgress = {
        messages_total: (job.source_request.message_ids as string[]).length,
        messages_completed: messages.length,
        attachments_total: messages.reduce(
          (n, m) => n + m.data.attachments.length,
          0,
        ),
        attachments_completed: documents.length - warnings.length,
        attachments_unavailable: warnings.length,
        warnings,
      };
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='capturing email sources',started_at=coalesce(started_at,now()),progress=progress || $2::jsonb,updated_at=now() WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM grouped_executions WHERE job_id=$1 AND input_bundle_id IS NOT NULL)",
        [this.jobId, { capture: progress }],
      );
      return progress;
    });
  }
}
