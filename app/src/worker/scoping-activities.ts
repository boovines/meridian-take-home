import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { getDatabase } from "../server/database";
import { ScopingService } from "../server/scoping/service";
import { scopeWithOpenAI } from "../server/integrations/openai-scoping";
export async function performScoping(id: string) {
  const pulse = setInterval(() => heartbeat(), 5000);
  try {
    heartbeat();
    const service = new ScopingService(await getDatabase());
    const op = await service.prepare(id);
    if (!op) return;
    const output = await scopeWithOpenAI(
      op,
      AbortSignal.any([cancellationSignal(), AbortSignal.timeout(110000)]),
    );
    await service.publish(id, output);
  } catch {
    throw ApplicationFailure.create({
      message: "Workflow scoping could not complete.",
      type: "ScopingFailure",
    });
  } finally {
    clearInterval(pulse);
  }
}
export async function endScoping(id: string, status: "failed" | "cancelled") {
  await new ScopingService(await getDatabase()).finish(
    id,
    status,
    status === "failed"
      ? "The agent could not finish a valid response. Your notes and previous previews are preserved. Try again."
      : undefined,
  );
}
