import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type {
  requestProcessChange,
  resolveProcessRequest,
  startProcessRevision,
} from "../../domain/process-revision";
import type { Database } from "../database";
import { workflow, expectRevision, readBoard } from "../workflows/store";
import { frozenSpec } from "../engineering/plan-service";
import { appendMessage, threadById } from "../reviews/discussion-store";

export class ProcessRevisionService {
  constructor(private db: Database) {}
  async request(id: string, data: z.infer<typeof requestProcessChange>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      const previous = (
        await tx.query(
          "SELECT * FROM engineer_change_requests WHERE workflow_id=$1 AND request_key=$2",
          [id, data.request_key],
        )
      ).rows[0];
      if (previous) {
        const anchors = (
          await tx.query(
            "SELECT node_id FROM thread_anchors WHERE thread_id=$1",
            [previous.thread_id],
          )
        ).rows
          .map((a) => String(a.node_id))
          .sort();
        if (
          previous.original_body !== data.body ||
          previous.source_frozen_spec_id !== data.source_frozen_spec_id ||
          JSON.stringify(anchors) !==
            JSON.stringify([...new Set(data.node_ids)].sort())
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request key belongs to different proposed changes.",
          );
        return threadById(tx, id, String(previous.thread_id));
      }
      if (w.current_frozen_spec_id !== data.source_frozen_spec_id)
        throw new DomainError(
          409,
          "SPEC_CHANGED",
          "Request changes against the current approved process. Older versions remain available for engineering work.",
        );
      const spec = await frozenSpec(tx, id, data.source_frozen_spec_id);
      const ids = [...new Set(data.node_ids)];
      if (ids.some((n) => !spec.board.nodes.some((node) => node.id === n)))
        throw new DomainError(
          422,
          "INVALID_ANCHOR",
          "Choose blocks from the source frozen specification.",
        );
      const row = (
        await tx.query(
          "INSERT INTO discussion_threads(workflow_id,kind,title,scope,creation_key) VALUES($1,'note','Engineer requested changes',$2,$3) RETURNING id",
          [id, ids.length ? "elements" : "workflow", data.request_key],
        )
      ).rows[0];
      const thread = await threadById(tx, id, String(row.id));
      await tx.query(
        "INSERT INTO engineer_change_requests(workflow_id,thread_id,source_frozen_spec_id,target_process_version,request_key,original_body) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          thread.id,
          spec.id,
          w.state === "frozen" ? null : w.process_version,
          data.request_key,
          data.body,
        ],
      );
      for (const nodeId of ids)
        await tx.query(
          "INSERT INTO thread_anchors(workflow_id,thread_id,node_id,context_snapshot) VALUES($1,$2,$3,$4)",
          [
            id,
            thread.id,
            nodeId,
            spec.board.nodes.find((n) => n.id === nodeId),
          ],
        );
      await appendMessage(tx, thread, {
        author: "engineer",
        body: data.body,
        requestKey: data.request_key,
      });
      return threadById(tx, id, thread.id);
    });
  }
  async start(id: string, data: z.infer<typeof startProcessRevision>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      // Retrying Start revision after a successful handoff must not create v3.
      if (w.base_frozen_spec_id === data.source_frozen_spec_id)
        return readBoard(tx, id);
      if (
        w.state !== "frozen" ||
        w.current_frozen_spec_id !== data.source_frozen_spec_id
      )
        throw new DomainError(
          409,
          "REVISION_CHANGED",
          "Reload the current process before starting a revision.",
        );
      await tx.query(
        "UPDATE workflows SET state='draft',process_version=process_version+1,base_frozen_spec_id=current_frozen_spec_id,revision=revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await tx.query(
        "UPDATE engineer_change_requests SET target_process_version=$2 WHERE workflow_id=$1 AND source_frozen_spec_id=$3 AND target_process_version IS NULL AND thread_id IN (SELECT id FROM discussion_threads WHERE status='open')",
        [id, (w.process_version ?? 1) + 1, data.source_frozen_spec_id],
      );
      return readBoard(tx, id);
    });
  }
  async resolve(
    id: string,
    threadId: string,
    data: z.infer<typeof resolveProcessRequest>,
  ) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      const thread = await threadById(tx, id, threadId);
      const request = (
        await tx.query(
          "SELECT * FROM engineer_change_requests WHERE workflow_id=$1 AND thread_id=$2",
          [id, threadId],
        )
      ).rows[0];
      if (!request)
        throw new DomainError(404, "NOT_FOUND", "Engineer request not found.");
      const previous = (
        await tx.query(
          "SELECT event_data FROM discussion_messages WHERE thread_id=$1 AND request_key=$2",
          [threadId, data.request_key],
        )
      ).rows[0];
      if (previous) {
        const event = previous.event_data as { action: string; reason: string };
        if (event.action !== data.action || event.reason !== data.reason)
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request key belongs to another disposition.",
          );
        return thread;
      }
      expectRevision(thread, data.expected_revision);
      if (thread.status !== "open")
        throw new DomainError(
          409,
          "THREAD_CLOSED",
          "This request already has a disposition.",
        );
      if (w.state === "reviewing")
        throw new DomainError(
          409,
          "REVIEW_ACTIVE",
          "Finish or cancel the review before resolving requests.",
        );
      if (
        data.action === "resolve" &&
        (w.state !== "draft" ||
          request.target_process_version !== w.process_version)
      )
        throw new DomainError(
          409,
          "START_REVISION",
          "Start a revision and save the agreed instructions before resolving this request. You can reject it without starting a revision.",
        );
      await appendMessage(tx, thread, {
        author: "customer",
        body: data.reason,
        requestKey: data.request_key,
        event: { action: data.action, reason: data.reason },
      });
      await tx.query(
        "UPDATE discussion_threads SET status='closed',resolution_kind=$2,resolution_note=$3,closed_at=now(),updated_at=now() WHERE id=$1",
        [
          threadId,
          data.action === "reject" ? "rejected" : "workflow_updated",
          data.reason,
        ],
      );
      return threadById(tx, id, threadId);
    });
  }
}
