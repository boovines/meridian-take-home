import { ClarificationService } from "../server/repairs/clarification-service";
import { withRecoveryBudget } from "../server/repairs/recovery-budget";
import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DomainError } from "../domain/errors";
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
        origin: value.session.origin,
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
    const db = await getDatabase();
    const scope = (
      await db.query(
        "SELECT s.job_id FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id WHERE a.id=$1",
        [id],
      )
    ).rows[0];
    if (!scope)
      throw new DomainError(404, "NOT_FOUND", "Repair attempt not found.");
    await withRecoveryBudget(db, String(scope.job_id), () =>
      new RepairGenerationService(db).run(
        id,
        {
          model: engineeringModel(),
          generate: repairProjectSources,
        },
        AbortSignal.any([
          cancellationSignal(),
          AbortSignal.timeout(15 * 60 * 1000),
        ]),
      ),
    );
    const question = await new ClarificationService(db).questionForAttempt(id);
    if (question?.status === "open")
      return { ready: false as const, waiting: true as const };
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
export async function createRepairEvaluation(id: string, round = 1) {
  return (
    await new RepairService(await getDatabase()).createEvaluation(id, round)
  ).id;
}
export async function decideRepairAttempt(id: string) {
  const { session, attempt } = await new RepairService(
    await getDatabase(),
  ).decide(id);
  return {
    done: session.status !== "running",
    confirming: attempt.status === "running",
  };
}
export async function endRepair(
  id: string,
  status: "failed" | "cancelled" | "needs_attention",
  reason: string,
  code?: string,
) {
  await new RepairService(await getDatabase()).finish(id, status, reason, code);
}
