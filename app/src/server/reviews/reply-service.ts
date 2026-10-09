import { discussable } from "../process-revisions/conversation";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import {
  replyRewrite,
  type ReplyContext,
  type ReplyRewriter,
  type ReplyRewrite,
} from "../../domain/review-reply";
import type {
  DiscussionMessage,
  ThreadAnchor,
  messageInput,
} from "../../domain/review";
import type { Database, Queryable } from "../database";
import { expectRevision, readBoard, workflow } from "../workflows/store";
import { appendMessage, reviewRecord, threadById } from "./discussion-store";
import { rewriteReviewReply } from "../integrations/openai-review-reply";

type Input = z.infer<typeof messageInput>;
async function previous(tx: Queryable, threadId: string, data: Input) {
  const row = (
    await tx.query(
      "SELECT * FROM discussion_messages WHERE thread_id=$1 AND request_key=$2",
      [threadId, data.request_key],
    )
  ).rows[0];
  if (!row) return null;
  const message = reviewRecord<DiscussionMessage>(row);
  if (
    message.body !== data.body ||
    message.parent_message_id !== data.parent_message_id
  )
    throw new DomainError(
      409,
      "REQUEST_REUSED",
      "This request was already used for a different reply.",
    );
  return message;
}
export class ReplyService {
  constructor(
    private db: Database,
    private rewrite: ReplyRewriter = rewriteReviewReply,
  ) {}
  async reply(
    workflowId: string,
    threadId: string,
    data: Input,
    signal: AbortSignal = AbortSignal.timeout(90000),
  ) {
    const prepared = await this.db.transaction(
      async (
        tx,
      ): Promise<
        | { existing: DiscussionMessage }
        | { context: ReplyContext; missingTarget: boolean }
      > => {
        const w = await workflow(tx, workflowId, true);
        const thread = await threadById(tx, workflowId, threadId);
        const existing = await previous(tx, threadId, data);
        if (existing) return { existing };
        discussable(w, thread);
        if (data.expected_revision !== undefined)
          expectRevision(thread, data.expected_revision);
        if (thread.kind === "clarification")
          throw new DomainError(
            409,
            "USE_CLARIFICATION",
            "Answer the outcome question in the review panel.",
          );
        if (thread.status === "closed")
          throw new DomainError(
            409,
            "THREAD_CLOSED",
            "Reopen the finding before adding an answer.",
          );
        const messages = (
          await tx.query(
            "SELECT * FROM discussion_messages WHERE thread_id=$1 ORDER BY message_number",
            [threadId],
          )
        ).rows.map((row) => reviewRecord<DiscussionMessage>(row));
        if (
          data.parent_message_id &&
          !messages.some((m) => m.id === data.parent_message_id)
        )
          throw new DomainError(
            422,
            "INVALID_REPLY",
            "Reply to an existing message in this thread.",
          );
        if (thread.kind === "note" && !thread.engineer_request)
          return {
            existing: await appendMessage(tx, thread, {
              author: "customer",
              body: data.body,
              parent: data.parent_message_id,
              requestKey: data.request_key,
            }),
          };
        const board = await readBoard(tx, workflowId);
        const anchors = (
          await tx.query("SELECT * FROM thread_anchors WHERE thread_id=$1", [
            threadId,
          ])
        ).rows as unknown as ThreadAnchor[];
        return {
          missingTarget: anchors.some((a) =>
            a.node_id
              ? !board.nodes.some((n) => n.id === a.node_id)
              : !board.connections.some((c) => c.id === a.connection_id),
          ),
          context: {
            board,
            anchors,
            targets:
              thread.engineer_request && !anchors.length
                ? board.nodes
                : board.nodes.filter((n) =>
                    anchors.some((a) => a.node_id === n.id),
                  ),
            thread,
            messages,
            answer: data.body,
          },
        };
      },
    );
    if ("existing" in prepared) return prepared.existing;
    const { context } = prepared;
    // Network I/O stays outside the workflow transaction. A second transaction
    // fences every input used by the rewrite before publishing any changes.
    signal.throwIfAborted();
    const raw: ReplyRewrite =
      context.targets.length && !prepared.missingTarget
        ? await this.rewrite(context, signal)
        : {
            outcome: "manual_change",
            updates: [],
            explanation: prepared.missingTarget
              ? "A referenced block or connection was removed. Review the remaining targets and apply this clarification manually."
              : "This finding has no active referenced block to update. Apply the clarification to workflow details or connections manually.",
          };
    const parsed = replyRewrite.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.updates.some(
        (u) => !context.targets.some((n) => n.id === u.node_id),
      )
    )
      throw new DomainError(
        422,
        "INVALID_REPLY_UPDATE",
        "The reply update was invalid. No reply or proposal was saved; retry or edit the block directly.",
      );
    const result = parsed.data;
    signal.throwIfAborted();
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, workflowId, true);
      const thread = await threadById(tx, workflowId, threadId);
      const existing = await previous(tx, threadId, data);
      if (existing) return existing;
      signal.throwIfAborted();
      discussable(w, thread);
      const board = await readBoard(tx, workflowId);
      if (
        thread.revision !== context.thread.revision ||
        w.content_revision !== context.board.workflow.content_revision ||
        w.process_version !== context.board.workflow.process_version ||
        context.targets.some(
          (n) =>
            board.nodes.find((current) => current.id === n.id)?.revision !==
            n.revision,
        )
      )
        throw new DomainError(
          409,
          "STALE_REPLY_UPDATE",
          "The board or discussion changed while preparing your proposal. Your text is preserved; retry against the latest saved context.",
        );
      const edits = result.updates.flatMap((update) => {
        const node = context.targets.find((n) => n.id === update.node_id)!;
        return node.instructions === update.instructions &&
          (!update.title || node.title === update.title)
          ? []
          : [
              {
                node_id: node.id,
                before: {
                  title: node.title,
                  instructions: node.instructions,
                  revision: node.revision,
                },
                after: {
                  title: update.title ?? node.title,
                  instructions: update.instructions,
                  revision: node.revision + 1,
                },
              },
            ];
      });
      const message = await appendMessage(tx, thread, {
        author: "customer",
        body: data.body,
        parent: data.parent_message_id,
        requestKey: data.request_key,
      });
      await appendMessage(tx, thread, {
        author: "ai",
        parent: message.id,
        body: edits.length
          ? result.explanation
          : result.outcome === "updated"
            ? "The block instructions already contain this clarification; no changes were needed."
            : result.explanation,
        requestKey: `${data.request_key}:proposal`,
        event: {
          action: "reply_proposed",
          reply_message_id: message.id,
          outcome: edits.length
            ? "updated"
            : result.outcome === "updated"
              ? "no_change"
              : result.outcome,
          content_revision: w.content_revision,
          edits,
        },
      });
      // Supersede the original suggestion with the answer-informed proposal.
      await tx.query(
        "UPDATE discussion_threads SET proposed_node_id=NULL,proposed_node_revision=NULL,proposed_patch=NULL WHERE id=$1",
        [threadId],
      );
      signal.throwIfAborted();
      return message;
    });
  }
}
