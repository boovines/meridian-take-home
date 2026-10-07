import type { WorkflowJob } from "../../domain/engineering";
import { fixtureEngineering } from "../engineering/dispatch";
import {
  startRepairWorkflow,
  cancelGenerationWorkflow,
} from "../integrations/temporal";
export async function dispatchRepair(job: WorkflowJob) {
  if (fixtureEngineering()) {
    const { getDatabase } = await import("../database");
    const { repairFixture } =
      await import("../../../tests/fixtures/repair-runner");
    await repairFixture(await getDatabase(), job.id);
    return;
  }
  if (!["queued", "cancel_requested"].includes(job.status)) return;
  try {
    await startRepairWorkflow(job.id);
    if (job.status === "cancel_requested")
      await cancelGenerationWorkflow(job.id);
  } catch {
    console.warn("Repair dispatch deferred; the worker will retry delivery.");
  }
}
