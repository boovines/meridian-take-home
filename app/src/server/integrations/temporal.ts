import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { temporalConfig } from "./temporal-config";
const globals = globalThis as typeof globalThis & {
  meridianTemporal?: Promise<Client>;
};
export async function temporalClient() {
  if (!globals.meridianTemporal)
    globals.meridianTemporal = (async () => {
      const config = temporalConfig();
      return new Client({
        connection: await Connection.connect(config.connection),
        namespace: config.namespace,
      });
    })().catch((e) => {
      globals.meridianTemporal = undefined;
      throw e;
    });
  return globals.meridianTemporal;
}
export const reviewWorkflowId = (id: string) => `review-${id}`;
export async function startReviewWorkflow(id: string) {
  const c = await temporalClient();
  try {
    await c.workflow.start("reviewDraft", {
      workflowId: reviewWorkflowId(id),
      taskQueue: temporalConfig().taskQueue,
      args: [id],
      workflowExecutionTimeout: "5 minutes",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (e) {
    if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
  }
}
export async function cancelReviewWorkflow(id: string) {
  try {
    await (await temporalClient()).workflow
      .getHandle(reviewWorkflowId(id))
      .cancel();
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) throw e;
  }
}

export async function startGenerationWorkflow(id: string) {
  try {
    await (
      await temporalClient()
    ).workflow.start("generateAgent", {
      workflowId: `job-${id}`,
      taskQueue: temporalConfig().taskQueue,
      args: [id],
      workflowExecutionTimeout: "40 minutes",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}
export async function cancelGenerationWorkflow(id: string) {
  try {
    await (await temporalClient()).workflow.getHandle(`job-${id}`).cancel();
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
  }
}

// Human pauses have no absolute execution timeout. Active time is bounded by
// the workflow's durable timer; the queued application's deadline is separate.
export async function startExecutionWorkflow(id: string) {
  try {
    await (
      await temporalClient()
    ).workflow.start("executeWorkflow", {
      workflowId: `job-${id}`,
      taskQueue: temporalConfig().taskQueue,
      args: [id],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (error) {
    if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
  }
}
