import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import {
  replyProposalEvent,
  replyProposalDecision,
  replyProposalDecisionEvent,
} from "../../domain/review-reply";
import type { Database } from "../database";
import {
  workflow,
  editable,
  expectRevision,
  readBoard,
} from "../workflows/store";
import { appendMessage, threadById, reviewRecord } from "./discussion-store";
import type { DiscussionMessage } from "../../domain/review";

export class ReplyProposalService {
  constructor(private db: Database) {}
  async decide(
    workflowId: string,
    threadId: string,
    proposalId: string,
    data: z.infer<typeof replyProposalDecision>,
  ) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, workflowId, true);
      const thread = await threadById(tx, workflowId, threadId);
      const messages = (
        await tx.query(
          "SELECT * FROM discussion_messages WHERE thread_id=$1 ORDER BY message_number",
          [threadId],
        )
      ).rows.map((row) => reviewRecord<DiscussionMessage>(row));
      const previous = messages.find(
        (m) =>
          (m as DiscussionMessage & { request_key: string }).request_key ===
          data.request_key,
      );
      if (previous) {
        const event = replyProposalDecisionEvent.safeParse(previous.event_data);
        if (
          !event.success ||
          event.data.proposal_message_id !== proposalId ||
          event.data.decision !== data.decision
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request was already used for another decision.",
          );
        return previous;
      }
      editable(w);
      expectRevision(thread, data.expected_revision);
      const message = messages.find((m) => m.id === proposalId);
      const proposal = replyProposalEvent.safeParse(message?.event_data);
      if (
        !message ||
        message.author_kind !== "ai" ||
        !proposal.success ||
        !proposal.data.edits.length
      )
        throw new DomainError(
          404,
          "PROPOSAL_NOT_FOUND",
          "This conversation has no such proposed changes.",
        );
      if (
        messages.some(
          (m) =>
            m.event_data?.action === "reply_proposal_decided" &&
            m.event_data?.proposal_message_id === proposalId,
        )
      )
        throw new DomainError(
          409,
          "PROPOSAL_DECIDED",
          "These changes already have a decision.",
        );
      if (
        thread.status !== "open" ||
        messages.some(
          (m) =>
            m.message_number > message.message_number &&
            m.event_data?.action === "reply_proposed",
        )
      )
        throw new DomainError(
          409,
          "PROPOSAL_SUPERSEDED",
          "This proposal is no longer current. Continue the conversation for a new proposal.",
        );
      if (data.decision === "accept") {
        const board = await readBoard(tx, workflowId);
        if (
          w.content_revision !== proposal.data.content_revision ||
          proposal.data.edits.some(
            (edit) =>
              board.nodes.find((n) => n.id === edit.node_id)?.revision !==
              edit.before.revision,
          )
        )
          throw new DomainError(
            409,
            "STALE_PROPOSAL",
            "The board changed after this proposal. Send another reply to get a fresh diff; no changes were applied.",
          );
        for (const edit of proposal.data.edits)
          await tx.query(
            "UPDATE nodes SET instructions=$2,revision=revision+1,updated_at=now() WHERE workflow_id=$1 AND id=$3",
            [workflowId, edit.after.instructions, edit.node_id],
          );
        await tx.query(
          "UPDATE workflows SET content_revision=content_revision+1,updated_at=now() WHERE id=$1",
          [workflowId],
        );
      }
      return appendMessage(tx, thread, {
        author: "customer",
        parent: proposalId,
        body:
          data.decision === "accept"
            ? "Accepted the proposed changes. Block instructions are now updated."
            : "Rejected the proposed changes. Block instructions are unchanged.",
        requestKey: data.request_key,
        event: {
          action: "reply_proposal_decided",
          proposal_message_id: proposalId,
          decision: data.decision,
        },
      });
    });
  }
}
