import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../../domain/errors";

export const openAITokenPreflightPolicy = {
  version: "bounded-v2",
  max_attempts: 3,
  timeout_ms: 120000,
  retry_delay_ms: [250, 500],
  retry_statuses: [408, 429, 500, 502, 503, 504],
  retry_transport_errors: ["TypeError"],
  max_input_tokens: 240000,
} as const;

/** Counting is read-only. Never retry inference here or bypass a failed count. */
export async function countOpenAIInputTokens(
  transport: typeof fetch,
  init: RequestInit,
) {
  const policy = openAITokenPreflightPolicy;
  const expiresAt = Date.now() + policy.timeout_ms;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(policy.timeout_ms),
    ...(init.signal ? [init.signal] : []),
  ]);
  const failures: string[] = [];
  let attempts = 0;
  const unavailable = (detail: string) => new DomainError(
    503, "BUDGET_UNAVAILABLE", `${detail}; inference was not started. Preflight attempts: ${attempts}; failures: ${failures.join(", ") || "none"}.`,
    { preflight_attempts: attempts, preflight_failures: [...failures] },
  );
  try {
    for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
      deadline.throwIfAborted();
      attempts = attempt;
      let response: Response | undefined;
      try {
        response = await transport("https://api.openai.com/v1/responses/input_tokens", {
          ...init, signal: deadline,
        });
      } catch (error) {
        deadline.throwIfAborted();
        // Native fetch reports network failures as TypeError. Unknown adapter
        // bugs and explicit aborts are not evidence of a transient network fault.
        if (!(error instanceof TypeError)) {
          failures.push("transport_nonretryable");
          throw unavailable("Input-token preflight transport could not proceed");
        }
        failures.push("transport");
        if (attempt === policy.max_attempts)
          throw unavailable(`Input-token preflight transport failed after ${attempt} attempts`);
      }
      deadline.throwIfAborted();
      if (response?.ok) {
        let tokens: unknown;
        try { tokens = (await response.json())?.input_tokens; }
        catch (error) {
          deadline.throwIfAborted();
          if (error instanceof TypeError) {
            failures.push("response_transport");
            await response.body?.cancel().catch(() => {});
            if (attempt === policy.max_attempts)
              throw unavailable(`Input-token preflight body transport failed after ${attempt} attempts`);
            await delay(policy.retry_delay_ms[Math.min(attempt - 1, 1)], undefined, { signal: deadline });
            continue;
          }
          failures.push("invalid_json");
          throw unavailable("Input-token preflight returned invalid JSON");
        }
        deadline.throwIfAborted();
        if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0 || tokens > policy.max_input_tokens) {
          failures.push("invalid_count");
          throw unavailable("Input exceeds the guard's priced context range or its token count is invalid");
        }
        return { tokens, attempts, failures };
      }
      let waitMs: number = policy.retry_delay_ms[Math.min(attempt - 1, 1)];
      if (response) {
        failures.push(`http_${response.status}`);
        await response.body?.cancel().catch(() => {});
        deadline.throwIfAborted();
        if (!(policy.retry_statuses as readonly number[]).includes(response.status) || attempt === policy.max_attempts)
          throw unavailable(`Input-token preflight failed (${response.status}) after ${attempt} attempts`);
        const retryAfter = response.headers.get("retry-after");
        if (retryAfter) {
          const seconds = Number(retryAfter);
          const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
          // Respect server backoff without starting a request beyond this call's
          // remaining deadline or retrying earlier than the server requested.
          if (requested >= expiresAt - Date.now())
            throw unavailable("Input-token preflight requires a later retry");
          if (Number.isFinite(requested)) waitMs = Math.max(waitMs, requested);
        }
      }
      await delay(waitMs, undefined, { signal: deadline });
    }
    throw unavailable("Input-token preflight exhausted its attempt limit");
  } catch (error) {
    // Cancellation remains the caller's cancellation even if reading JSON or
    // backoff threw another error. Our own timeout is an infrastructure blocker.
    init.signal?.throwIfAborted();
    if (deadline.aborted) {
      failures.push("deadline");
      throw unavailable("Input-token preflight exceeded its shared deadline");
    }
    throw error;
  }
}
