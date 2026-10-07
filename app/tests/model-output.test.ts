import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateText,
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
} from "ai";
import { generateProjectSources } from "../src/server/integrations/openai-engineer";
import { reasonForStep } from "../src/server/integrations/openai-step";
import { invocationFailure } from "../src/server/runtime/invoke-step";
import type { Board } from "../src/domain/canvas";

vi.mock("ai", async (original) => ({
  ...(await original<typeof import("ai")>()),
  generateText: vi.fn(),
}));
const generate = vi.mocked(generateText);
const board = {
  workflow: { name: "Output boundary check" },
  nodes: [],
  connections: [],
} as unknown as Board;
const signal = AbortSignal.timeout(10000);
const valid = { status: "ready", explanation: "Generated source", steps: [] };
function parsedFailure(finishReason: "length" | "stop") {
  return new NoObjectGeneratedError({
    finishReason,
    usage: {
      inputTokens: 200,
      outputTokens: 24000,
      totalTokens: 24200,
    } as never,
    response: {
      id: "synthetic-response",
      timestamp: new Date(),
      modelId: "fixture",
    },
    text: "private source material that must not reach an error message",
    cause: new Error("Could not parse private source material"),
  });
}
beforeEach(() => {
  generate.mockReset();
});
describe("model output boundaries", () => {
  it.each([false, true])(
    "reports a project spending cap safely (SDK retry wrapper: %s)",
    async (wrapped) => {
      const provider = new APICallError({
        message: "private provider diagnostic",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: { prompt: "private document" },
        statusCode: 429,
        responseBody: JSON.stringify({
          error: {
            code: "project_spend_limit_exceeded",
            type: "insufficient_quota",
            message: "private provider diagnostic",
          },
        }),
        isRetryable: true,
      });
      generate.mockRejectedValue(
        wrapped
          ? new RetryError({
              message: "private retry diagnostic",
              reason: "maxRetriesExceeded",
              errors: [provider, provider],
            })
          : provider,
      );
      const failure = await generateProjectSources(board, [], null, signal).catch(
        (error) => error,
      );
      expect(failure).toMatchObject({
        code: "MODEL_PROJECT_SPEND_LIMIT",
        status: 503,
      });
      expect(failure.message).toContain("project's spending limit");
      expect(JSON.stringify(failure)).not.toContain("private");
      expect(invocationFailure(failure).category).toBe("infrastructure");
    },
  );
  it("classifies exhausted quota as infrastructure rather than repairable code", async () => {
    generate.mockRejectedValue(
      new APICallError({
        message: "private diagnostic",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 429,
        data: { error: { code: "insufficient_quota", type: "insufficient_quota" } },
      }),
    );
    const failure = await reasonForStep("Read this example", {}, signal).catch(
      (error) => error,
    );
    expect(invocationFailure(failure)).toMatchObject({
      code: "MODEL_QUOTA_EXCEEDED",
      category: "infrastructure",
    });
  });
  it("leaves transient rate limits eligible for the existing provider retry path", async () => {
    const provider = new APICallError({
      message: "Retry later",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: {},
      statusCode: 429,
      data: { error: { code: "rate_limit_exceeded", type: "tokens" } },
    });
    generate.mockRejectedValue(provider);
    await expect(generateProjectSources(board, [], null, signal)).rejects.toBe(
      provider,
    );
  });
  it("preserves cancellation during an SDK retry instead of reporting quota", async () => {
    const aborted = new RetryError({
      message: "Aborted during retry",
      reason: "abort",
      errors: [new APICallError({
        message: "Quota exhausted",
        url: "https://api.openai.com/v1/responses",
        requestBodyValues: {},
        statusCode: 429,
        data: { error: { code: "project_spend_limit_exceeded" } },
      })],
    });
    generate.mockRejectedValue(aborted);
    await expect(generateProjectSources(board, [], null, signal)).rejects.toBe(aborted);
  });
  it("reports an exhausted response budget even when the SDK output getter throws", async () => {
    generate.mockResolvedValue({
      finishReason: "length",
      get output() {
        throw new NoOutputGeneratedError();
      },
    } as never);
    await expect(
      generateProjectSources(board, [], null, signal),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
  });
  it("does not publish partial structured output and does not expose source in errors", async () => {
    generate.mockRejectedValue(parsedFailure("length"));
    const failure = await generateProjectSources(board, [], null, signal).catch(
      (error) => error,
    );
    expect(failure).toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(String(failure.message)).not.toContain("private source");
    expect(JSON.stringify(failure.details)).not.toContain("private source");
  });
  it("distinguishes a schema-invalid complete response from a provider outage", async () => {
    generate.mockRejectedValue(parsedFailure("stop"));
    await expect(
      generateProjectSources(board, [], null, signal),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_INVALID" });
  });
  it("keeps bounded interpretation failures eligible for prompt repair", async () => {
    generate.mockRejectedValue(parsedFailure("length"));
    const failure = await reasonForStep("Read this example", {}, signal).catch(
      (error) => error,
    );
    expect(invocationFailure(failure)).toMatchObject({
      code: "MODEL_OUTPUT_LIMIT",
      category: "implementation",
    });
  });
  it("preserves a complete successful response", async () => {
    generate.mockResolvedValue({
      finishReason: "stop",
      output: valid,
    } as never);
    await expect(
      generateProjectSources(board, [], null, signal),
    ).resolves.toEqual(valid);
  });
});
