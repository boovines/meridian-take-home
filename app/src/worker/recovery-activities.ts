import { getDatabase } from "../server/database";
import { RunRecoveryService } from "../server/repairs/run-recovery-service";
export async function recoveryBaseline(jobId: string) {
  return new RunRecoveryService(await getDatabase()).baselineEvaluation(jobId);
}
export async function recordRecoveryBaseline(jobId: string, id: string) {
  return new RunRecoveryService(await getDatabase()).recordBaseline(jobId, id);
}
export async function createRecoveryRerun(id: string) {
  return new RunRecoveryService(await getDatabase()).createRerun(id);
}
export async function createRecoveryRegression(id: string) {
  return new RunRecoveryService(await getDatabase()).regressionEvaluation(id);
}
export async function decideRecovery(id: string) {
  return new RunRecoveryService(await getDatabase()).decide(id);
}
export async function remainingRecoveryTime(jobId: string) {
  const db = await getDatabase();
  const row = (
    await db.query(
      "SELECT j.deadline_at,s.paused_at FROM workflow_jobs j JOIN repair_sessions s ON s.job_id=j.id WHERE j.id=$1",
      [jobId],
    )
  ).rows[0];
  return row.paused_at
    ? null
    : Math.max(0, new Date(String(row.deadline_at)).getTime() - Date.now());
}

export async function recoveryQuestionState(attemptId: string) {
  const db = await getDatabase();
  const row = (
    await db.query(
      "SELECT status FROM engineer_questions WHERE attempt_id=$1",
      [attemptId],
    )
  ).rows[0];
  return row?.status ?? "missing";
}
