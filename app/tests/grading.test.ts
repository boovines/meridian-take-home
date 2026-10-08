import { expect, it } from "vitest";
import { grade, verdict, regressionDecision } from "../src/domain/grading";
import { assertionSchema, type CaseResult } from "../src/domain/evaluation";
import type { Json } from "../src/domain/runtime";
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
it("checks record membership regardless of order without normalizing values or matching partial nested objects", () => {
  const records: Json[] = [
    { batch: "RAW-7", document: "source-b", page: 2, detail: { a: 1, b: 2 } },
    { batch: "RAW-9", document: "source-a", page: 1 },
  ];
  const definitions = [
    {
      operator: "contains_record",
      expected: { document: "source-a", batch: "RAW-9" },
    },
    { operator: "excludes_record", expected: { batch: "RAW-9A" } },
    { operator: "contains_record", expected: { batch: "raw-9" } },
    {
      operator: "contains_record",
      expected: { batch: "RAW-9", document: "source-b" },
    },
    { operator: "contains_record", expected: { detail: { a: 1 } } },
    { operator: "contains_record", expected: { detail: { b: 2, a: 1 } } },
    { operator: "excludes_record", expected: { batch: "RAW-7" } },
  ].map((a, i) =>
    assertionSchema.parse({
      key: `r${i}`,
      label: `Record ${i}`,
      path: ["records"],
      ...a,
    }),
  );
  for (const values of [records, [...records].reverse()]) {
    const checks = grade({ records: values }, definitions);
    expect(checks.map((c) => c.passed)).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(checks[0].actual).toEqual(values);
  }
});
it("cannot prove record presence or absence from missing or non-array evidence", () => {
  for (const operator of ["contains_record", "excludes_record"] as const) {
    const a = assertionSchema.parse({
      key: "r",
      label: "Record",
      path: ["records"],
      operator,
      expected: { id: null },
    });
    const invalidOutputs: Json[] = [
      {},
      { records: null },
      { records: {} },
      { records: "bad" },
    ];
    for (const output of invalidOutputs)
      expect(grade(output, [a])[0].passed).toBe(false);
    expect(grade({ records: [null, 3, "bad", [], {}] }, [a])[0].passed).toBe(
      operator === "excludes_record",
    );
    expect(grade({ records: [{ id: null }] }, [a])[0].passed).toBe(
      operator === "contains_record",
    );
    expect(grade({ records: [] }, [a])[0].passed).toBe(
      operator === "excludes_record",
    );
  }
});
it("requires nonempty record expectations and keeps legacy equality definitions unchanged", () => {
  const legacy = { key: "r", label: "Exact", path: [], expected: [] };
  expect(assertionSchema.parse(legacy)).toEqual(legacy);
  for (const operator of ["contains_record", "excludes_record"])
    for (const expected of [null, [], {}, 5, "batch"])
      expect(
        assertionSchema.safeParse({ ...legacy, operator, expected }).success,
      ).toBe(false);
  expect(
    assertionSchema.safeParse({ ...legacy, operator: "fuzzy" }).success,
  ).toBe(false);
  expect(grade([1, 2], [{ ...legacy, expected: [2, 1] }])[0].passed).toBe(
    false,
  );
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

it("checks explicit source text and array membership without fuzzy identifiers or unit conversion", () => {
  const actual = { manufacturer: "Example Pharma Ltd., Unit 2", strength: "10 mg / 2 mL", batches: ["ABC-1A"] };
  const checks = [
    { key: "name", label: "Manufacturer", path: ["manufacturer"], operator: "text_includes" as const, expected: "EXAMPLE PHARMA" },
    { key: "dose", label: "Printed strength", path: ["strength"], operator: "text_includes" as const, expected: "10mg/2mL" },
    { key: "wrong", label: "Wrong strength", path: ["strength"], operator: "text_includes" as const, expected: "10mg/mL" },
    { key: "batch", label: "Raw batch", path: ["batches"], operator: "array_includes" as const, expected: "ABC-1A" },
    { key: "suffix", label: "No suffix stripping", path: ["batches"], operator: "array_includes" as const, expected: "ABC-1" },
    { key: "missing", label: "Missing", path: ["absent"], operator: "text_includes" as const, expected: "value" },
  ];
  expect(grade(actual, checks).map(c => c.passed)).toEqual([true, true, false, true, false, false]);
});
