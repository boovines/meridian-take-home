import { expect, it } from "vitest";
import { grade, verdict, regressionDecision } from "../src/domain/grading";
import type { CaseResult } from "../src/domain/evaluation";
it("distinguishes missing fields from explicit null and compares complete structured values", () => {
  const checks = grade(
    {
      invoice: { failed_goods: 1, missing_fields: ["HTS", "NDC"], note: null },
    },
    [
      {
        key: "goods",
        label: "One failed good",
        path: ["invoice", "failed_goods"],
        expected: 1,
      },
      {
        key: "fields",
        label: "Two missing fields",
        path: ["invoice", "missing_fields"],
        expected: ["HTS", "NDC"],
      },
      {
        key: "null",
        label: "Null note",
        path: ["invoice", "note"],
        expected: null,
      },
      {
        key: "absent",
        label: "Missing note",
        path: ["invoice", "absent"],
        expected: null,
      },
    ],
  );
  expect(checks.map((c) => c.passed)).toEqual([true, true, true, false]);
  expect(checks[3].missing).toBe(true);
  expect(
    grade({ b: 2, a: 1 }, [
      { key: "object", label: "Object", path: [], expected: { a: 1, b: 2 } },
    ])[0].passed,
  ).toBe(true);
});
function result(
  id: string,
  passes: boolean[],
  outcome: CaseResult["outcome"] = "passed",
) {
  return {
    case_id: id,
    suite_version_id: "suite",
    status: "finished",
    outcome,
    check_results: passes.map((passed, i) => ({
      key: `c${i}`,
      label: `Assertion ${i}`,
      passed,
      actual: passed,
      missing: false,
    })),
  } as CaseResult;
}
it("never reports incomplete, errored, blocked or empty evaluations as a pass", () => {
  expect(verdict([], 0)).toBe("inconclusive");
  expect(verdict([result("a", [true])], 2)).toBe("inconclusive");
  expect(verdict([result("a", [true]), result("b", [], "error")], 2)).toBe(
    "inconclusive",
  );
  expect(
    verdict([result("a", [false], "failed"), result("b", [true])], 2),
  ).toBe("failed");
  expect(verdict([result("a", [true]), result("b", [true])], 2)).toBe("passed");
});
it("rejects a same-count regression and accepts only a full non-regressing candidate", () => {
  const baseline = [result("a", [true, false], "failed"), result("b", [true])];
  const expected = baseline.map((r) => ({
    id: r.case_id,
    suite_version_id: "suite",
    assertions: r.check_results.map((a) => ({
      key: a.key,
      label: a.label,
      path: [],
      expected: true,
    })),
  }));
  expect(
    regressionDecision(
      baseline,
      [result("a", [false, true], "failed"), result("b", [true])],
      expected,
    ).accepted,
  ).toBe(false);
  expect(
    regressionDecision(
      baseline,
      [result("a", [true, true]), result("b", [], "error")],
      expected,
    ).accepted,
  ).toBe(false);
  expect(
    regressionDecision(
      baseline,
      [result("a", [true, true]), result("b", [true])],
      expected,
    ).accepted,
  ).toBe(true);
  expect(regressionDecision(baseline, baseline, expected).accepted).toBe(true);
  const passing = [result("a", [true, true]), result("b", [true])];
  expect(
    regressionDecision(
      baseline,
      passing.map((r) => ({ ...r, suite_version_id: "other" })),
      expected,
    ).accepted,
  ).toBe(false);
  expect(
    regressionDecision(baseline, [passing[0], passing[0]], expected).accepted,
  ).toBe(false);
  expect(
    regressionDecision(baseline, [result("a", [true]), passing[1]], expected)
      .accepted,
  ).toBe(false);
});
