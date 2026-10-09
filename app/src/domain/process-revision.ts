import { z } from "zod";
import { uuid, revisionSchema } from "./validation";
export const requestProcessChange = z
  .object({
    source_frozen_spec_id: uuid,
    body: z.string().trim().min(1).max(20000),
    node_ids: z.array(uuid).max(20).default([]),
    request_key: uuid,
  })
  .strict();
export const startProcessRevision = z
  .object({ source_frozen_spec_id: uuid })
  .strict();
export const resolveProcessRequest = z
  .object({
    action: z.enum(["resolve", "reject"]),
    reason: z.string().trim().min(1).max(10000),
    expected_revision: revisionSchema,
    request_key: uuid,
  })
  .strict();
export interface EngineerChangeRequest {
  thread_id: string;
  workflow_id: string;
  source_frozen_spec_id: string;
  source_version_number: number;
  target_process_version: number | null;
  resulting_frozen_spec_id: string | null;
  original_body: string;
  author_role: "engineer";
}
