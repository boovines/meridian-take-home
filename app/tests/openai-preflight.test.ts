import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { meteredOpenAIFetch } from "../src/server/integrations/openai-client";
import { evaluationConfiguration, assertEvaluationConfiguration } from "../src/server/evaluations/configuration";
import type { Json } from "../src/domain/runtime";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "meridian-preflight-"));
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", path.join(dir, "ledger.json"));
  vi.stubEnv("INFERENCE_BUDGET_USD", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const request = {
  method: "POST",
  body: JSON.stringify({ model: "gpt-5.4", input: "sanitized fixture", max_output_tokens: 100 }),
};
const inferenceResponse = () => Response.json({
  id: "fixture-response", model: "gpt-5.4", usage: { input_tokens: 10, output_tokens: 5 },
});

it("recovers a token-count 500 before making exactly one reserved inference", async () => {
  let counts = 0, inferences = 0;
  const base: typeof fetch = async (input) => {
    if (String(input).endsWith("/input_tokens"))
      return ++counts === 1 ? new Response(null, { status: 500 }) : Response.json({ input_tokens: 10 });
    inferences++;
    const ledger = JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8"));
    expect(ledger.charges).toHaveLength(1);
    expect(ledger.charges[0]).toMatchObject({ state: "reserved", metadata: { preflight_attempts: 2, preflight_failures: ["http_500"] } });
    return inferenceResponse();
  };
  await meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request);
  expect({ counts, inferences }).toEqual({ counts: 2, inferences: 1 });
});

it("stops after three transient failures without making a reservation or inference", async () => {
  const calls: string[] = [];
  await expect(meteredOpenAIFetch(async (url) => {
    calls.push(String(url)); return new Response(null, { status: 503 });
  })("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({
    code: "BUDGET_UNAVAILABLE", message: expect.stringContaining("after 3 attempts"),
  });
  expect(calls).toHaveLength(3);
  expect(calls.every(url => url.endsWith("/input_tokens"))).toBe(true);
  await expect(readFile(path.join(dir, "ledger.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([401, 403, 422])("does not retry permanent HTTP %s failures", async status => {
  const base = vi.fn<typeof fetch>(async () => new Response(null, { status }));
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
  expect(base).toHaveBeenCalledTimes(1);
});

it("recovers a transport failure without duplicating inference", async () => {
  let counts = 0, inferences = 0;
  await meteredOpenAIFetch(async url => {
    if (String(url).endsWith("/input_tokens")) {
      if (++counts === 1) throw new TypeError("fixture network interruption");
      return Response.json({ input_tokens: 10 });
    }
    inferences++; return inferenceResponse();
  })("https://api.openai.com/v1/responses", request);
  expect({ counts, inferences }).toEqual({ counts: 2, inferences: 1 });
});

it("cancels during backoff before another request or inference", async () => {
  const controller = new AbortController();
  const base = vi.fn<typeof fetch>(async () => {
    setTimeout(() => controller.abort(), 10);
    return new Response(null, { status: 500 });
  });
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", { ...request, signal: controller.signal })).rejects.toBeDefined();
  expect(base).toHaveBeenCalledTimes(1);
});

it("rejects late success after the caller deadline, even if a transport ignores abort", async () => {
  const controller = new AbortController();
  const base = vi.fn<typeof fetch>(async () => {
    controller.abort(new Error("fixture deadline"));
    return Response.json({ input_tokens: 10 });
  });
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", { ...request, signal: controller.signal })).rejects.toThrow("fixture deadline");
  expect(base).toHaveBeenCalledTimes(1);
});

it("does not send inference on malformed successful counts or an excessive retry-after", async () => {
  for (const response of [Response.json({ input_tokens: null }), new Response("invalid"), new Response(null, { status: 429, headers: { "retry-after": "3600" } })]) {
    const base = vi.fn<typeof fetch>(async () => response);
    await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
    expect(base).toHaveBeenCalledTimes(1);
  }
});

it("records the retry policy and rejects historical configurations without it", () => {
  const current = evaluationConfiguration();
  expect(current).toMatchObject({ inference_preflight: { version: "bounded-v1", max_attempts: 3 } });
  const legacy = { ...current as Record<string, Json> };
  delete legacy.inference_preflight;
  expect(() => assertEvaluationConfiguration(legacy)).toThrow("Execution settings changed");
});
