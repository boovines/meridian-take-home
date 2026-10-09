import type { Board, CanvasNode, Connection } from "../../domain/canvas";
import type { ReviewRun, DiscussionThread } from "../../domain/review";
import type { Queryable } from "../database";
import { appendMessage, reviewRecord } from "../reviews/discussion-store";

// Seed during preparation so the reviewer can follow up on stable real findings.
// Repeat at publication as a backstop; the source key/thread link is authoritative.
export async function carryScopingQuestions(
  tx: Queryable,
  run: ReviewRun,
  board: Board,
) {
  const pending = (
    await tx.query(
      "SELECT * FROM scoping_obligations WHERE workflow_id=$1 AND thread_id IS NULL ORDER BY source_key",
      [run.workflow_id],
    )
  ).rows;
  for (const item of pending) {
    const anchors = item.anchors as {
      nodes: CanvasNode[];
      connections: Connection[];
    };
    const hadTargets = anchors.nodes.length + anchors.connections.length > 0;
    const liveNodes = anchors.nodes.filter((n) =>
      board.nodes.some((b) => b.id === n.id),
    );
    const liveEdges = anchors.connections.filter((c) =>
      board.connections.some((b) => b.id === c.id),
    );
    const deleted = hadTargets && !liveNodes.length && !liveEdges.length;
    const thread = reviewRecord<DiscussionThread>(
      (
        await tx.query(
          "INSERT INTO discussion_threads(workflow_id,kind,title,scope,origin_review_run_id,finding_category) VALUES($1,'finding',$2,$3,$4,'missing_behavior') RETURNING *",
          [
            run.workflow_id,
            String(item.question).slice(0, 300),
            hadTargets ? "elements" : "workflow",
            run.id,
          ],
        )
      ).rows[0],
    );
    for (const n of anchors.nodes)
      await tx.query(
        "INSERT INTO thread_anchors(workflow_id,thread_id,node_id,context_snapshot) VALUES($1,$2,$3,$4)",
        [run.workflow_id, thread.id, n.id, n],
      );
    for (const c of anchors.connections)
      await tx.query(
        "INSERT INTO thread_anchors(workflow_id,thread_id,connection_id,context_snapshot) VALUES($1,$2,$3,$4)",
        [run.workflow_id, thread.id, c.id, c],
      );
    await appendMessage(tx, thread, {
      author: "ai",
      body: `Carried forward from workflow scoping: ${item.question}\n\nRecord a decision and incorporate any required behavior into the workflow before freezing.`,
      requestKey: `scope:${item.id}`,
      reviewId: run.id,
    });
    if (deleted) {
      const reason =
        "All referenced items were deleted before review. The original scoping question is retained for context.";
      await tx.query(
        "UPDATE discussion_threads SET status='closed',resolution_kind='target_deleted',resolution_note=$2,closed_at=now() WHERE id=$1",
        [thread.id, reason],
      );
      await appendMessage(tx, thread, {
        author: "system",
        body: reason,
        requestKey: `scope-deleted:${item.id}`,
        event: { action: "target_deleted" },
      });
    }
    await tx.query("UPDATE scoping_obligations SET thread_id=$2 WHERE id=$1", [
      item.id,
      thread.id,
    ]);
  }
}
export async function scopingFreezeEvidence(tx: Queryable, workflowId: string) {
  const row = (
    await tx.query(
      "SELECT applied_preview_id,applied_content_revision,applied_at,applied_element_ids FROM scoping_sessions WHERE workflow_id=$1 AND applied_preview_id IS NOT NULL",
      [workflowId],
    )
  ).rows[0];
  if (!row) return null;
  const preview = (
    await tx.query(
      "SELECT id,scope_id,note_revision,data FROM scoping_versions WHERE id=$1",
      [row.applied_preview_id],
    )
  ).rows[0];
  const scope = (
    await tx.query("SELECT id,data FROM scoping_versions WHERE id=$1", [
      preview.scope_id,
    ])
  ).rows[0];
  const obligations = (
    await tx.query(
      "SELECT source_key,question,anchors,thread_id FROM scoping_obligations WHERE workflow_id=$1 ORDER BY source_key",
      [workflowId],
    )
  ).rows;
  return { ...row, preview, scope, obligations };
}
