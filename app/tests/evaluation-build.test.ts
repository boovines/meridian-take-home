import { afterEach, expect, it, vi } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import { DomainError } from "../src/domain/canvas";
import { EvaluationExecutionService } from "../src/server/evaluations/execution-service";
import { checkEvaluationBuild } from "../src/worker/evaluation-activities";

vi.mock("../src/server/database", () => ({
  getDatabase: vi.fn(async () => ({})),
}));
afterEach(() => vi.restoreAllMocks());

it("preserves bounded compiler evidence when a candidate cannot build", async () => {
  const diagnostic = "steps/outcome.mjs:18\nSyntaxError: Unexpected identifier";
  vi.spyOn(EvaluationExecutionService.prototype, "build").mockRejectedValue(
    new DomainError(422, "PROJECT_BUILD_FAILED", "Syntax validation failed.", {
      diagnostic: diagnostic + "x".repeat(5000),
    }),
  );
  const result = (await new MockActivityEnvironment().run(
    checkEvaluationBuild,
    "evaluation",
  )) as Awaited<ReturnType<typeof checkEvaluationBuild>>;
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failed build");
  expect(result.error).toMatchObject({
    code: "PROJECT_BUILD_FAILED",
    category: "implementation",
  });
  expect(result.error.message).toContain(diagnostic);
  expect(result.error.message.length).toBeLessThan(2600);
});

it("does not expose provider diagnostics as generated-code failures", async () => {
  vi.spyOn(EvaluationExecutionService.prototype, "build").mockRejectedValue(
    new DomainError(503, "SANDBOX_UNAVAILABLE", "Sandbox unavailable.", {
      diagnostic: "private provider request",
    }),
  );
  const result = await new MockActivityEnvironment().run(
    checkEvaluationBuild,
    "evaluation",
  );
  expect(result).toEqual({
    ok: false,
    error: {
      code: "SANDBOX_UNAVAILABLE",
      message: "Sandbox unavailable.",
      category: "infrastructure",
    },
  });
});
