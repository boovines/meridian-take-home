import { it, expect } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  const { vi } = await import("vitest");
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

it("meters the default mini model and enforces both scoped and operator ceilings", async () => {
  const { vi } = await import("vitest");
  const { withInferenceBudget } = await import(
    "../src/server/integrations/inference-budget"
  );
  const { meteredOpenAIFetch } = await import(
    "../src/server/integrations/openai-client"
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "meridian-mini-budget-"));
  const globalFile = path.join(dir, "operator.json"),
    scopedFile = path.join(dir, "scoped.json");
  vi.stubEnv("INFERENCE_BUDGET_LEDGER", globalFile);
  vi.stubEnv("INFERENCE_BUDGET_USD", "0.02");
  try {
    const fetcher = meteredOpenAIFetch(async (input) =>
      String(input).endsWith("/input_tokens")
        ? Response.json({ input_tokens: 1000 })
        : Response.json({
            id: "fixture",
            model: "gpt-5.4-mini-2026-03-17",
            usage: {
              input_tokens: 1000,
              output_tokens: 1000,
              input_tokens_details: { cached_tokens: 500 },
            },
          }),
    );
    await withInferenceBudget(new InferenceBudget(scopedFile, 0.02), () =>
      fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.4-mini",
          input: "fixture",
          max_output_tokens: 1000,
        }),
      }),
    );
    for (const file of [globalFile, scopedFile]) {
      const ledger = JSON.parse(await readFile(file, "utf8"));
      expect(ledger.charges[0].actual_usd).toBeCloseTo(0.0049125);
      expect(ledger.charges[0].state).toBe("settled");
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  }
});
