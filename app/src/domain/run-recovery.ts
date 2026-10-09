import { z } from "zod";
import type { RunRecord } from "./runtime";
export const startRecoveryInput = z.object({ request_key: z.uuid() }).strict();
export const RECOVERY_LIMITS = {
  attempt_limit: 3,
  max_spend_usd: 5,
  active_ms: 7_200_000,
  max_generation_invocations_per_attempt: 2,
  max_inspection_rounds: 3,
  max_generation_output_tokens: 48000,
} as const;
export function recoveryEligibility(
  run: Pick<RunRecord, "kind" | "status" | "failure_category">,
) {
  if (run.kind !== "manual")
    return {
      eligible: false,
      reason: "Internal runs cannot start another recovery session.",
    };
  if (run.status === "completed")
    return {
      eligible: false,
      reason:
        "This process completed. Negative business outcomes are not implementation failures.",
    };
  if (!["failed", "needs_attention"].includes(run.status))
    return {
      eligible: false,
      reason: "Recovery requires a finished failed run.",
    };
  if (run.failure_category !== "implementation")
    return {
      eligible: false,
      reason:
        run.failure_category === "input"
          ? "Correct the missing or unreadable input and capture a new bundle."
          : "Inspect provider access or operational evidence before repairing code.",
    };
  return {
    eligible: true,
    reason: "Diagnose the implementation using this run's captured evidence.",
  };
}

export interface ManualRunDefault {
  implementation_version_id: string;
  recovery_session_id: string;
}
export interface RunRecoveryState {
  session: import("./repair").RepairSession;
  job: import("./engineering").WorkflowJob;
  attempts: import("./repair").RepairAttempt[];
  questions: import("./clarification").EngineerQuestion[];
  spent_or_reserved_usd: number;
}
