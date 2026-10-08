import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../../domain/errors";

export const openAITokenPreflightPolicy = {
  version: "bounded-v1",
  max_attempts: 3,
  timeout_ms: 120000,
  retry_delay_ms: [250, 500],
  retry_statuses: [408, 429, 500, 502, 503, 504],
} as const;

/** Counting is read-only. Never retry inference here or bypass a failed count. */
export async function countOpenAIInputTokens(
  transport: typeof fetch,
  init: RequestInit,
) {
  const policy = openAITokenPreflightPolicy;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(policy.timeout_ms),
    ...(init.signal ? [init.signal] : []),
  ]);
  const unavailable = (detail: string) => new DomainError(
    503, "BUDGET_UNAVAILABLE", `${detail}; inference was not started.`,
  );
  const failures: string[] = [];
  for (let attempt = 1; attempt <= policy.max_attempts; attempt++) {
    deadline.throwIfAborted();
    let response: Response | undefined;
    try {
      response = await transport("https://api.openai.com/v1/responses/input_tokens", {
        ...init, signal: deadline,
      });
    } catch {
      deadline.throwIfAborted();
      failures.push("transport");
      if (attempt === policy.max_attempts)
        throw unavailable(`Input-token preflight transport failed after ${attempt} attempts`);
    }
    deadline.throwIfAborted();
    if (response?.ok) {
      let tokens: unknown;
      try { tokens = (await response.json()).input_tokens; }
      catch { throw unavailable("Input-token preflight returned invalid JSON"); }
      deadline.throwIfAborted();
      if (typeof tokens !== "number" || !Number.isInteger(tokens) || tokens < 0 || tokens > 240000)
        throw unavailable("Input exceeds this experiment's priced context range or its token count is invalid");
      return { tokens, attempts: attempt, failures };
    }
    let waitMs: number = policy.retry_delay_ms[Math.min(attempt - 1, 1)];
    if (response) {
      failures.push(`http_${response.status}`);
      await response.body?.cancel().catch(() => {});
      if (!(policy.retry_statuses as readonly number[]).includes(response.status) || attempt === policy.max_attempts)
        throw unavailable(`Input-token preflight failed (${response.status}) after ${attempt} attempts`);
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const requested = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
        // A longer server backoff needs a later operation, not an early retry.
        if (requested > policy.timeout_ms)
          throw unavailable("Input-token preflight requires a later retry");
        if (Number.isFinite(requested)) waitMs = Math.max(waitMs, requested);
      }
    }
    await delay(waitMs, undefined, { signal: deadline });
  }
  throw unavailable("Input-token preflight exhausted its attempt limit");
}
