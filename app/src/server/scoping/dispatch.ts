import type { ScopingOperation } from "../../domain/scoping";
import { getDatabase } from "../database";
import { ScopingService } from "./service";
import {
  startScopingWorkflow,
  cancelScopingWorkflow,
} from "../integrations/temporal";
export function fixtureScoping() {
  return (
    process.env.MERIDIAN_SCOPING_PROVIDER === "fixture" &&
    process.env.MERIDIAN_DATABASE === "local" &&
    process.env.MERIDIAN_LOCAL_DEMO === "true"
  );
}
export async function dispatchScoping(op: ScopingOperation) {
  if (!["queued", "running"].includes(op.status)) return;
  if (fixtureScoping()) {
    const service = new ScopingService(await getDatabase());
    const input = await service.prepare(op.id);
    if (input) {
      const { fixtureScope } = await import("../../../tests/fixtures/scoping");
      try {
        await service.publish(op.id, fixtureScope(input));
      } catch {
        await service.finish(
          op.id,
          "failed",
          "The preview could not be validated. Your notes and previous previews are preserved. Try again.",
        );
      }
    }
    return;
  }
  // The persisted queued operation is the outbox. A transient dispatch failure
  // leaves it queued for worker reconciliation instead of losing the request.
  try {
    await startScopingWorkflow(op.id);
  } catch {
    console.warn("Scoping dispatch will be retried by the worker.");
  }
}
export async function cancelScoping(workflowId: string, operationId: string) {
  await new ScopingService(await getDatabase()).finish(
    operationId,
    "cancelled",
    undefined,
    workflowId,
  );
  if (!fixtureScoping())
    try {
      await cancelScopingWorkflow(operationId);
    } catch {
      /* DB cancellation fences late results. */
    }
}
