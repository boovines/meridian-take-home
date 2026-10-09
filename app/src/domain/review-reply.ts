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
            title: z.string().trim().min(1).max(200).nullable().optional(),
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
        title: z.string().optional(),
        instructions: z.string(),
        revision: z.number().int().positive(),
      }),
      after: z.object({
        title: z.string().optional(),
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
    node_id: uuid,
    instructions: z.string().trim().min(1).max(20000).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    expected_revision: z.number().int().positive(),
    request_key: uuid,
  })
  .strict()
  .refine(
    (value) => value.decision !== "accept" || value.instructions !== undefined,
    { message: "Accepted instructions are required", path: ["instructions"] },
  );
export const replyProposalDecisionEvent = z.object({
  action: z.literal("reply_proposal_decided"),
  node_id: uuid.optional(),
  instructions: z.string().optional(),
  title: z.string().optional(),
  proposal_message_id: uuid,
  decision: z.enum(["accept", "reject"]),
});

export function proposalStatus(
  message: DiscussionMessage,
  messages: DiscussionMessage[],
  board: Board,
  thread: DiscussionThread,
  nodeId: string,
) {
  const proposal = replyProposalEvent.safeParse(message.event_data);
  if (!proposal.success || !proposal.data.edits.length) return "none";
  const decision = messages
    .map((m) => replyProposalDecisionEvent.safeParse(m.event_data))
    .find(
      (d) =>
        d.success &&
        d.data.proposal_message_id === message.id &&
        (!d.data.node_id || d.data.node_id === nodeId),
    );
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
    board.workflow.content_revision !==
      proposalContentRevision(
        message.id,
        proposal.data.content_revision,
        messages,
      ) ||
    proposal.data.edits
      .filter((edit) => edit.node_id === nodeId)
      .some(
        (edit) =>
          board.nodes.find((n) => n.id === edit.node_id)?.revision !==
          edit.before.revision,
      )
  )
    return "stale";
  return "pending";
}

// Only accepted blocks from this proposal explain intervening content revisions.
// Any unrelated graph change still invalidates the remaining decisions.
export function proposalContentRevision(
  proposalId: string,
  original: number,
  messages: DiscussionMessage[],
) {
  return (
    original +
    messages.filter(
      (m) =>
        m.event_data?.action === "reply_proposal_decided" &&
        m.event_data?.proposal_message_id === proposalId &&
        m.event_data?.decision === "accept" &&
        typeof m.event_data?.node_id === "string",
    ).length
  );
}
