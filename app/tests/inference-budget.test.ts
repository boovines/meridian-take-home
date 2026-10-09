import { it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InferenceBudget } from "../src/server/integrations/inference-budget";
it("serializes reservations across instances and retains unknown charges after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-budget-"));
  const file = path.join(dir, "ledger.json");
  try {
    const a = new InferenceBudget(file, 1),
      b = new InferenceBudget(file, 1);
    const reservations = await Promise.allSettled([
      a.reserve("fixture", 0.6, {}),
      b.reserve("fixture", 0.6, {}),
    ]);
    expect(reservations.filter((r) => r.status === "fulfilled")).toHaveLength(
      1,
    );
    await expect(
      new InferenceBudget(file, 1).reserve("fixture", 0.5, {}),
    ).rejects.toMatchObject({ code: "INFERENCE_BUDGET_LIMIT" });
    const winner = reservations.find((r) => r.status === "fulfilled")!;
    if (winner.status !== "fulfilled") throw Error();
    await winner.value.settle(0.2, { usage: "reported" });
    await b.reserve("fixture", 0.7, {});
    await expect(a.reserve("fixture", 0.2, {})).rejects.toMatchObject({
      code: "INFERENCE_BUDGET_LIMIT",
    });
    expect(JSON.parse(await readFile(file, "utf8")).charges).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("meters each OpenAI request before sending and holds reservations on unknown outcomes", async () => {
  const { meteredOpenAIFetch } = await import(
    "../src/server/integrations/openai-client"
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-fetch-budget-"));
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", path.join(dir, "ledger.json"));
  vi.stubEnv("INFERENCE_BUDGET_USD", "0.03");
  let inference = 0;
  const base: typeof fetch = async (input) => {
    if (String(input).endsWith("/input_tokens"))
      return Response.json({ input_tokens: 1000 });
    inference++;
    throw new Error("Response lost after dispatch");
  };
  try {
    const metered = meteredOpenAIFetch(base),
      init = {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.4",
          input: "fixture",
          max_output_tokens: 1000,
        }),
      };
    await expect(
      metered("https://api.openai.com/v1/responses", init),
    ).rejects.toThrow("Response lost");
    await expect(
      metered("https://api.openai.com/v1/responses", init),
    ).rejects.toMatchObject({ code: "INFERENCE_BUDGET_LIMIT" });
    expect(inference).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});


it("rejects corrupted negative charges instead of reopening spending capacity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-ledger-"));
  const file = path.join(dir, "ledger.json");
  const invalid = JSON.stringify({ ceiling_usd: 1, charges: [{ id: crypto.randomUUID(), provider: "openai", at: new Date().toISOString(), reserved_usd: -10, state: "reserved", metadata: {} }] });
  try {
    await writeFile(file, invalid);
    await expect(new InferenceBudget(file, 1).reserve("openai", 1, {}))
      .rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
    expect(await readFile(file, "utf8")).toBe(invalid);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("pins standard pricing and reconciles cached input usage without consuming the response", async () => {
  const { meteredOpenAIFetch } = await import("../src/server/integrations/openai-client");
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-priced-"));
  const file = path.join(dir, "ledger.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", file);
  vi.stubEnv("INFERENCE_BUDGET_USD", "1");
  const payload = { id: "fixture", model: "gpt-5.4-2026-03-05", service_tier: "default", usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } } };
  let dispatch = "";
  const base: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/input_tokens")) return Response.json({ input_tokens: 1000 });
    dispatch = String(init!.body);
    expect(JSON.parse(dispatch).service_tier).toBe("default");
    const ledger = JSON.parse(await readFile(file, "utf8"));
    expect(ledger.charges[0].state).toBe("reserved");
    return Response.json(payload);
  };
  try {
    const response = await meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-5.4", input: "private fixture content", max_output_tokens: 1000 }),
    });
    expect(await response.json()).toEqual(payload);
    const text = await readFile(file, "utf8");
    const charge = JSON.parse(text).charges[0];
    expect(charge.state).toBe("settled");
    expect(charge.actual_usd).toBeCloseTo((600 * 2.5 + 400 * 0.25 + 100 * 15) / 1e6);
    expect(text).not.toContain("private fixture content");
    expect(charge.metadata.request_sha256).toBe((await import("node:crypto")).createHash("sha256").update(dispatch).digest("hex"));
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([{}, { model: "unknown", service_tier: "default" }, { model: "gpt-5.4", service_tier: "priority" }])("retains reservations when response pricing cannot be verified: %j", async (details) => {
  const { meteredOpenAIFetch } = await import("../src/server/integrations/openai-client");
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-unknown-"));
  const file = path.join(dir, "ledger.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", file);
  vi.stubEnv("INFERENCE_BUDGET_USD", "1");
  try {
    const base: typeof fetch = async (input) => Response.json(String(input).endsWith("/input_tokens")
      ? { input_tokens: 1000 }
      : { ...details, usage: { input_tokens: 1000, output_tokens: 100 } });
    await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-5.4", input: "fixture", max_output_tokens: 1000 }),
    })).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
    expect(JSON.parse(await readFile(file, "utf8")).charges[0].state).toBe("reserved");
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not dispatch inference when token preflight fails", async () => {
  const { meteredOpenAIFetch } = await import("../src/server/integrations/openai-client");
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-preflight-"));
  const file = path.join(dir, "ledger.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", file);
  vi.stubEnv("INFERENCE_BUDGET_USD", "1");
  const cancel = vi.fn();
  const base = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel }), { status: 503 }));
  try {
    await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", {
      method: "POST", body: JSON.stringify({ model: "gpt-5.4", input: "fixture", max_output_tokens: 1000 }),
    })).rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
    expect(base).toHaveBeenCalledTimes(1);
    expect(String(base.mock.calls[0][0]).endsWith("/input_tokens")).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});

it("passes through unchanged when disabled and refuses a relative ledger path", async () => {
  const { meteredOpenAIFetch } = await import("../src/server/integrations/openai-client");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", "");
  vi.stubEnv("INFERENCE_BUDGET_USD", "");
  const response = Response.json({ passthrough: true });
  const base = vi.fn<typeof fetch>(async () => response);
  const init = { method: "POST", body: "unmodified" };
  try {
    expect(await meteredOpenAIFetch(base)("https://example.invalid", init)).toBe(response);
    expect(base).toHaveBeenCalledWith("https://example.invalid", init);
    vi.stubEnv("INFERENCE_BUDGET_LEDGER", "relative-ledger.json");
    vi.stubEnv("INFERENCE_BUDGET_USD", "1");
    await expect(meteredOpenAIFetch(base)("https://api.openai.com/v1/responses", init))
      .rejects.toMatchObject({ code: "BUDGET_UNAVAILABLE" });
    expect(base).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllEnvs();
  }
});


it("classifies spending guards as infrastructure failures, not broken generated code", async () => {
  const { invocationFailure } = await import("../src/server/runtime/invoke-step");
  const { DomainError } = await import("../src/domain/errors");
  for (const code of ["BUDGET_UNAVAILABLE", "INFERENCE_BUDGET_LIMIT"])
    expect(invocationFailure(new DomainError(503, code, "Spending guard stopped inference")))
      .toMatchObject({ code, category: "infrastructure" });
});
