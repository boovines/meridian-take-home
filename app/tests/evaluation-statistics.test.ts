import { expect, it } from "vitest";
import {
  evaluationStatistics,
  type StatisticsCase,
} from "../src/domain/evaluation-statistics";
const row = (overrides: Partial<StatisticsCase> = {}): StatisticsCase => ({
  assertion_keys: ["a", "b"],
  status: "finished",
  outcome: "passed",
  checks: [
    { key: "a", passed: true },
    { key: "b", passed: true },
  ],
  ...overrides,
});
it("keeps assertion failures separate from errors, pending and missing evidence", () => {
  const stats = evaluationStatistics([
    row(),
    row({
      outcome: "failed",
      checks: [
        { key: "a", passed: true },
        { key: "b", passed: false },
      ],
    }),
    row({ outcome: "error" }),
    row({ outcome: "not_run" }),
    row({ status: "running", outcome: null }),
    row({ status: "queued", outcome: null }),
    row({ status: null, outcome: null }),
  ]);
  expect(stats).toEqual({
    cases: {
      total: 7,
      passed: 1,
      failed: 1,
      error: 1,
      not_run: 1,
      running: 1,
      queued: 1,
      missing: 1,
    },
    assertions: { total: 14, passed: 3, failed: 1, unscored: 10 },
  });
});
it("counts only uniquely recorded locked assertion keys; missing grades cannot inflate scores", () => {
  expect(
    evaluationStatistics([
      row({
        checks: [
          { key: "a", passed: true },
          { key: "a", passed: true },
          { key: "foreign", passed: true },
        ],
      }),
    ]).assertions,
  ).toEqual({ total: 2, passed: 0, failed: 0, unscored: 2 });
  expect(evaluationStatistics([]).cases.total).toBe(0);
});
