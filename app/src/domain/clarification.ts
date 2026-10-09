import { z } from "zod";
import { repairSources } from "./repair";
export const clarificationProposal = z
  .object({
    question: z.string().trim().min(1).max(2000),
    why_needed: z.string().trim().min(1).max(2000),
    node_ids: z.array(z.uuid()).min(1).max(100),
    source_artifact_ids: z.array(z.uuid()).max(20),
    audit_event_ids: z.array(z.uuid()).max(20),
  })
  .strict();
export const recoverySources = repairSources.extend({
  clarification: clarificationProposal.nullable().default(null),
  clarification_assessment: z
    .object({
      disposition: z.enum([
        "clarifies_existing_rules",
        "requires_process_change",
        "insufficient_evidence",
      ]),
      reason: z.string().min(1).max(2000),
    })
    .strict()
    .nullable()
    .default(null),
});
export const answerClarification = z
  .object({
    request_key: z.uuid(),
    answer: z.string().trim().min(1).max(4000),
    reuse: z.boolean().default(false),
  })
  .strict();
export interface EngineerQuestion
  extends z.infer<typeof clarificationProposal> {
  id: string;
  workflow_id: string;
  session_id: string;
  attempt_id: string;
  status: "open" | "answered" | "cancelled";
  answer: string | null;
  reuse: boolean;
  answered_at: string | null;
  created_at: string;
}
export interface ClarificationContext {
  question_id: string;
  question: string;
  answer: string;
  scope: "captured_input" | "workflow";
  source_artifact_ids: string[];
  audit_event_ids: string[];
}
