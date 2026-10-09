import { z } from "zod";
import { uuid, revisionSchema } from "./validation";
export const methods = ["code", "agent", "human"] as const;
export type Method = (typeof methods)[number];
export const createPlanInput = z
  .object({
    request_key: uuid,
    parent_plan_version_id: uuid.nullable().default(null),
    frozen_spec_id: uuid.optional(),
  })
  .strict();
export const planStepPatch = z
  .object({
    expected_revision: revisionSchema,
    selected_method: z.enum(methods).optional(),
    approved: z.boolean().optional(),
  })
  .strict();
export const approvePlanInput = z
  .object({ expected_revision: revisionSchema })
  .strict();
export const generateInput = z
  .object({
    request_key: uuid,
    plan_version_id: uuid,
    input_version_id: uuid.nullable().default(null),
  })
  .strict();
export const planRecommendations = z
  .object({
    steps: z
      .array(
        z
          .object({
            node_id: uuid,
            method: z.enum(methods),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export interface Plan {
  id: string;
  workflow_id: string;
  frozen_spec_id: string;
  version_number: number;
  parent_plan_version_id: string | null;
  state: "draft" | "approved";
  revision: number;
  approved_at: string | null;
  created_at: string;
}
export interface PlanStep {
  id: string;
  workflow_id: string;
  plan_version_id: string;
  node_id: string;
  recommended_method: Method | null;
  recommendation_reason: string | null;
  selected_method: Method;
  approved_at: string | null;
  revision: number;
}
export interface Artifact {
  id: string;
  workflow_id: string;
  kind: string;
  state: "pending" | "ready" | "failed";
  storage_backend: "local" | "supabase";
  storage_key: string;
  content_hash: string | null;
  byte_size: number | null;
  media_type: string;
  display_name: string;
  metadata: Record<string, unknown>;
}
export interface ImplementationVersion {
  id: string;
  workflow_id: string;
  plan_version_id: string;
  version_number: number;
  parent_version_id: string | null;
  created_by_job_id: string;
  artifact_id: string;
  entrypoint: string;
  node_file_map: Record<string, string>;
  created_at: string;
}
export interface WorkflowJob {
  parent_job_id?: string | null;
  frozen_spec_id?: string;
  process_version?: number;
  id: string;
  workflow_id: string;
  kind: "generation" | "evaluation" | "repair" | "execution" | "grouped";
  status:
    | "queued"
    | "running"
    | "waiting_for_human"
    | "cancel_requested"
    | "succeeded"
    | "failed"
    | "cancelled";
  phase: string;
  progress: Record<string, unknown>;
  plan_version_id: string;
  input_version_id: string | null;
  source_request: Record<string, unknown>;
  suite_version_id: string | null;
  executor_ref: string;
  deadline_at: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}
