import { z } from "zod";
import { uuid } from "./validation";
import type { Board, CanvasNode, Connection } from "./canvas";
import type { Method } from "./engineering";

export type Json = z.infer<ReturnType<typeof z.json>>;
export const DEMO_LIMITS = { step_attempts: 100, active_ms: 900_000 } as const;
// Liveness tolerance is separate from the bounded operation deadline.
export const RUNTIME_HEARTBEAT_POLICY = {
  version: 1,
  interval_ms: 5_000,
  timeout_ms: 60_000,
  max_throttle_ms: 5_000,
} as const;
export const bundleInput = z
  .object({
    source_kind: z.enum(["fixture", "gmail"]),
    shipment_reference: z.string().max(200).nullable().default(null),
    manifest: z
      .object({
        input: z.json(),
        artifacts: z
          .array(
            z
              .object({
                artifact_id: uuid,
                message_id: z.string().max(500).nullable(),
                name: z.string().max(500),
              })
              .strict(),
          )
          .max(100),
        message_ids: z.array(z.string().max(500)).max(100),
      })
      .strict(),
  })
  .strict();
export const startRunInput = z
  .object({
    request_key: uuid,
    implementation_version_id: uuid,
    input_bundle_id: uuid,
    rerun_of_id: uuid.nullable().default(null),
  })
  .strict();
export const humanResponse = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().trim().min(1).max(20000),
    })
    .strict(),
  z
    .object({
      type: z.literal("approval"),
      approved: z.boolean(),
      text: z.string().max(20000).default(""),
    })
    .strict(),
]);
export const answerInput = z
  .object({ request_key: uuid, response: humanResponse })
  .strict();
export type HumanResponse = z.infer<typeof humanResponse>;
export interface RuntimeError {
  code: string;
  message: string;
  category: "implementation" | "input" | "infrastructure" | "unknown";
}
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "completed"
  | "failed"
  | "needs_attention"
  | "cancelled";
export interface RunRecord {
  id: string;
  workflow_id: string;
  job_id: string;
  implementation_version_id: string;
  input_bundle_id: string;
  kind: "manual" | "evaluation" | "recovery";
  failure_category: RuntimeError["category"] | null;
  rerun_of_id: string | null;
  status: RunStatus;
  limits: { step_attempts: number; active_ms: number };
  scheduled_step_attempts: number;
  active_elapsed_ms: number;
  active_since: string | null;
  result_step_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  finished_at: string | null;
}
export interface StepRecord {
  id: string;
  run_id: string;
  workflow_id: string;
  node_id: string;
  occurrence_number: number;
  node_visit_number: number;
  scheduling_key: string;
  branch_ref: string | null;
  status:
    | "running"
    | "waiting_for_human"
    | "completed"
    | "failed"
    | "cancelled";
  input_step_refs: Record<string, string>;
  output_data: Json | null;
  selected_connection_ids: string[];
  failure_code: string | null;
  failure_message: string | null;
}
export interface HumanRequest {
  id: string;
  workflow_id: string;
  run_id: string;
  step_execution_id: string;
  response_type: "text" | "approval";
  prompt: string;
  status: "pending" | "answered" | "cancelled";
  response: HumanResponse | null;
  response_source: "human" | "fixture" | null;
}
export type StepReply =
  | { kind: "complete"; step_id: string; connection_ids: string[] }
  | { kind: "human"; step_id: string; request_id: string }
  | { kind: "error"; step_id: string; error: RuntimeError };
export interface ScheduleStep {
  run_id: string;
  node_id: string;
  occurrence_number: number;
  node_visit_number: number;
  scheduling_key: string;
  branch_ref: string | null;
  input_step_refs: Record<string, string>;
}
export interface RuntimeProjection {
  sequence: number;
  status: "running" | "waiting_for_human";
  scheduled_step_attempts: number;
  active_elapsed_ms: number;
  active_since: string | null;
}
export interface RuntimeDefinition {
  board: Board;
  methods: Record<string, Method>;
  limits: { step_attempts: number; active_ms: number };
}

// Routing stays outside generated code. A handler reports matches, never destinations.
export function selectRoutes(
  node: CanvasNode,
  outgoing: Connection[],
  matches: string[],
): Connection[] {
  if (
    new Set(matches).size !== matches.length ||
    matches.some((id) => !outgoing.some((e) => e.id === id && !e.is_default))
  )
    throw new Error(
      "INVALID_ROUTES: The step returned a duplicate, foreign, or Otherwise connection.",
    );
  if (node.type === "outcome") {
    if (matches.length || outgoing.length)
      throw new Error(
        "INVALID_OUTCOME: An outcome cannot route to another step.",
      );
    return [];
  }
  if (node.split_mode === "parallel") return outgoing;
  const selected = outgoing.filter((e) => matches.includes(e.id));
  if (selected.length > 1)
    throw new Error("AMBIGUOUS_ROUTE: More than one connection matched.");
  if (selected.length === 1) return selected;
  const fallback = outgoing.filter((e) => e.is_default);
  if (fallback.length === 1) return fallback;
  throw new Error(
    "NO_MATCHING_ROUTE: No connection matched and no Otherwise route exists.",
  );
}
