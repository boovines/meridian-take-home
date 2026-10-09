import { afterEach, expect, it, vi } from "vitest";
import { meteredOpenAIFetch } from "../src/server/integrations/openai-client";
import { DomainError } from "../src/domain/errors";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const request = { method: "POST", body: JSON.stringify({ model: "gpt-5.4", input: "fixture", max_output_tokens: 100 }) };

it("bounds a stalled response body and preserves the unknown charge without retrying", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-deadline-"));
  const file = path.join(dir, "ledger.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", file); vi.stubEnv("INFERENCE_BUDGET_USD", "1");
  vi.useFakeTimers();
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  let calls = 0, transportSignal: AbortSignal | null | undefined, failure: unknown;
  const base: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/input_tokens")) return Response.json({ input_tokens: 10 });
    calls++; transportSignal = init?.signal; dispatched();
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("{")); } }));
  };
  try {
    const pending = meteredOpenAIFetch(base, true)("https://api.openai.com/v1/responses", request).catch(e => { failure = e; });
    await started;
    await vi.advanceTimersByTimeAsync(180001);
    expect(failure).toMatchObject({ code: "MODEL_RESPONSE_TIMEOUT", details: { stage: "model_response", timeout_ms: 180000 } });
    await pending;
    expect(transportSignal?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(JSON.parse(await readFile(file, "utf8")).charges[0].state).toBe("reserved");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("enforces a response deadline even without the optional spend guard", async () => {
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", ""); vi.stubEnv("INFERENCE_BUDGET_USD", ""); vi.useFakeTimers();
  let failure: unknown;
  const base = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const pending = meteredOpenAIFetch(base, true)("https://api.openai.com/v1/responses", request).catch(e => { failure = e; });
  await vi.advanceTimersByTimeAsync(180001);
  expect(failure).toMatchObject({ code: "MODEL_RESPONSE_TIMEOUT" }); await pending;
  expect(base).toHaveBeenCalledTimes(1);
});

it("preserves caller cancellation instead of reporting a provider timeout", async () => {
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", ""); vi.stubEnv("INFERENCE_BUDGET_USD", "");
  const controller = new AbortController(), reason = new Error("User cancelled");
  const pending = meteredOpenAIFetch(async (_url, init) => {
    controller.abort(reason); init?.signal?.throwIfAborted(); return Response.json({});
  }, true)("https://api.openai.com/v1/responses", { ...request, signal: controller.signal });
  await expect(pending).rejects.toBe(reason);
});

it("classifies model timeout as infrastructure without making it eligible for blind case replay", async () => {
  const { invocationFailure } = await import("../src/server/runtime/invoke-step");
  const { canRecoverCase } = await import("../src/domain/evaluation-recovery");
  const { evaluationConfiguration } = await import("../src/server/evaluations/configuration");
  const failure = invocationFailure(new DomainError(503, "MODEL_RESPONSE_TIMEOUT", "Timed out"));
  expect(failure.category).toBe("infrastructure");
  expect(canRecoverCase(evaluationConfiguration(), failure, 0)).toBe(false);
});

it("gives the response its full allowance after a slow preflight and settles once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-stage-"));
  const file = path.join(dir, "ledger.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", file); vi.stubEnv("INFERENCE_BUDGET_USD", "1");
  vi.useFakeTimers();
  let dispatched!: () => void;
  const started = new Promise<void>(r => { dispatched = r; });
  const base: typeof fetch = async (url) => {
    if (String(url).endsWith("/input_tokens")) {
      await new Promise(r => setTimeout(r, 30000));
      return Response.json({ input_tokens: 10 });
    }
    dispatched();
    await new Promise(r => setTimeout(r, 170000));
    return Response.json({ id: "fixture", model: "gpt-5.4", service_tier: "default", usage: { input_tokens: 10, output_tokens: 5 } });
  };
  try {
    const pending = meteredOpenAIFetch(base, true)("https://api.openai.com/v1/responses", request);
    await vi.advanceTimersByTimeAsync(30000); await started;
    await vi.advanceTimersByTimeAsync(170000);
    expect((await pending).ok).toBe(true);
    const ledger = JSON.parse(await readFile(file, "utf8"));
    expect(ledger.charges).toHaveLength(1); expect(ledger.charges[0].state).toBe("settled");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("retains timeout stage evidence before any postprocessing can publish output", async () => {
  const { invokeApprovedStep } = await import("../src/server/runtime/invoke-step");
  const events: {kind: string; payload: unknown; summary: unknown}[] = [];
  const invoke = vi.fn(async () => ({ kind: "reason", instructions: "Read fixture", data: {}, document_ids: [] }));
  const timing = { stage: "model_response", timeout_ms: 180000, elapsed_ms: 180001 };
  await expect(invokeApprovedStep({ files: {} } as import("../src/domain/project").Project, "node", "agent", {}, {
    invoke, reason: async () => { throw new DomainError(503, "MODEL_RESPONSE_TIMEOUT", "Response timed out", timing); },
  }, new AbortController().signal, undefined, async (kind, payload, summary) => { events.push({kind,payload,summary}); }))
    .rejects.toMatchObject({code: "MODEL_RESPONSE_TIMEOUT"});
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(events.map(e => e.kind)).toEqual(["initial_output", "model_request", "failure"]);
  expect(events[2]).toMatchObject({ payload: {code: "MODEL_RESPONSE_TIMEOUT", category: "infrastructure", timing}, summary: {timing} });
});

it("requires a fresh evaluation configuration after changing deadline policy", async () => {
  const { evaluationConfiguration, assertEvaluationConfiguration } = await import("../src/server/evaluations/configuration");
  const config = evaluationConfiguration() as Record<string, import("../src/domain/runtime").Json>;
  expect(config.deadlines).toMatchObject({model_response_ms: 180000, step_ms: 720000, model_sdk_retries: 0});
  delete config.deadlines;
  expect(() => assertEvaluationConfiguration(config)).toThrow("Execution settings changed");
});

it("preserves the timeout through the real runtime SDK and does not retry the model", async () => {
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", ""); vi.stubEnv("INFERENCE_BUDGET_USD", "");
  vi.stubEnv("OPENAI_API_KEY", "fixture-key"); vi.useFakeTimers();
  const base = vi.fn<typeof fetch>(() => new Promise(() => {})); vi.stubGlobal("fetch", base);
  const { reasonForStep } = await import("../src/server/integrations/openai-step");
  let failure: unknown;
  const pending = reasonForStep("Read fixture", {}, new AbortController().signal).catch(e => { failure = e; });
  await vi.advanceTimersByTimeAsync(180001);
  expect(failure).toMatchObject({code: "MODEL_RESPONSE_TIMEOUT"}); await pending;
  expect(base).toHaveBeenCalledTimes(1);
});
