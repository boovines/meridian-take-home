import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
const state = vi.hoisted(() => ({ model: undefined as unknown }));
vi.mock("../src/server/integrations/openai-client", () => ({ runtimeOpenAI: () => state.model }));
import { reasonForStep } from "../src/server/integrations/openai-step";

it.each([undefined, [3, 9]])("preserves original PDF page identities in model captions: %j", async (pages) => {
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: "text", text: '{"seller":"Example Ltd"}' }],
    finishReason: { unified: "stop", raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 1, text: 1, reasoning: undefined } },
    warnings: [],
  }) });
  state.model = model;
  expect(await reasonForStep("Read seller", {}, AbortSignal.timeout(10000), [{
    artifact_id: "fixture-source", name: "source.pdf", media_type: "application/pdf",
    bytes: Buffer.from("%PDF-1.7\nfixture"), source_page_numbers: pages,
  }])).toEqual({ seller: "Example Ltd" });
  expect(model.doGenerateCalls).toHaveLength(1);
  const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
  expect(prompt).toContain("Captured document fixture-source: source.pdf");
  if (pages) expect(prompt).toContain("original source pages 3, 9. Cite original source page numbers.");
  else expect(prompt).not.toContain("original source pages");
});
