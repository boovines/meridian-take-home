import { scopingFreezeEvidence } from "../scoping/review-obligations";
import { createHandoffPlan } from "../process-revisions/plan-handoff";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { freezeInput } from "../../domain/review";
import { validateGraph } from "../../domain/validate-graph";
import type { Database, Queryable } from "../database";
import { workflow, editable, readBoard } from "../workflows/store";
export class FreezeService {
  constructor(private db: Database) {}
  private async inspect(tx: Queryable, id: string) {
    const board = await readBoard(tx, id);
    const review = (
      await tx.query(
        "SELECT id,analyzed_content_revision,model,reviewer_version FROM review_runs WHERE workflow_id=$1 AND process_version=(SELECT process_version FROM workflows WHERE id=$1) AND status='completed' AND analyzed_content_revision >= coalesce((SELECT applied_content_revision FROM scoping_sessions WHERE workflow_id=$1),0) ORDER BY finished_at DESC,id DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const open = (
      await tx.query(
        "SELECT id,title FROM discussion_threads WHERE workflow_id=$1 AND process_version=(SELECT process_version FROM workflows WHERE id=$1) AND kind='finding' AND status='open' ORDER BY created_at,id",
        [id],
      )
    ).rows;
    const requests = (
      await tx.query(
        "SELECT t.id,t.title FROM engineer_change_requests r JOIN discussion_threads t ON t.id=r.thread_id WHERE r.workflow_id=$1 AND r.target_process_version=$2 AND t.status='open'",
        [id, board.workflow.process_version],
      )
    ).rows;
    const pending = (await tx.query("SELECT id,question AS title FROM scoping_obligations WHERE workflow_id=$1 AND thread_id IS NULL", [id])).rows;
    return {
      board,
      issues: validateGraph(board),
      open_findings: [...open, ...requests, ...pending],
      completed_review_id: review?.id || null,
      unreviewed_changes:
        !!review &&
        Number(review.analyzed_content_revision) !==
          board.workflow.content_revision,
    };
  }
  async readiness(id: string) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, id, true);
      return this.inspect(tx, id);
    });
  }
  async freeze(id: string, data: z.infer<typeof freezeInput>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      const existing = (
        await tx.query(
          "SELECT * FROM frozen_specs WHERE workflow_id=$1 AND version_number=$2",
          [id, w.process_version],
        )
      ).rows[0];
      if (existing) return existing;
      editable(w);
      if (w.content_revision !== data.expected_content_revision)
        throw new DomainError(
          409,
          "STALE_FREEZE",
          "The draft changed. Review the updated handoff checklist before freezing.",
        );
      const ready = await this.inspect(tx, id);
      if (
        !ready.completed_review_id ||
        ready.open_findings.length ||
        ready.issues.length
      )
        throw new DomainError(
          422,
          "NOT_READY",
          "Resolve the remaining findings and structural issues before freezing.",
          ready,
        );
      if (ready.unreviewed_changes && !data.acknowledge_unreviewed)
        throw new DomainError(
          409,
          "UNREVIEWED_CHANGES",
          "The process changed after its last review. Review it again or explicitly acknowledge these changes.",
          ready,
        );
      const reviews = (
        await tx.query(
          "SELECT id,model,model_settings,reviewer_version,analyzed_content_revision,finished_at FROM review_runs WHERE workflow_id=$1 AND process_version=(SELECT process_version FROM workflows WHERE id=$1) AND status='completed' ORDER BY finished_at,id",
          [id],
        )
      ).rows;
      const threads = (
        await tx.query(
          "SELECT * FROM discussion_threads WHERE workflow_id=$1 AND ((process_version=(SELECT process_version FROM workflows WHERE id=$1) AND kind='finding') OR id IN (SELECT thread_id FROM engineer_change_requests WHERE workflow_id=$1 AND target_process_version=(SELECT process_version FROM workflows WHERE id=$1))) ORDER BY created_at,id",
          [id],
        )
      ).rows;
      const messages = (
        await tx.query(
          "SELECT m.* FROM discussion_messages m JOIN discussion_threads t ON t.id=m.thread_id WHERE m.workflow_id=$1 AND ((t.process_version=(SELECT process_version FROM workflows WHERE id=$1) AND t.kind='finding') OR t.id IN (SELECT thread_id FROM engineer_change_requests WHERE workflow_id=$1 AND target_process_version=(SELECT process_version FROM workflows WHERE id=$1))) ORDER BY m.thread_id,m.message_number",
          [id],
        )
      ).rows;
      const anchors = (
        await tx.query(
          "SELECT a.* FROM thread_anchors a JOIN discussion_threads t ON t.id=a.thread_id WHERE a.workflow_id=$1 AND ((t.process_version=(SELECT process_version FROM workflows WHERE id=$1) AND t.kind='finding') OR t.id IN (SELECT thread_id FROM engineer_change_requests WHERE workflow_id=$1 AND target_process_version=(SELECT process_version FROM workflows WHERE id=$1))) ORDER BY a.created_at,a.id",
          [id],
        )
      ).rows;
      const requests = (
        await tx.query(
          "SELECT * FROM engineer_change_requests WHERE workflow_id=$1 AND target_process_version=$2",
          [id, w.process_version],
        )
      ).rows;
      const spec = (
        await tx.query(
          "INSERT INTO frozen_specs(workflow_id,source_content_revision,graph,review_evidence,unreviewed_changes_acknowledged,version_number,parent_frozen_spec_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            id,
            w.content_revision,
            ready.board,
            { reviews, threads, messages, anchors, requests, scoping: await scopingFreezeEvidence(tx, id) },
            ready.unreviewed_changes && data.acknowledge_unreviewed,
            w.process_version,
            w.base_frozen_spec_id,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE workflows SET state='frozen',current_frozen_spec_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",
        [id, spec.id],
      );
      await tx.query(
        "UPDATE engineer_change_requests SET resulting_frozen_spec_id=$3 WHERE workflow_id=$1 AND target_process_version=$2 AND resulting_frozen_spec_id IS NULL",
        [id, w.process_version, spec.id],
      );
      if (w.base_frozen_spec_id)
        await createHandoffPlan(
          tx,
          id,
          String(spec.id),
          ready.board,
          w.base_frozen_spec_id,
        );
      return spec;
    });
  }
}
