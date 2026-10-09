import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { generateText, Output } from "ai";
import { z } from "zod";
import { rewriteReviewReply } from "../src/server/integrations/openai-review-reply";
import type { ReplyContext } from "../src/domain/review-reply";
vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
  Output: { object: vi.fn(() => ({})) },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MERIDIAN_REVIEW_PROVIDER", "openai");
  vi.mocked(generateText).mockResolvedValue({
    finishReason: "stop",
    output: {
      outcome: "no_change",
      updates: [],
      explanation: "Already clear.",
    },
  } as never);
});
afterEach(() => vi.unstubAllEnvs());
const context = {
  board: {
    workflow: { desired_outcome: "Report results" },
    nodes: [],
    connections: [],
  },
  targets: [],
  thread: { title: "What fields?" },
  messages: [],
  answer: "Require batch numbers.",
} as unknown as ReplyContext;
it("sends the answer and current context with a bounded, serializable instruction-only output contract", async () => {
  await rewriteReviewReply(context, AbortSignal.timeout(1000));
  const call = vi.mocked(generateText).mock.calls[0][0];
  expect(JSON.parse(call.prompt as string)).toEqual(context);
  expect(call.maxRetries).toBe(0);
  expect(call.maxOutputTokens).toBe(12000);
  expect(call.system).toContain("Preserve all unrelated requirements");
  const schema = vi.mocked(Output.object).mock.calls[0][0].schema as z.ZodType;
  expect(() => z.toJSONSchema(schema)).not.toThrow();
  expect(
    schema.safeParse({
      outcome: "updated",
      explanation: "Edited",
      updates: [
        {
          node_id: randomUUID(),
          instructions: "Require batch numbers",
          type: "task",
        },
      ],
    }).success,
  ).toBe(false);
});
it("rejects oversized context without an inference call", async () => {
  await expect(
    rewriteReviewReply(
      { ...context, answer: "x".repeat(180001) },
      AbortSignal.timeout(1000),
    ),
  ).rejects.toMatchObject({ code: "CONTEXT_TOO_LARGE" });
  expect(generateText).not.toHaveBeenCalled();
});
it("does not silently fall back to the fixture for a non-local database", async () => {
  vi.stubEnv("MERIDIAN_REVIEW_PROVIDER", "fixture");
  vi.stubEnv("MERIDIAN_DATABASE", "postgres");
  vi.stubEnv("MERIDIAN_LOCAL_DEMO", "true");
  await rewriteReviewReply(context, AbortSignal.timeout(1000));
  expect(generateText).toHaveBeenCalledTimes(1);
});
