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
        "SELECT id,analyzed_content_revision,model,reviewer_version FROM review_runs WHERE workflow_id=$1 AND status='completed' ORDER BY finished_at DESC,id DESC LIMIT 1",
        [id],
      )
    ).rows[0];
    const open = (
      await tx.query(
        "SELECT id,title FROM discussion_threads WHERE workflow_id=$1 AND kind='finding' AND status='open' ORDER BY created_at,id",
        [id],
      )
    ).rows;
    return {
      board,
      issues: validateGraph(board),
      open_findings: open,
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
        await tx.query("SELECT * FROM frozen_specs WHERE workflow_id=$1", [id])
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
          "SELECT id,model,model_settings,reviewer_version,analyzed_content_revision,finished_at FROM review_runs WHERE workflow_id=$1 AND status='completed' ORDER BY finished_at,id",
          [id],
        )
      ).rows;
      const threads = (
        await tx.query(
          "SELECT * FROM discussion_threads WHERE workflow_id=$1 AND kind='finding' ORDER BY created_at,id",
          [id],
        )
      ).rows;
      const messages = (
        await tx.query(
          "SELECT m.* FROM discussion_messages m JOIN discussion_threads t ON t.id=m.thread_id WHERE m.workflow_id=$1 AND t.kind='finding' ORDER BY m.thread_id,m.message_number",
          [id],
        )
      ).rows;
      const anchors = (
        await tx.query(
          "SELECT a.* FROM thread_anchors a JOIN discussion_threads t ON t.id=a.thread_id WHERE a.workflow_id=$1 AND t.kind='finding' ORDER BY a.created_at,a.id",
          [id],
        )
      ).rows;
      const spec = (
        await tx.query(
          "INSERT INTO frozen_specs(workflow_id,source_content_revision,graph,review_evidence,unreviewed_changes_acknowledged) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            id,
            w.content_revision,
            ready.board,
            { reviews, threads, messages, anchors },
            ready.unreviewed_changes && data.acknowledge_unreviewed,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE workflows SET state='frozen',revision=revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      return spec;
    });
  }
}
