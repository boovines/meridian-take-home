import { fetchOpenAIResponse } from "./openai-response";
import { createOpenAI } from "@ai-sdk/openai";
import { createHash } from "node:crypto";
import { configuredInferenceBudget } from "./inference-budget";
import { DomainError } from "../../domain/errors";
import { countOpenAIInputTokens } from "./openai-preflight";

// Standard US endpoint prices, USD per million tokens; verified 2026-10-08.
// https://developers.openai.com/api/docs/models/gpt-5.4-mini
// https://developers.openai.com/api/docs/models/gpt-5.4
const prices: Record<
  string,
  { input: number; cached: number; output: number }
> = {
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-2026-03-05": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cached: 0.075, output: 4.5 },
  "gpt-5.4-mini-2026-03-17": { input: 0.75, cached: 0.075, output: 4.5 },
};
export function meteredOpenAIFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const budget = configuredInferenceBudget();
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
    if (!budget) return url.origin === "https://api.openai.com" && url.pathname === "/v1/responses"
      ? fetchOpenAIResponse(base, input, init) : base(input, init);
    if (
      url.origin !== "https://api.openai.com" ||
      url.pathname !== "/v1/responses" ||
      typeof init?.body !== "string"
    )
      throw new DomainError(
        503,
        "BUDGET_UNAVAILABLE",
        "Budgeted inference requires the non-streaming OpenAI Responses API.",
      );
    const r = JSON.parse(init.body);
    const price = prices[r.model];
    if (
      !price ||
      r.stream ||
      r.background ||
      r.previous_response_id ||
      r.conversation ||
      (r.service_tier && r.service_tier !== "default") ||
      !Number.isInteger(r.max_output_tokens) ||
      r.max_output_tokens < 1 ||
      r.tools?.some((t: { type: string }) => t.type !== "function")
    )
      throw new DomainError(
        503,
        "BUDGET_UNAVAILABLE",
        "Budgeted inference requires a priced GPT-5.4 or GPT-5.4 mini request with bounded output and function tools.",
      );
    // An omitted tier means project-configured "auto", potentially priced higher.
    // Pin the same standard tier used by the reservation and reconciliation.
    const body = JSON.stringify({ ...r, service_tier: "default" });
    const countBody = Object.fromEntries(
      [
        "model",
        "input",
        "instructions",
        "tools",
        "tool_choice",
        "text",
        "reasoning",
        "parallel_tool_calls",
      ]
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, r[k]]),
    );
    const { tokens, attempts, failures } = await countOpenAIInputTokens(base, {
      ...init,
      body: JSON.stringify(countBody),
    });
    // Do not under-reserve a long-context pricing tier. The demo's inputs are
    // smaller; fail before inference until explicit long-context pricing is added.
    if (tokens > 272000)
      throw new DomainError(
        503,
        "BUDGET_UNAVAILABLE",
        "This request exceeds the budget meter's supported context tier.",
      );
    const estimated =
      (Math.ceil(tokens * 1.15) * price.input +
        r.max_output_tokens * price.output) /
      1e6;
    const reservation = await budget.reserve(
      "openai",
      estimated,
      {
        model: r.model,
        input_tokens_preflight: tokens,
        preflight_attempts: attempts,
        preflight_failures: failures,
        max_output_tokens: r.max_output_tokens,
        request_sha256: createHash("sha256").update(body).digest("hex"),
      },
      init.signal || undefined,
    );
    // A transport error, timeout or missing usage may still be billed. Leave the
    // reservation intact; every SDK retry must obtain a separate reservation.
    const response = await fetchOpenAIResponse(base, input, { ...init, body });
    if (!response.ok) {
      await reservation.annotate({ http_status: response.status });
      return response;
    }
    const result = await response.clone().json(),
      u = result.usage,
      cached = u?.input_tokens_details?.cached_tokens || 0;
    if (
      !prices[result.model] || prices[result.model].input !== price.input ||
      result.service_tier !== "default" ||
      !u ||
      !Number.isInteger(u.input_tokens) ||
      !Number.isInteger(u.output_tokens) ||
      u.input_tokens < 0 ||
      u.output_tokens < 0 ||
      !Number.isInteger(cached) ||
      cached < 0 ||
      cached > u.input_tokens
    )
      throw new DomainError(
        503,
        "BUDGET_UNAVAILABLE",
        "Priced usage unavailable; spend reservation retained.",
      );
    const longContext = u.input_tokens > 272000 && !r.model.includes("mini");
    const actual =
      (((u.input_tokens - cached) * price.input + cached * price.cached) * (longContext ? 2 : 1) +
        u.output_tokens * price.output * (longContext ? 1.5 : 1)) /
      1e6;
    await reservation.settle(actual, {
      response_id: result.id,
      returned_model: result.model,
      service_tier: result.service_tier,
      usage: u,
    });
    return response;
  };
}
export const openai = createOpenAI({
  fetch: meteredOpenAIFetch((...args) => globalThis.fetch(...args)),
});
