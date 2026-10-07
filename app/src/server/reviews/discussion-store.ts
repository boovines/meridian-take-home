import type { Queryable } from "../database";
import { DomainError } from "../../domain/errors";
import type {
  DiscussionThread,
  DiscussionMessage,
  ReviewRun,
} from "../../domain/review";
export function reviewRecord<T>(row: Record<string, unknown>): T {
  const result = { ...row };
  for (const key of [
    "revision",
    "message_number",
    "proposed_node_revision",
    "started_content_revision",
    "analyzed_content_revision",
  ])
    if (result[key] != null) result[key] = Number(result[key]);
  return result as T;
}
export async function threadById(
  tx: Queryable,
  workflowId: string,
  id: string,
): Promise<DiscussionThread> {
  const row = (
    await tx.query(
      "SELECT * FROM discussion_threads WHERE workflow_id=$1 AND id=$2 FOR UPDATE",
      [workflowId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Comment thread not found.");
  return reviewRecord(row);
}
export async function appendMessage(
  tx: Queryable,
  thread: DiscussionThread,
  data: {
    author: "customer" | "ai" | "system";
    body: string;
    requestKey: string;
    parent?: string | null;
    event?: Record<string, unknown>;
    reviewId?: string;
  },
) {
  const previous = (
    await tx.query(
      "SELECT * FROM discussion_messages WHERE thread_id=$1 AND request_key=$2",
      [thread.id, data.requestKey],
    )
  ).rows[0];
  if (previous) return reviewRecord<DiscussionMessage>(previous);
  if (
    data.parent &&
    !(
      await tx.query(
        "SELECT id FROM discussion_messages WHERE thread_id=$1 AND id=$2",
        [thread.id, data.parent],
      )
    ).rows.length
  )
    throw new DomainError(
      422,
      "INVALID_REPLY",
      "Reply to an existing message in this thread.",
    );
  const row = (
    await tx.query(
      `INSERT INTO discussion_messages(workflow_id,thread_id,message_number,parent_message_id,author_kind,kind,body,event_data,source_review_run_id,request_key)
    VALUES($1,$2,(SELECT coalesce(max(message_number),0)+1 FROM discussion_messages WHERE thread_id=$2),$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        thread.workflow_id,
        thread.id,
        data.parent || null,
        data.author,
        data.event ? "event" : "comment",
        data.body,
        data.event || null,
        data.reviewId || null,
        data.requestKey,
      ],
    )
  ).rows[0];
  await tx.query(
    "UPDATE discussion_threads SET revision=revision+1,updated_at=now() WHERE id=$1",
    [thread.id],
  );
  return reviewRecord<DiscussionMessage>(row);
}
export async function terminateReview(
  tx: Queryable,
  run: ReviewRun,
  status: "completed" | "cancelled" | "failed",
  errorCode?: string,
  message?: string,
) {
  await tx.query(
    "UPDATE review_runs SET status=$2,error_code=$3,error_message=$4,finished_at=now(),deadline_at=NULL WHERE id=$1",
    [run.id, status, errorCode || null, message || null],
  );
  const clarification = (
    await tx.query(
      "SELECT * FROM discussion_threads WHERE origin_review_run_id=$1 AND kind='clarification' FOR UPDATE",
      [run.id],
    )
  ).rows[0];
  if (clarification) {
    const thread = reviewRecord<DiscussionThread>(clarification);
    await appendMessage(tx, thread, {
      author: "system",
      body: `Review ${status}.`,
      requestKey: `terminal:${run.id}`,
      event: { action: status },
    });
    await tx.query(
      "UPDATE discussion_threads SET status='closed',closed_at=now(),updated_at=now() WHERE id=$1",
      [thread.id],
    );
  }
  await tx.query(
    "UPDATE workflows SET state='draft',active_review_run_id=NULL,updated_at=now() WHERE id=$1 AND active_review_run_id=$2",
    [run.workflow_id, run.id],
  );
}
export async function closeDeletedNodeFindings(
  tx: Queryable,
  workflowId: string,
  nodeId: string,
) {
  const rows = (
    await tx.query(
      `SELECT t.* FROM discussion_threads t JOIN thread_anchors a ON a.thread_id=t.id
    WHERE t.workflow_id=$1 AND t.kind='finding' AND t.status='open' AND a.node_id=$2
    AND (SELECT count(*) FROM thread_anchors all_anchors WHERE all_anchors.thread_id=t.id)=1 FOR UPDATE OF t`,
      [workflowId, nodeId],
    )
  ).rows;
  for (const row of rows) {
    const thread = reviewRecord<DiscussionThread>(row);
    const reason = "The only referenced block was removed by the customer.";
    await appendMessage(tx, thread, {
      author: "system",
      body: reason,
      requestKey: `deleted:${nodeId}`,
      event: { action: "target_deleted", node_id: nodeId },
    });
    await tx.query(
      "UPDATE discussion_threads SET status='closed',resolution_kind='target_deleted',resolution_note=$2,closed_at=now(),updated_at=now() WHERE id=$1",
      [thread.id, reason],
    );
  }
}
