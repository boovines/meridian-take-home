import { ReplyService } from "./reply-service";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { CanvasNode } from "../../domain/canvas";
import {
  detailPatch,
  type DiscussionThread,
  type findingAction,
  type messageInput,
  type noteInput,
} from "../../domain/review";
import type { Database } from "../database";
import {
  workflow,
  editable,
  expectRevision,
  record,
  readBoard,
} from "../workflows/store";
import { threadById, appendMessage, reviewRecord } from "./discussion-store";
export class FindingService {
  constructor(private db: Database) {}
  async reply(
    workflowId: string,
    threadId: string,
    data: z.infer<typeof messageInput>,
  ) {
    return new ReplyService(this.db).reply(workflowId, threadId, data);
  }
  async note(workflowId: string, data: z.infer<typeof noteInput>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, workflowId, true);
      const existing = (
        await tx.query(
          "SELECT * FROM discussion_threads WHERE workflow_id=$1 AND creation_key=$2",
          [workflowId, data.request_key],
        )
      ).rows[0];
      if (existing) return reviewRecord<DiscussionThread>(existing);
      editable(w);
      const board = await readBoard(tx, workflowId),
        nodes = [...new Set(data.node_ids)],
        connections = [...new Set(data.connection_ids)];
      if (
        nodes.some((id) => !board.nodes.some((n) => n.id === id)) ||
        connections.some((id) => !board.connections.some((c) => c.id === id))
      )
        throw new DomainError(
          422,
          "INVALID_ANCHOR",
          "Choose active blocks and connections on this workflow.",
        );
      const thread = reviewRecord<DiscussionThread>(
        (
          await tx.query(
            "INSERT INTO discussion_threads(workflow_id,kind,title,scope,creation_key) VALUES($1,'note',$2,$3,$4) RETURNING *",
            [
              workflowId,
              data.title,
              nodes.length || connections.length ? "elements" : "workflow",
              data.request_key,
            ],
          )
        ).rows[0],
      );
      for (const id of nodes)
        await tx.query(
          "INSERT INTO thread_anchors(workflow_id,thread_id,node_id,context_snapshot) VALUES($1,$2,$3,$4)",
          [workflowId, thread.id, id, board.nodes.find((n) => n.id === id)],
        );
      for (const id of connections)
        await tx.query(
          "INSERT INTO thread_anchors(workflow_id,thread_id,connection_id,context_snapshot) VALUES($1,$2,$3,$4)",
          [
            workflowId,
            thread.id,
            id,
            board.connections.find((c) => c.id === id),
          ],
        );
      await appendMessage(tx, thread, {
        author: "customer",
        body: data.body,
        requestKey: data.request_key,
      });
      return threadById(tx, workflowId, thread.id);
    });
  }
  async action(
    workflowId: string,
    threadId: string,
    data: z.infer<typeof findingAction>,
  ) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, workflowId, true);
      const thread = await threadById(tx, workflowId, threadId);
      if (
        (
          await tx.query(
            "SELECT id FROM discussion_messages WHERE thread_id=$1 AND request_key=$2",
            [threadId, data.request_key],
          )
        ).rows.length
      )
        return thread;
      editable(w);
      if (thread.process_version !== w.process_version)
        throw new DomainError(
          409,
          "HISTORICAL_FINDING",
          "This finding belongs to an earlier process revision and remains read-only.",
        );
      expectRevision(thread, data.expected_revision);
      if (thread.kind !== "finding")
        throw new DomainError(
          422,
          "NOT_FINDING",
          "This action only applies to AI findings.",
        );
      if (data.action === "reopen") {
        if (thread.status !== "closed")
          throw new DomainError(
            409,
            "ALREADY_OPEN",
            "This finding is already open.",
          );
        await appendMessage(tx, thread, {
          author: "customer",
          body: data.reason || "Reopened for another look.",
          requestKey: data.request_key,
          event: {
            action: "reopened",
            previous_resolution: thread.resolution_kind,
            previous_reason: thread.resolution_note,
          },
        });
        await tx.query(
          "UPDATE discussion_threads SET status='open',resolution_kind=NULL,resolution_note=NULL,closed_at=NULL WHERE id=$1",
          [threadId],
        );
      } else {
        if (thread.status !== "open")
          throw new DomainError(
            409,
            "ALREADY_CLOSED",
            "This finding has already been resolved.",
          );
        let applied: Record<string, unknown> | undefined;
        if (data.action === "apply") {
          if (!thread.proposed_node_id || !thread.proposed_patch)
            throw new DomainError(
              409,
              "NO_PROPOSAL",
              "There is no safe detail edit to apply.",
            );
          const row = (
            await tx.query(
              "SELECT * FROM nodes WHERE workflow_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",
              [workflowId, thread.proposed_node_id],
            )
          ).rows[0];
          if (!row)
            throw new DomainError(
              409,
              "TARGET_REMOVED",
              "The proposed block was removed. Resolve this finding manually.",
            );
          const node = record<CanvasNode>(row);
          if (node.revision !== thread.proposed_node_revision)
            throw new DomainError(
              409,
              "STALE_PROPOSAL",
              "The block changed after this suggestion. Compare it with the saved instructions or request another review.",
            );
          const patch = detailPatch.parse(thread.proposed_patch);
          const keys = Object.keys(patch) as (keyof typeof patch)[];
          const changed = keys.filter((k) => patch[k] !== node[k]);
          if (changed.length) {
            await tx.query(
              `UPDATE nodes SET ${changed.map((k, i) => `${k}=$${i + 2}`).join(",")},revision=revision+1,updated_at=now() WHERE id=$1`,
              [node.id, ...changed.map((k) => patch[k])],
            );
            await tx.query(
              "UPDATE workflows SET content_revision=content_revision+1,updated_at=now() WHERE id=$1",
              [workflowId],
            );
          }
          applied = {
            node_id: node.id,
            before: { title: node.title, instructions: node.instructions },
            patch,
          };
        } else if (!data.reason.trim())
          throw new DomainError(
            422,
            "REASON_REQUIRED",
            "Add a brief explanation before closing a finding without an applied edit.",
          );
        const resolution =
          data.action === "reject"
            ? "rejected"
            : data.action === "apply"
              ? "workflow_updated"
              : "clarified";
        const body =
          data.reason ||
          (data.action === "apply"
            ? "Applied the approved block detail edit."
            : "Finding resolved.");
        await appendMessage(tx, thread, {
          author: "customer",
          body,
          requestKey: data.request_key,
          event: { action: resolution, ...(applied ? { applied } : {}) },
        });
        await tx.query(
          "UPDATE discussion_threads SET status='closed',resolution_kind=$2,resolution_note=$3,closed_at=now(),updated_at=now() WHERE id=$1",
          [threadId, resolution, body],
        );
      }
      return threadById(tx, workflowId, threadId);
    });
  }
}
