import { z } from "zod";
import { uuid } from "./validation";
import type { Board, CanvasNode } from "./canvas";
import type {
  DiscussionMessage,
  DiscussionThread,
  ThreadAnchor,
} from "./review";

export const replyRewrite = z
  .object({
    outcome: z.enum(["updated", "no_change", "manual_change"]),
    explanation: z.string().trim().min(1).max(2000),
    updates: z
      .array(
        z
          .object({
            node_id: uuid,
            instructions: z.string().trim().min(1).max(20000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.outcome === "updated") !== value.updates.length > 0)
      ctx.addIssue({
        code: "custom",
        message: "Only an updated result can contain block edits.",
      });
    if (
      new Set(value.updates.map((u) => u.node_id)).size !== value.updates.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Each block may be updated only once.",
      });
  });
export type ReplyRewrite = z.infer<typeof replyRewrite>;
export interface ReplyContext {
  board: Board;
  targets: CanvasNode[];
  anchors: ThreadAnchor[];
  thread: DiscussionThread;
  messages: DiscussionMessage[];
  answer: string;
}
export type ReplyRewriter = (
  context: ReplyContext,
  signal: AbortSignal,
) => Promise<ReplyRewrite>;

export const replyIncorporationEvent = z.object({
  action: z.literal("reply_incorporated"),
  reply_message_id: uuid,
  outcome: z.enum(["updated", "no_change", "manual_change"]),
  applied: z.array(
    z.object({
      node_id: uuid,
      before: z.object({
        instructions: z.string(),
        revision: z.number().int().positive(),
      }),
      after: z.object({
        instructions: z.string(),
        revision: z.number().int().positive(),
      }),
    }),
  ),
});

export const replyProposalEvent = z.object({
  action: z.literal("reply_proposed"),
  reply_message_id: uuid,
  outcome: z.enum(["updated", "no_change", "manual_change"]),
  content_revision: z.number().int().nonnegative(),
  edits: replyIncorporationEvent.shape.applied,
});
export const replyProposalDecision = z
  .object({
    decision: z.enum(["accept", "reject"]),
    expected_revision: z.number().int().positive(),
    request_key: uuid,
  })
  .strict();
export const replyProposalDecisionEvent = z.object({
  action: z.literal("reply_proposal_decided"),
  proposal_message_id: uuid,
  decision: z.enum(["accept", "reject"]),
});

export function proposalStatus(
  message: DiscussionMessage,
  messages: DiscussionMessage[],
  board: Board,
  thread: DiscussionThread,
) {
  const proposal = replyProposalEvent.safeParse(message.event_data);
  if (!proposal.success || !proposal.data.edits.length) return "none";
  const decision = messages
    .map((m) => replyProposalDecisionEvent.safeParse(m.event_data))
    .find((d) => d.success && d.data.proposal_message_id === message.id);
  if (decision?.success)
    return decision.data.decision === "accept" ? "accepted" : "rejected";
  if (
    messages.some(
      (m) =>
        m.thread_id === thread.id &&
        m.message_number > message.message_number &&
        m.event_data?.action === "reply_proposed",
    )
  )
    return "superseded";
  if (thread.status !== "open") return "closed";
  if (
    board.workflow.content_revision !== proposal.data.content_revision ||
    proposal.data.edits.some(
      (edit) =>
        board.nodes.find((n) => n.id === edit.node_id)?.revision !==
        edit.before.revision,
    )
  )
    return "stale";
  return "pending";
}
