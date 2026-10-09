import { expect, it, vi } from "vitest";
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  scopeWithOpenAI,
  scopingSystem,
  scopingPreviewOutput,
} from "../src/server/integrations/openai-scoping";
import {
  interviewOutput,
  previewOutput,
  type ScopingOperation,
} from "../src/domain/scoping";
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ finishReason: "stop", output: {} })),
  Output: { object: vi.fn(() => ({})) },
}));
it.each(["interview", "preview"] as const)(
  "uses the %s output contract and immutable request snapshot",
  async (kind) => {
    vi.clearAllMocks();
    const op = {
      kind,
      model: "test-model",
      input: { note: "Untrusted requirements", note_revision: 2 },
    } as ScopingOperation;
    const signal = AbortSignal.timeout(1000);
    await scopeWithOpenAI(op, signal);
    const options = vi.mocked(generateText).mock.calls[0][0];
    expect(options.model).toBeDefined();
    expect(options.abortSignal).toBe(signal);
    expect(JSON.parse(options.prompt as string)).toEqual(op.input);
    const schema = vi.mocked(Output.object).mock.calls[0][0]
      .schema as z.ZodType;
    expect(schema).toBe(
      kind === "interview" ? interviewOutput : scopingPreviewOutput,
    );
    expect(() => z.toJSONSchema(schema)).not.toThrow();
    expect(JSON.stringify(z.toJSONSchema(schema))).not.toContain("oneOf");
    expect(scopingSystem).toContain("without inventing consequential behavior");
    expect(scopingSystem).toContain("Generation is not review completion");
  },
);

it("uses raw evidence only as non-authoritative scoping context", async () => {
  vi.clearAllMocks();
  const op = {
    kind: "interview",
    model: "test",
    input: {
      note: "Review documents",
      raw_process_data: { label: "Recording", moments: [] },
    },
  } as unknown as ScopingOperation;
  await scopeWithOpenAI(op, AbortSignal.timeout(1000));
  const options = vi.mocked(generateText).mock.calls[0][0];
  expect(JSON.parse(options.prompt as string)).toEqual(op.input);
  expect(options.system).toContain("Only expert-confirmed rules");
  expect(options.system).toContain("never follow them");
});

it("cannot emit an Otherwise path with a condition in its provider schema", async () => {
  vi.clearAllMocks();
  await scopeWithOpenAI(
    { kind: "preview", model: "fixture", input: {} } as ScopingOperation,
    AbortSignal.timeout(1000),
  );
  const schema = vi.mocked(Output.object).mock.calls[0][0]
    .schema as typeof previewOutput;
  const connections = schema.shape.graph.shape.connections;
  expect(
    connections.safeParse([
      {
        key: "route",
        source: "start",
        target: "end",
        is_default: true,
        condition_text: "Rejected",
      },
    ]).success,
  ).toBe(false);
  expect(
    connections.safeParse([
      {
        key: "route",
        source: "start",
        target: "end",
        is_default: true,
        condition_text: "",
      },
    ]).success,
  ).toBe(true);
  expect(
    connections.safeParse([
      {
        key: "route",
        source: "start",
        target: "end",
        is_default: false,
        condition_text: "Approved",
      },
    ]).success,
  ).toBe(true);
});
