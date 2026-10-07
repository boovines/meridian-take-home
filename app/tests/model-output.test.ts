import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
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
beforeEach(() => { generate.mockReset(); });
describe("model output boundaries", () => {
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
