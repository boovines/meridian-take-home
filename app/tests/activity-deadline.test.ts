import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ execute: vi.fn(), signal: undefined as unknown as AbortSignal }));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn(), cancellationSignal: () => state.signal }));
vi.mock("../src/server/database", () => ({ getDatabase: async () => ({}) }));
vi.mock("../src/server/runtime/step-service", () => ({ StepService: class { execute = state.execute; } }));
import { executeOccurrence } from "../src/worker/runtime-activities";
import type { ScheduleStep } from "../src/domain/runtime";
afterEach(() => { vi.restoreAllMocks(); state.execute.mockReset(); });

it("names an exhausted step deadline and prevents Temporal replay of expensive work", async () => {
  state.signal = new AbortController().signal;
  const deadline = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  state.execute.mockImplementation(async (_data, _adapters, signal: AbortSignal) => {
    deadline.abort(new DOMException("expired", "TimeoutError")); signal.throwIfAborted();
  });
  await expect(executeOccurrence({} as ScheduleStep)).rejects.toMatchObject({type: "STEP_EXECUTION_TIMEOUT", nonRetryable: true});
  expect(timer).toHaveBeenCalledWith(720000); expect(state.execute).toHaveBeenCalledTimes(1);
});

it("preserves user cancellation even if the step deadline also expires", async () => {
  const cancelled = new AbortController(), deadline = new AbortController(); state.signal = cancelled.signal;
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const reason = new Error("User cancelled");
  state.execute.mockImplementation(async () => { cancelled.abort(reason); deadline.abort(); throw reason; });
  await expect(executeOccurrence({} as ScheduleStep)).rejects.toBe(reason);
});
