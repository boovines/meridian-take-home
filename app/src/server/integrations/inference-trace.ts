import { AsyncLocalStorage } from "node:async_hooks";
import { DomainError } from "../../domain/errors";
import type { ProviderTrace } from "../../domain/execution-audit";

// Per interaction; concurrent cases must never share diagnostics. No input text,
// headers, provider error bodies or credentials are recorded here.
const traces = new AsyncLocalStorage<ProviderTrace>();
export async function captureInferenceTrace<T>(call: () => Promise<T>, save: (trace: ProviderTrace) => void) {
  const trace: ProviderTrace = { version: 1, stages: [] };
  return traces.run(trace, async () => {
    try { return await call(); }
    finally { if (trace.stages.length) save(structuredClone(trace)); }
  });
}
export function annotateInferenceTrace(fields: Omit<Partial<ProviderTrace>, "stages" | "version">) {
  const trace = traces.getStore();
  if (trace) Object.assign(trace, fields);
}
export async function inferenceStage<T>(stage: ProviderTrace["stages"][number]["stage"], call: () => Promise<T>) {
  const trace = traces.getStore();
  if (!trace) return call();
  const started = Date.now();
  const entry: ProviderTrace["stages"][number] = { stage, elapsed_ms: 0, outcome: "completed" };
  // Runtime SDK retries are disabled. The bound also protects other adapters.
  if (trace.stages.length < 8) trace.stages.push(entry);
  else trace.stages_omitted = (trace.stages_omitted ?? 0) + 1;
  try { return await call(); }
  catch (error) {
    entry.outcome = "failed";
    entry.code = error instanceof DomainError ? error.code : "PROVIDER_CALL_INTERRUPTED";
    throw error;
  } finally { entry.elapsed_ms = Date.now() - started; }
}
