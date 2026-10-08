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
