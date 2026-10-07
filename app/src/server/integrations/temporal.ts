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
async function client() {
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
  const c = await client();
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
    await (await client()).workflow.getHandle(reviewWorkflowId(id)).cancel();
  } catch (e) {
    if (!(e instanceof WorkflowNotFoundError)) throw e;
  }
}
