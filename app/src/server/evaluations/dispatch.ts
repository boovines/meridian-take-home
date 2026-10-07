import { fixtureEngineering } from "../engineering/dispatch";
import type { WorkflowJob } from "../../domain/engineering";
import {
  startEvaluationWorkflow,
  cancelGenerationWorkflow,
} from "../integrations/temporal";
export async function dispatchEvaluation(job: WorkflowJob) {
  if (fixtureEngineering()) {
    const { getDatabase } = await import("../database");
    const { evaluateFixture } = await import(
      "../../../tests/fixtures/evaluation-runner"
    );
    await evaluateFixture(await getDatabase(), job.id);
    return;
  }
  if (!["queued", "cancel_requested"].includes(job.status)) return;
  try {
    await startEvaluationWorkflow(job.id);
    if (job.status === "cancel_requested")
      await cancelGenerationWorkflow(job.id);
  } catch {
    console.warn(
      "Evaluation dispatch deferred; the worker will retry delivery.",
    );
  }
}
