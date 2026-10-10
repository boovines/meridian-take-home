import { DomainError } from "../../domain/errors";
import {
  draftRequest,
  previewFromOutput,
  type DraftRecord,
  type DraftState,
  type GmailDraftWriter,
} from "../../domain/gmail-drafts";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";

export class GmailDraftService {
  constructor(
    private db: Database,
    private writer: GmailDraftWriter,
  ) {}
  async configure(wid: string, enabled: boolean) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      await tx.query(
        "INSERT INTO gmail_draft_settings(workflow_id,enabled) VALUES($1,$2) ON CONFLICT(workflow_id) DO UPDATE SET enabled=$2,updated_at=now()",
        [wid, enabled],
      );
      return { enabled };
    });
  }
  private async enabled(tx: Queryable, wid: string) {
    return (
      (
        await tx.query(
          "SELECT enabled FROM gmail_draft_settings WHERE workflow_id=$1",
          [wid],
        )
      ).rows[0]?.enabled === true
    );
  }
  private async source(tx: Queryable, wid: string, rid: string) {
    const row = (
      await tx.query(
        `SELECT r.kind,r.status,r.id,r.input_bundle_id,b.source_kind,b.manifest,s.output_data,j.source_request
      FROM workflow_runs r JOIN input_bundles b ON b.id=r.input_bundle_id JOIN workflow_jobs j ON j.id=r.job_id
      LEFT JOIN step_executions s ON s.id=r.result_step_id AND s.run_id=r.id
      WHERE r.workflow_id=$1 AND r.id=$2`,
        [wid, rid],
      )
    ).rows[0];
    if (!row) throw new DomainError(404, "NOT_FOUND", "Run not found.");
    const manifest = row.manifest as {
      input?: { messages?: { id?: unknown }[] };
      message_ids?: unknown[];
    };
    const messages = manifest.input?.messages;
    const preview = previewFromOutput(row.output_data);
    const messageId = messages?.length === 1 ? messages[0]?.id : undefined;
    const mode = (row.source_request as { execution_mode?: string })
      ?.execution_mode;
    if (
      (mode && mode !== "workflow") ||
      row.status !== "completed" ||
      !preview ||
      typeof messageId !== "string" ||
      messageId.length === 0
    )
      return null;
    return { ...preview, messageId: row.source_kind === "gmail" ? messageId : `bundle:${row.input_bundle_id}` };
  }
  private async existing(tx: Queryable, wid: string, message: string) {
    return (
      await tx.query(
        `SELECT state,draft_id,recipient,subject,body FROM gmail_drafts
      WHERE workflow_id=$1 AND account_id=$2 AND message_id=$3`,
        [wid, this.writer.account, message],
      )
    ).rows[0] as unknown as DraftRecord | undefined;
  }
  async state(wid: string, rid: string): Promise<DraftState> {
    const enabled = await this.enabled(this.db, wid);
    const source = await this.source(this.db, wid, rid);
    if (!source)
      return {
        enabled,
        eligible: false,
        reason:
          "Gmail drafts require a completed run with one message and an email preview.",
        draft: null,
      };
    return {
      enabled,
      eligible: true,
      reason: null,
      draft: (await this.existing(this.db, wid, source.messageId)) ?? null,
    };
  }
  async create(wid: string, rid: string, raw: unknown): Promise<DraftRecord> {
    const { recipient } = draftRequest.parse(raw);
    const reservation = await this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      if (!(await this.enabled(tx, wid)))
        throw new DomainError(
          409,
          "DRAFTS_DISABLED",
          "Enable Gmail drafts for this workflow first.",
        );
      const source = await this.source(tx, wid, rid);
      if (!source)
        throw new DomainError(
          409,
          "DRAFT_NOT_ELIGIBLE",
          "Only completed single-message previews can create Gmail drafts.",
        );
      const existing = await this.existing(tx, wid, source.messageId);
      if (existing) {
        if (
          existing.recipient !== recipient ||
          existing.subject !== source.subject ||
          existing.body !== source.body
        )
          throw new DomainError(
            409,
            "DRAFT_ALREADY_REQUESTED",
            "A draft was already requested for this email with different contents. Check Gmail before making changes.",
          );
        return { existing };
      }
      const record = (
        await tx.query(
          `INSERT INTO gmail_drafts(workflow_id,run_id,account_id,message_id,subject,body,recipient,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,'creating') RETURNING id`,
          [
            wid,
            rid,
            this.writer.account,
            source.messageId,
            source.subject,
            source.body,
            recipient,
          ],
        )
      ).rows[0];
      return { id: record.id, source };
    });
    if (reservation.existing) return reservation.existing;
    const id = reservation.id;
    try {
      // No provider retries: a lost response could still have created the draft.
      const draftId = await this.writer.create(
        { ...reservation.source!, recipient },
        AbortSignal.timeout(25000),
      );
      const row = (
        await this.db.query(
          `UPDATE gmail_drafts SET state='created',draft_id=$2,updated_at=now() WHERE id=$1 RETURNING state,draft_id,recipient,subject,body`,
          [id, draftId],
        )
      ).rows[0];
      return row as unknown as DraftRecord;
    } catch {
      await this.db.query(
        "UPDATE gmail_drafts SET state='uncertain',updated_at=now() WHERE id=$1 AND state='creating'",
        [id],
      );
      throw new DomainError(
        502,
        "DRAFT_UNCERTAIN",
        "Gmail did not confirm draft creation. Check Gmail Drafts and the connection; this request will not be repeated automatically.",
      );
    }
  }
}
