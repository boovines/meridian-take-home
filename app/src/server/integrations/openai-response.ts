import { DomainError } from "../../domain/errors";
import { RUNTIME_DEADLINE_POLICY } from "../../domain/runtime-policy";

/** Starts only after token counting/reservation. Includes headers AND body reading. */
export async function fetchOpenAIResponse(base: typeof fetch, input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
  const parent = init?.signal;
  parent?.throwIfAborted();
  const started = Date.now(), controller = new AbortController();
  const timeout = new DomainError(503, "MODEL_RESPONSE_TIMEOUT",
    "The model response exceeded its 180-second allowance after token counting. No partial output was accepted. Inspect the request size or use smaller extraction batches before retrying.",
    { stage: "model_response", timeout_ms: RUNTIME_DEADLINE_POLICY.model_response_ms });
  const timer = setTimeout(() => controller.abort(timeout), RUNTIME_DEADLINE_POLICY.model_response_ms);
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { void reader?.cancel().catch(() => {}); reject(parent?.aborted ? parent.reason : signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const response = await base(input, { ...init, signal });
      signal.throwIfAborted();
      if (!response.body) return response;
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        chunks.push(value);
      }
      // A fully consumed body cannot stall later in the SDK or usage reconciliation.
      return new Response(Buffer.concat(chunks), { status: response.status, statusText: response.statusText, headers: response.headers });
    })()]);
  } catch (error) {
    if (parent?.aborted) throw parent.reason;
    if (controller.signal.aborted) {
      timeout.details = { stage: "model_response", timeout_ms: RUNTIME_DEADLINE_POLICY.model_response_ms, elapsed_ms: Date.now() - started };
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
