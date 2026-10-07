import {
  proxyActivities,
  CancellationScope,
  isCancellation,
  ActivityCancellationType,
  defineSignal,
  setHandler,
  condition,
} from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";
import type * as activities from "./runtime-activities";
import { RuntimeEngine } from "../domain/runtime-engine";
const io = proxyActivities<
  Pick<
    typeof activities,
    "prepareExecution" | "projectExecution" | "readHumanResponse"
  >
>({ startToCloseTimeout: "15 seconds", retry: { maximumAttempts: 5 } });
const cleanup = proxyActivities<Pick<typeof activities, "endExecution">>({
  startToCloseTimeout: "15 seconds",
  retry: { initialInterval: "2 seconds", maximumInterval: "1 minute" },
});
const steps = proxyActivities<Pick<typeof activities, "executeOccurrence">>({
  startToCloseTimeout: "3 minutes",
  scheduleToCloseTimeout: "7 minutes",
  heartbeatTimeout: "20 seconds",
  cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
  retry: { maximumAttempts: 2, initialInterval: "3 seconds" },
});
export const humanAnswered = defineSignal<[string]>("humanAnswered");
export async function executeWorkflow(jobId: string) {
  const answered = new Set<string>();
  let changed = 0;
  setHandler(humanAnswered, (id) => {
    answered.add(id);
    changed++;
  });
  let engine: RuntimeEngine | undefined;
  let limit = false;
  try {
    const context = await io.prepareExecution(jobId);
    if (!context) return;
    const scope = new CancellationScope();
    engine = new RuntimeEngine(context.run.id, context.definition, {
      now: () => Date.now(),
      changed: () => {
        changed++;
      },
      rethrow: (error) => {
        if (isCancellation(error)) throw error;
      },
      describeFailure: (error) => {
        let cause: unknown = error;
        while (cause instanceof Error && "cause" in cause && cause.cause)
          cause = cause.cause;
        const type = cause instanceof ApplicationFailure ? cause.type : null;
        return {
          code: type || "RUNTIME_FAILED",
          message:
            cause instanceof Error
              ? cause.message.slice(0, 2000)
              : "The runtime worker failed.",
          category:
            type === "RUN_LIMIT" || type === "STEP_RETRY_LIMIT"
              ? "implementation"
              : "infrastructure",
        };
      },
      project: (p) => io.projectExecution(context.run.id, p),
      step: (data, resume) => steps.executeOccurrence(data, resume),
      human: async (id, stopped) => {
        if ((await io.readHumanResponse(id)).status === "answered") return;
        await condition(() => answered.has(id) || stopped());
      },
    });
    let finished = false;
    await scope.run(async () => {
      const monitor = (async () => {
        while (!finished) {
          const revision = changed;
          if (engine!.isWaiting()) {
            await condition(() => finished || changed !== revision);
            continue;
          }
          const remaining = engine!.remaining();
          if (remaining <= 0) {
            limit = true;
            scope.cancel();
            return;
          }
          await condition(() => finished || changed !== revision, remaining);
        }
      })();
      try {
        const result = await engine!.run();
        await cleanup.endExecution(jobId, result);
      } finally {
        finished = true;
        changed++;
        await monitor;
      }
    });
  } catch (error) {
    const status = limit
      ? "needs_attention"
      : isCancellation(error)
        ? "cancelled"
        : "failed";
    const projection = engine?.projection();
    if (projection && engine)
      projection.active_elapsed_ms = engine.activeElapsed();
    await CancellationScope.nonCancellable(() =>
      cleanup.endExecution(jobId, {
        status,
        projection,
        error:
          status === "cancelled"
            ? null
            : {
                code: limit ? "RUN_LIMIT" : "RUNTIME_FAILED",
                message: limit
                  ? "The run reached its active execution time limit."
                  : "The runtime could not finish. Inspect step history and retry.",
                category: limit ? "implementation" : "infrastructure",
              },
      }),
    );
    if (!limit && !isCancellation(error)) throw error;
  }
}
