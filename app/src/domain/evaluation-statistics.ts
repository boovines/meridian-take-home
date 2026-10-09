import type { AssertionResult, CaseResult } from "./evaluation";

/** Read-only evidence counts; these never decide a verdict or repair acceptance. */
export interface StatisticsCase {
  assertion_keys: string[];
  status: CaseResult["status"] | null;
  outcome: CaseResult["outcome"];
  checks: Pick<AssertionResult, "key" | "passed">[];
}
export type CaseOutcome =
  "passed" | "failed" | "error" | "not_run" | "running" | "queued" | "missing";
export interface EvaluationStatistics {
  cases: Record<CaseOutcome, number> & { total: number };
  assertions: {
    total: number;
    passed: number;
    failed: number;
    unscored: number;
  };
}
export function evaluationStatistics(
  rows: StatisticsCase[],
): EvaluationStatistics {
  const cases: EvaluationStatistics["cases"] = {
    total: rows.length,
    passed: 0,
    failed: 0,
    error: 0,
    not_run: 0,
    running: 0,
    queued: 0,
    missing: 0,
  };
  const assertions = { total: 0, passed: 0, failed: 0, unscored: 0 };
  for (const row of rows) {
    const outcome =
      row.status === "finished"
        ? row.outcome || "missing"
        : row.status || "missing";
    cases[outcome]++;
    assertions.total += row.assertion_keys.length;
    for (const key of row.assertion_keys) {
      const checks = row.checks.filter((check) => check.key === key);
      // Errors, unfinished cases and missing/ambiguous grades are not failed assertions.
      if (
        (outcome === "passed" || outcome === "failed") &&
        checks.length === 1
      ) {
        assertions[checks[0].passed ? "passed" : "failed"]++;
      } else assertions.unscored++;
    }
  }
  return { cases, assertions };
}
