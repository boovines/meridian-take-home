import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { Project } from "../src/domain/project";
import type { RepairContext } from "../src/server/repairs/generation-service";
const state = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("@ai-sdk/openai", () => ({ openai: () => state.model }));
vi.mock("../src/server/repairs/evidence", () => ({ repairPrompt: () => "Locked test context" }));
import { repairProjectSources } from "../src/server/integrations/openai-repair";

it.each(["application/pdf", "text/plain"])("feeds %s evidence back to the model, then requires a final structured patch", async (media) => {
  const id = randomUUID();
  const answer = { diagnosis: { summary: "Source inspected", affected_node_ids: [], changes: [] }, project: { status: "needs_attention", explanation: "Missing trusted source detail", steps: [] } };
  let count = 0;
  const model = new MockLanguageModelV4({ doGenerate: async () => {
    count++;
    return {
      content: count <= 3
        ? [{ type: "tool-call", toolCallId: `read-${count}`, toolName: "inspectDocument", input: JSON.stringify({ artifact_id: id }) }]
        : [{ type: "text", text: JSON.stringify(answer) }],
      finishReason: { unified: count <= 3 ? "tool-calls" : "stop", raw: undefined },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
      warnings: [],
    };
  } });
  state.model = model;
  const bytes = Buffer.from(media === "application/pdf" ? "%PDF-1.7\nfixture" : "Verified source text");
  const read = vi.fn(async () => ({ artifact_id: id, name: "source", media_type: media, bytes }));
  const result = await repairProjectSources({} as RepairContext, {} as Project, AbortSignal.timeout(10000), [], read);
  expect(result).toEqual(answer);
  expect(read).toHaveBeenCalledTimes(3);
  expect(read).toHaveBeenCalledWith(id);
  expect(model.doGenerateCalls).toHaveLength(4);
  expect(model.doGenerateCalls[3].toolChoice).toEqual({ type: "none" });
  const evidence = model.doGenerateCalls[1].prompt.find(message => message.role === "tool");
  expect(JSON.stringify(evidence)).toContain(id);
  expect(JSON.stringify(evidence)).toContain(media === "application/pdf" ? "application/pdf" : "Verified source text");
});
