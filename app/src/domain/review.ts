import { z } from "zod";
import { uuid, revisionSchema } from "./validation";
import type { Board } from "./canvas";
export const reviewStart = z.object({ request_key: uuid }).strict();
export const goalAnswer = z
  .object({
    desired_outcome: z.string().trim().min(1).max(10000),
    request_key: uuid,
  })
  .strict();
export const messageInput = z
  .object({
    body: z.string().trim().min(1).max(20000),
    parent_message_id: uuid.nullable().default(null),
    request_key: uuid,
  })
  .strict();
export const findingAction = z
  .object({
    action: z.enum(["resolve", "reject", "reopen", "apply"]),
    expected_revision: revisionSchema,
    reason: z.string().trim().max(10000).default(""),
    request_key: uuid,
  })
  .strict();
export const noteInput = z
  .object({
    title: z.string().trim().min(1).max(300),
    body: z.string().trim().min(1).max(20000),
    node_ids: z.array(uuid).max(20).default([]),
    connection_ids: z.array(uuid).max(20).default([]),
    request_key: uuid,
  })
  .strict();
export const freezeInput = z
  .object({
    expected_content_revision: z.number().int().nonnegative(),
    acknowledge_unreviewed: z.boolean().default(false),
  })
  .strict();
export const detailPatch = z
  .object({
    title: z.string().max(200).optional(),
    instructions: z.string().max(20000).optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "A proposal must change a field.");
export const reviewerOutput = z
  .object({
    findings: z
      .array(
        z
          .object({
            action: z.enum(["new", "followup"]),
            existing_thread_id: uuid.nullable(),
            previous_finding_id: uuid.nullable(),
            category: z.enum([
              "ambiguity",
              "missing_behavior",
              "inconsistency",
              "simplification",
            ]),
            title: z.string().min(1).max(300),
            message: z.string().min(1).max(5000),
            node_ids: z.array(uuid).max(20),
            connection_ids: z.array(uuid).max(20),
            change_kind: z.enum(["detail", "graph", "question"]),
            proposal: z
              .object({
                node_id: uuid,
                title: z.string().max(200).nullable(),
                instructions: z.string().max(20000).nullable(),
              })
              .nullable(),
          })
          .strict(),
      )
      .max(15),
  })
  .strict();
export type ReviewerOutput = z.infer<typeof reviewerOutput>;
export interface ReviewRun {
  id: string;
  workflow_id: string;
  status:
    | "queued"
    | "running"
    | "awaiting_customer"
    | "completed"
    | "cancelled"
    | "failed";
  phase: "clarification" | "analysis";
  started_content_revision: number;
  initial_snapshot: Board;
  analyzed_content_revision: number | null;
  analyzed_snapshot: Board | null;
  model: string;
  model_settings: Record<string, unknown>;
  reviewer_version: string;
  error_message: string | null;
  deadline_at: string | null;
  created_at: string;
  finished_at: string | null;
}
export interface DiscussionThread {
  id: string;
  workflow_id: string;
  kind: "finding" | "note" | "clarification";
  scope: "workflow" | "elements";
  title: string;
  origin_review_run_id: string | null;
  finding_category: string | null;
  status: "open" | "closed";
  resolution_kind: string | null;
  resolution_note: string | null;
  previous_finding_id: string | null;
  proposed_node_id: string | null;
  proposed_node_revision: number | null;
  proposed_patch: z.infer<typeof detailPatch> | null;
  revision: number;
}
export interface DiscussionMessage {
  id: string;
  thread_id: string;
  message_number: number;
  parent_message_id: string | null;
  author_kind: "customer" | "ai" | "system";
  kind: "comment" | "event";
  body: string;
  event_data: Record<string, unknown> | null;
  created_at: string;
}
export interface ThreadAnchor {
  id: string;
  thread_id: string;
  node_id: string | null;
  connection_id: string | null;
  context_snapshot: Record<string, unknown>;
}
export interface ReviewState {
  runs: Omit<ReviewRun, "initial_snapshot" | "analyzed_snapshot">[];
  threads: DiscussionThread[];
  messages: DiscussionMessage[];
  anchors: ThreadAnchor[];
}
export function findingLabel(
  thread: DiscussionThread,
  messages: DiscussionMessage[],
) {
  if (thread.status === "closed")
    return thread.resolution_kind === "rejected" ? "Rejected" : "Resolved";
  return messages
    .filter((m) => m.thread_id === thread.id && m.kind === "comment")
    .at(-1)?.author_kind === "customer"
    ? "Answered"
    : "Open";
}
