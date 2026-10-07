import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DomainError } from "../domain/canvas";
import { getDatabase } from "../server/database";
import { RepairService } from "../server/repairs/service";
import { RepairGenerationService } from "../server/repairs/generation-service";
import { repairProjectSources } from "../server/integrations/openai-repair";
import { engineeringModel } from "../server/integrations/openai-engineer";
export async function prepareRepair(id: string) {
  const value = await new RepairService(await getDatabase()).prepare(id);
  return value
    ? {
        deadline_at: value.deadline_at,
        attempt_limit: value.session.attempt_limit,
      }
    : null;
}
export async function beginRepairAttempt(id: string, number: number) {
  return (await new RepairService(await getDatabase()).beginAttempt(id, number))
    .id;
}
export async function generateRepairCandidate(id: string) {
  const pulse = setInterval(() => heartbeat(), 5000);
  try {
    heartbeat();
    await new RepairGenerationService(await getDatabase()).run(
      id,
      {
        model: engineeringModel(),
        generate: repairProjectSources,
      },
      AbortSignal.any([
        cancellationSignal(),
        AbortSignal.timeout(15 * 60 * 1000),
      ]),
    );
    return { ready: true as const };
  } catch (error) {
    if (error instanceof DomainError)
      return { ready: false as const, code: error.code, reason: error.message };
    // Provider payloads can contain input data; keep Temporal failure messages generic.
    throw ApplicationFailure.create({
      message: "The repair generation adapter could not complete.",
      type: "RepairGenerationFailure",
    });
  } finally {
    clearInterval(pulse);
  }
}
export async function createRepairEvaluation(id: string) {
  return (await new RepairService(await getDatabase()).createEvaluation(id)).id;
}
export async function decideRepairAttempt(id: string) {
  const { session } = await new RepairService(await getDatabase()).decide(id);
  return { done: session.status !== "running" };
}
export async function endRepair(
  id: string,
  status: "failed" | "cancelled" | "needs_attention",
  reason: string,
  code?: string,
) {
  await new RepairService(await getDatabase()).finish(id, status, reason, code);
}
