import type { WorkflowJob } from "../../domain/engineering";
import {
  startGenerationWorkflow,
  cancelGenerationWorkflow,
} from "../integrations/temporal";
export function fixtureEngineering() {
  return (
    process.env.MERIDIAN_ENGINEERING_PROVIDER === "fixture" &&
    process.env.MERIDIAN_DATABASE === "local" &&
    process.env.MERIDIAN_LOCAL_DEMO === "true"
  );
}
export async function dispatchGeneration(job: WorkflowJob) {
  if (fixtureEngineering()) {
    const { getDatabase } = await import("../database");
    const { GenerationService } = await import("./generation-service");
    const { fixtureSources } = await import("../../../tests/fixtures/engineer");
    await new GenerationService(await getDatabase()).run(
      job.id,
      {
        model: "fixture",
        generate: async (c) => fixtureSources(c.spec.board, c.steps),
        validate: async () => ({ engine: "fixture", check: "fixture-only" }),
      },
      AbortSignal.timeout(10000),
    );
    return;
  }
  if (!["queued", "cancel_requested"].includes(job.status)) return;
  try {
    await startGenerationWorkflow(job.id);
    if (job.status === "cancel_requested")
      await cancelGenerationWorkflow(job.id);
  } catch {
    // The durable queued row remains available to the worker's outbox delivery.
    console.warn(
      "Generation dispatch deferred; the worker will retry delivery.",
    );
  }
}
