import { ApplicationFailure } from "@temporalio/common";
import type { RuntimeError } from "../domain/runtime";

// Worker-supplied classification survives Temporal's ActivityFailure wrappers.
// Unknown worker failures remain infrastructure; do not guess from free text.
export function describeExecutionFailure(error: unknown): RuntimeError {
  let cause = error;
  const visited = new Set<unknown>();
  while (cause instanceof Error && "cause" in cause && cause.cause && !visited.has(cause)) {
    visited.add(cause); cause = cause.cause;
  }
  const failure = cause instanceof ApplicationFailure ? cause : null;
  const detail = failure?.details?.[0] as { failure_category?: unknown } | undefined;
  const category = detail?.failure_category;
  return {
    code: failure?.type || "RUNTIME_FAILED",
    message: cause instanceof Error ? cause.message.slice(0, 2000) : "The runtime worker failed.",
    category: category === "implementation" || category === "input" || category === "infrastructure" || category === "unknown"
      ? category
      : failure?.type === "RUN_LIMIT" || failure?.type === "STEP_RETRY_LIMIT" ? "implementation"
      : failure?.type === "MISSING_HUMAN_FIXTURE" ? "input" : "infrastructure",
  };
}
