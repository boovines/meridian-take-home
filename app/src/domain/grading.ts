import type { z } from "zod";
import type { Json } from "./runtime";
import type {
  assertionSchema,
  AssertionResult,
  CaseResult,
  EvaluationCase,
} from "./evaluation";
function equal(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}
export function grade(
  actual: Json,
  assertions: z.infer<typeof assertionSchema>[],
): AssertionResult[] {
  return assertions.map((a) => {
    let value: Json = actual,
      missing = false;
    for (const segment of a.path) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, segment)
      ) {
        missing = true;
        break;
      }
      value = (value as Record<string, Json>)[segment];
    }
    let passed = !missing && equal(value, a.expected);
    if (a.operator === "contains_record" || a.operator === "excludes_record") {
      const expected = a.expected;
      passed = false;
      if (
        !missing &&
        Array.isArray(value) &&
        expected !== null &&
        typeof expected === "object" &&
        !Array.isArray(expected) &&
        Object.keys(expected).length > 0
      ) {
        const contains = value.some(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            Object.entries(expected).every(
              ([key, wanted]) =>
                Object.hasOwn(item, key) && equal(item[key], wanted),
            ),
        );
        passed = a.operator === "contains_record" ? contains : !contains;
      }
    }
    if (a.operator === "text_includes") {
      const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, "");
      passed = !missing && typeof value === "string" && typeof a.expected === "string" && a.expected.trim().length > 0 && normalize(value).includes(normalize(a.expected));
    }
    if (a.operator === "array_includes") passed = !missing && Array.isArray(value) && value.some(item => equal(item, a.expected));
    return {
      key: a.key,
      label: a.label,
      passed,
      actual: missing ? null : value,
      missing,
    };
  });
}
export function verdict(
  results: Pick<CaseResult, "status" | "outcome" | "check_results">[],
  expectedCount: number,
): "passed" | "failed" | "inconclusive" {
  if (
    expectedCount === 0 ||
    results.length !== expectedCount ||
    results.some(
      (r) =>
        r.status !== "finished" ||
        !["passed", "failed"].includes(r.outcome || "") ||
        !r.check_results.length,
    )
  )
    return "inconclusive";
  return results.every(
    (r) => r.outcome === "passed" && r.check_results.every((c) => c.passed),
  )
    ? "passed"
    : "failed";
}
// Assertion identity, not a pass count, defines regression. Only compare one locked suite.
export function regressionDecision(
  baseline: CaseResult[],
  candidate: CaseResult[],
  expected: Pick<EvaluationCase, "id" | "suite_version_id" | "assertions">[],
) {
  const expectedCount = expected.length;
  const coverage = (rows: CaseResult[]) =>
    rows.length === expectedCount &&
    new Set(rows.map((r) => r.case_id)).size === expectedCount &&
    rows.every((r) =>
      expected.some(
        (c) => c.id === r.case_id && c.suite_version_id === r.suite_version_id,
      ),
    );
  const exactChecks = candidate.every((r) => {
    const c = expected.find((c) => c.id === r.case_id);
    return (
      c &&
      r.check_results.length === c.assertions.length &&
      new Set(r.check_results.map((a) => a.key)).size === c.assertions.length &&
      r.check_results.every((a) => c.assertions.some((e) => e.key === a.key))
    );
  });
  if (!coverage(baseline) || !coverage(candidate) || !exactChecks)
    return {
      accepted: false,
      reason:
        "The comparisons do not cover the same locked suite and all of its assertions.",
    };
  if (verdict(candidate, expectedCount) === "inconclusive")
    return {
      accepted: false,
      reason:
        "The candidate did not complete a determinate full-suite evaluation.",
    };
  const cases = new Map(candidate.map((r) => [r.case_id, r]));
  for (const old of baseline)
    for (const check of old.check_results.filter((c) => c.passed)) {
      if (
        !cases
          .get(old.case_id)
          ?.check_results.some((c) => c.key === check.key && c.passed)
      )
        return {
          accepted: false,
          reason: `Previously passing assertion regressed: ${check.label}`,
        };
    }
  return {
    accepted: true,
    reason:
      verdict(candidate, expectedCount) === "passed"
        ? "All verified assertions passed."
        : "Every previously passing assertion is preserved.",
  };
}
