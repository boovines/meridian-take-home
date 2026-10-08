import { createOpenAI } from "@ai-sdk/openai";
import { createHash } from "node:crypto";
import { configuredInferenceBudget } from "./inference-budget";
import { DomainError } from "../../domain/errors";
import { countOpenAIInputTokens } from "./openai-preflight";

export function meteredOpenAIFetch(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const budget = configuredInferenceBudget();
    if (!budget) return base(input, init);
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url,
    );
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
    if (
      !["gpt-5.4", "gpt-5.4-2026-03-05"].includes(r.model) ||
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
        "This experiment allows only priced GPT-5.4 requests with bounded output and function tools.",
      );
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
    const { tokens, attempts, failures } = await countOpenAIInputTokens(
      base,
      { ...init, body: JSON.stringify(countBody) },
    );
    const estimated =
      (Math.ceil(tokens * 1.15) * 2.5 + r.max_output_tokens * 15) / 1e6;
    const reservation = await budget.reserve(
      "openai",
      estimated,
      {
        model: r.model,
        input_tokens_preflight: tokens,
        preflight_attempts: attempts,
        preflight_failures: failures,
        max_output_tokens: r.max_output_tokens,
        request_sha256: createHash("sha256").update(init.body).digest("hex"),
      },
      init.signal || undefined,
    );
    // A transport error, timeout or missing usage may still be billed. Leave the
    // reservation intact; every SDK retry must obtain a separate reservation.
    const response = await base(input, init);
    if (!response.ok) {
      await reservation.annotate({ http_status: response.status });
      return response;
    }
    const body = await response.clone().json(),
      u = body.usage,
      cached = u?.input_tokens_details?.cached_tokens || 0;
    if (
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
        "Usage unavailable; spend reservation retained.",
      );
    const actual =
      ((u.input_tokens - cached) * 2.5 + cached * 0.25 + u.output_tokens * 15) /
      1e6;
    await reservation.settle(actual, {
      response_id: body.id,
      returned_model: body.model,
      usage: u,
    });
    return response;
  };
}
export const openai = createOpenAI({
  fetch: meteredOpenAIFetch((...args) => globalThis.fetch(...args)),
});
