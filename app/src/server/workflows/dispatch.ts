import type { WorkflowJob } from "../../domain/engineering";
import { dispatchGeneration } from "../engineering/dispatch";
import { dispatchExecution } from "../runtime/dispatch";
import { dispatchEvaluation } from "../evaluations/dispatch";
import { dispatchRepair } from "../repairs/dispatch";
export async function dispatchOperation(job: WorkflowJob) {
  if (job.kind === "generation") return dispatchGeneration(job);
  if (job.kind === "execution") return dispatchExecution(job);
  if (job.kind === "evaluation") return dispatchEvaluation(job);
  if (job.kind === "repair") return dispatchRepair(job);
  throw new Error(`Unsupported operation: ${job.kind}`);
}
