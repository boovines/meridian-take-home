import type { WorkflowJob } from "../../domain/engineering";
import { dispatchGeneration } from "../engineering/dispatch";
import { dispatchExecution } from "../runtime/dispatch";
export async function dispatchOperation(job: WorkflowJob) {
  if (job.kind === "generation") return dispatchGeneration(job);
  if (job.kind === "execution") return dispatchExecution(job);
  throw new Error(`Unsupported operation: ${job.kind}`);
}
