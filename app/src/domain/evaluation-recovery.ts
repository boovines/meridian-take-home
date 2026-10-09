import type { Json, RuntimeError } from "./runtime";

// Retry only a known pre-inference transport/deadline failure. Authentication,
// quota, budget exhaustion, invalid counts and implementation errors stop.
export const EVALUATION_RECOVERY_POLICY = {
  version: 1,
  max_case_retries: 1,
  retry_codes: ["TOKEN_PREFLIGHT_TRANSIENT"],
} as const;
export function hasCaseRecovery(configuration: Json): boolean {
  return !!configuration && typeof configuration === "object" && !Array.isArray(configuration)
    && "case_recovery" in configuration;
}
export function canRecoverCase(configuration: Json, error: RuntimeError, count: number): boolean {
  return hasCaseRecovery(configuration) && count < EVALUATION_RECOVERY_POLICY.max_case_retries
    && error.category === "infrastructure"
    && EVALUATION_RECOVERY_POLICY.retry_codes.some(code => code === error.code);
}
