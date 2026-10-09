import { z } from "zod";
import { uuid } from "./validation";
import type { EvaluationRun, CaseResult } from "./evaluation";
import { generatedSources } from "./project";
export const startRepairInput = z
  .object({ request_key: uuid, baseline_evaluation_id: uuid, retained_attempt_id: uuid.optional() })
  .strict();
export const repairSources = z
  .object({
    diagnosis: z
      .object({
        summary: z.string().min(1).max(4000),
        affected_node_ids: z.array(uuid).max(100),
        changes: z.array(z.string().min(1).max(1000)).max(30),
      })
      .strict(),
    project: generatedSources.extend({
      steps: generatedSources.shape.steps.describe(
        "Replacement implementations for affected nodes only. Omitted nodes are copied unchanged from the retained baseline. Include every changed node in diagnosis.affected_node_ids.",
      ),
    }),
  })
  .strict();
export interface RepairSession {
  id: string;
  workflow_id: string;
  job_id: string;
  plan_version_id: string;
  suite_version_id: string;
  initial_version_id: string;
  initial_evaluation_id: string;
  baseline_version_id: string;
  baseline_evaluation_id: string;
  attempt_limit: number;
  status:
    | "queued"
    | "running"
    | "passed"
    | "needs_attention"
    | "failed"
    | "cancelled";
  stop_reason: string | null;
  created_at: string;
  finished_at: string | null;
}
export interface RepairAttempt {
  id: string;
  workflow_id: string;
  session_id: string;
  attempt_number: number;
  baseline_version_id: string;
  baseline_evaluation_id: string;
  candidate_version_id: string | null;
  evaluation_run_id: string | null;
  diagnosis: z.infer<typeof repairSources>["diagnosis"] | null;
  status: "running" | "accepted" | "rejected" | "failed" | "cancelled";
  decision_reason: string | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: string | null;
}
// Diagnose proven assertion failures independently of transient service errors.
// Candidate acceptance still requires a determinate full-suite evaluation.
export function repairBlocker(
  e: EvaluationRun,
  results: CaseResult[],
): string | null {
  if (!["completed", "blocked"].includes(e.status))
    return "Wait for a complete evaluation before starting repair.";
  if (e.verdict === "passed") return "Every verified check already passes.";
  if (e.status === "blocked")
    return e.failure_category === "implementation"
      ? null
      : "Resolve the shared evaluation prerequisite before repairing code.";
  if (!results.length || results.some((r) => r.status !== "finished"))
    return "The evaluation lacks complete case evidence.";
  const hasScoredFailure = results.some(r => r.outcome === "failed" && r.check_results.some(c => !c.passed));
  const independentlyRetryable = new Set(["MODEL_UNAVAILABLE", "MODEL_RESPONSE_TIMEOUT", "TOKEN_PREFLIGHT_TRANSIENT"]);
  if (
    results.some(r => ["error", "not_run"].includes(r.outcome || "") &&
      r.failure_category !== "implementation" && !(hasScoredFailure && r.outcome === "error" &&
        r.failure_category === "infrastructure" && independentlyRetryable.has(r.failure_code || "")))
  )
    return "Resolve input, infrastructure, or unclassified errors before repairing code.";
  return null;
}

export interface RepairConfirmation {
  attempt_id: string;
  round: number;
  evaluation_run_id: string;
  status: EvaluationRun["status"];
  verdict: EvaluationRun["verdict"];
}
