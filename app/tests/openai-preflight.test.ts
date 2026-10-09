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
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
const request = {
  method: "POST",
  body: JSON.stringify({ model: "gpt-5.4", input: "sanitized fixture", max_output_tokens: 100 }),
};
const inferenceResponse = () => Response.json({
  id: "fixture-response", model: "gpt-5.4", service_tier: "default", usage: { input_tokens: 10, output_tokens: 5 },
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
  expect(current).toMatchObject({ inference_preflight: { version: "bounded-v2", max_attempts: 3 } });
  const legacy = { ...current as Record<string, Json> };
  delete legacy.inference_preflight;
  expect(() => assertEvaluationConfiguration(legacy)).toThrow("Execution settings changed");
});

it("preserves caller cancellation during response-body reading", async () => {
  const controller = new AbortController(), reason = new Error("fixture cancellation");
  const response = Response.json({ input_tokens: 10 });
  vi.spyOn(response, "json").mockImplementation(async () => {
    controller.abort(reason);
    throw new DOMException("body aborted", "AbortError");
  });
  const base = vi.fn<typeof fetch>(async () => response);
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", { ...request, signal: controller.signal })).rejects.toBe(reason);
  expect(base).toHaveBeenCalledTimes(1);
  await expect(readFile(path.join(dir, "ledger.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("classifies its own deadline as infrastructure and retains safe failure evidence", async () => {
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  const base = vi.fn<typeof fetch>(async () => {
    timeout.abort(new DOMException("deadline", "TimeoutError"));
    throw new TypeError("fixture private transport details");
  });
  const error = await meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request).catch(error => error);
  expect(error).toMatchObject({ code: "BUDGET_UNAVAILABLE", details: { preflight_attempts: 1, preflight_failures: ["deadline"] } });
  const { invocationFailure } = await import("../src/server/runtime/invoke-step");
  expect(invocationFailure(error).category).toBe("infrastructure");
  expect(error.message).not.toContain("private transport");
  expect(base).toHaveBeenCalledTimes(1);
  await expect(readFile(path.join(dir, "ledger.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not retry unexpected transport errors or discard exhausted HTTP evidence", async () => {
  const base = vi.fn<typeof fetch>(async () => { throw new Error("private bug details"); });
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({
    code: "BUDGET_UNAVAILABLE", details: { preflight_attempts: 1, preflight_failures: ["transport_nonretryable"] },
  });
  expect(base).toHaveBeenCalledTimes(1);
  const unavailable = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  await expect(meteredOpenAIFetch(unavailable)("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({
    code: "BUDGET_UNAVAILABLE", details: { preflight_attempts: 3, preflight_failures: ["http_503", "http_503", "http_503"] },
  });
});

it("retains the priced request and settles usage after transient recovery", async () => {
  const bodies: string[] = [];
  let inferences = 0;
  const response = await meteredOpenAIFetch(async (url, init) => {
    if (String(url).endsWith("/input_tokens")) {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response(null, { status: 429, headers: { "retry-after": new Date(0).toUTCString() } })
        : Response.json({ input_tokens: 10 });
    }
    inferences++;
    expect(JSON.parse(String(init?.body))).toMatchObject({ service_tier: "default", input: "sanitized fixture" });
    return inferenceResponse();
  })("https://api.openai.com/v1/responses", request);
  expect(response.ok).toBe(true);
  expect(bodies[0]).toBe(bodies[1]);
  expect(inferences).toBe(1);
  const ledger = JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8"));
  expect(ledger.charges).toHaveLength(1);
  expect(ledger.charges[0]).toMatchObject({
    state: "settled", metadata: { preflight_attempts: 2, preflight_failures: ["http_429"], service_tier: "default" },
  });
});

it("keeps failed inference reserved and does not retry it inside preflight recovery", async () => {
  let inferences = 0;
  const response = await meteredOpenAIFetch(async url => {
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 10 });
    inferences++; return new Response(null, { status: 500 });
  })("https://api.openai.com/v1/responses", request);
  expect(response.status).toBe(500);
  expect(inferences).toBe(1);
  const ledger = JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8"));
  expect(ledger.charges[0]).toMatchObject({ state: "reserved", metadata: { http_status: 500 } });
});

it.each([-1, 1.5, 240001, "10"])("fails closed for invalid token count %s", async input_tokens => {
  const base = vi.fn<typeof fetch>(async () => Response.json({ input_tokens }));
  await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", request)).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
  expect(base).toHaveBeenCalledTimes(1);
  await expect(readFile(path.join(dir, "ledger.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("separates enabled, disabled and changed preflight configurations", () => {
  const enabled = evaluationConfiguration() as Record<string, Json>;
  const oldPolicy = { ...enabled, inference_preflight: { ...enabled.inference_preflight as Record<string, Json>, version: "bounded-v1" } };
  expect(() => assertEvaluationConfiguration(oldPolicy)).toThrow("Execution settings changed");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", ""); vi.stubEnv("INFERENCE_BUDGET_USD", "");
  expect(evaluationConfiguration()).toMatchObject({ inference_preflight: null });
  expect(() => assertEvaluationConfiguration(enabled)).toThrow("Execution settings changed");
});

it("retries an interrupted count response body but never retries malformed JSON", async () => {
  const interrupted = Response.json({ input_tokens: 10 });
  vi.spyOn(interrupted, "json").mockRejectedValue(new TypeError("fixture connection terminated"));
  let counts = 0, inferences = 0;
  await meteredOpenAIFetch(async url => {
    if (String(url).endsWith("/input_tokens"))
      return ++counts === 1 ? interrupted : Response.json({ input_tokens: 10 });
    inferences++; return inferenceResponse();
  })("https://api.openai.com/v1/responses", request);
  expect({ counts, inferences }).toEqual({ counts: 2, inferences: 1 });
  const ledger = JSON.parse(await readFile(path.join(dir, "ledger.json"), "utf8"));
  expect(ledger.charges[0].metadata.preflight_failures).toEqual(["response_transport"]);
});
