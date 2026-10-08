import { DomainError } from "../../domain/errors";
import type { RunRecord, StepRecord } from "../../domain/runtime";
import type { Queryable } from "../database";
export const finishedRuns = [
  "completed",
  "failed",
  "needs_attention",
  "cancelled",
];
export function runRecord(row: Record<string, unknown>): RunRecord {
  return {
    ...row,
    scheduled_step_attempts: Number(row.scheduled_step_attempts),
    active_elapsed_ms: Number(row.active_elapsed_ms),
  } as unknown as RunRecord;
}
export async function runById(tx: Queryable, id: string) {
  const row = (await tx.query("SELECT * FROM workflow_runs WHERE id=$1", [id]))
    .rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Run not found.");
  return runRecord(row);
}
export async function stepById(tx: Queryable, id: string) {
  const row = (
    await tx.query("SELECT * FROM step_executions WHERE id=$1", [id])
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Step occurrence not found.");
  return row as unknown as StepRecord;
}
