import type { WorkflowJob } from "../../domain/engineering";
import {
  groupingCoverage,
  type GroupingResult,
} from "../../domain/grouped-execution";
import type { Json } from "../../domain/runtime";
import { workflow } from "../workflows/store";
import type { Database, Queryable } from "../database";
import { jobById } from "../engineering/job-service";
import { runRecord } from "../runtime/store";
import { DomainError } from "../../domain/errors";
export const activeStatuses = [
  "queued",
  "running",
  "waiting_for_human",
  "cancel_requested",
];
export async function groupedExecutionState(db: Database, jobId: string) {
  return db.transaction(async (tx) => {
    const job = await jobById(tx, jobId);
    await workflow(tx, job.workflow_id, true);
    return readGroupedState(tx, jobId);
  });
}
async function readGroupedState(db: Queryable, jobId: string) {
  const job = await jobById(db, jobId);
  if (job.kind !== "grouped")
    throw new DomainError(
      422,
      "NOT_GROUPED",
      "Choose a selected-email operation.",
    );
  const record = (
    await db.query("SELECT * FROM grouped_executions WHERE job_id=$1", [jobId])
  ).rows[0];
  const jobs = (
    await db.query(
      "SELECT * FROM workflow_jobs WHERE parent_job_id=$1 ORDER BY created_at,id",
      [jobId],
    )
  ).rows as unknown as WorkflowJob[];
  const originals = (
    await db.query(
      "SELECT r.*,s.output_data FROM workflow_runs r JOIN workflow_jobs j ON j.id=r.job_id LEFT JOIN step_executions s ON s.id=r.result_step_id WHERE j.parent_job_id=$1 AND r.kind='manual' ORDER BY r.created_at,r.id",
      [jobId],
    )
  ).rows;
  const sessions = (
    await db.query(
      "SELECT s.*,a.rerun_id FROM repair_sessions s JOIN workflow_jobs j ON j.id=s.job_id LEFT JOIN repair_attempts a ON a.session_id=s.id AND a.status='accepted' WHERE j.parent_job_id=$1 AND s.origin='run'",
      [jobId],
    )
  ).rows;
  const accepted = (
    await db.query(
      "SELECT r.*,s.output_data FROM workflow_runs r LEFT JOIN step_executions s ON s.id=r.result_step_id WHERE r.id=ANY($1::uuid[])",
      [sessions.flatMap((s) => (s.rerun_id ? [s.rerun_id] : []))],
    )
  ).rows;
  const executions = originals.map((original) => {
    const recovery = sessions.find((s) => s.source_run_id === original.id);
    const repaired =
      recovery?.status === "recovered"
        ? accepted.find((r) => r.id === recovery.rerun_id)
        : undefined;
    const actual = repaired ?? original;
    const activeJob = jobs.find(
      (j) => j.id === (recovery?.job_id ?? original.job_id),
    )!;
    return {
      source_job_id: String(original.job_id),
      source_run_id: String(original.id),
      run: runRecord(actual),
      output: actual.output_data as Json | null,
      recovery: recovery
        ? {
            id: String(recovery.id),
            job_id: String(recovery.job_id),
            status: String(recovery.status),
            stop_reason: recovery.stop_reason as string | null,
          }
        : null,
      active_job: activeJob,
      terminal: !activeStatuses.includes(activeJob.status),
      completed:
        actual.status === "completed" &&
        (!recovery || recovery.status === "recovered"),
    };
  });
  const decision = (
    await db.query(
      "SELECT * FROM grouping_decisions WHERE parent_job_id=$1 ORDER BY sequence DESC LIMIT 1",
      [jobId],
    )
  ).rows[0];
  const result = decision?.result as GroupingResult | undefined;
  const history = (
    await db.query(
      "SELECT * FROM grouped_children WHERE parent_job_id=$1 ORDER BY created_at,id",
      [jobId],
    )
  ).rows;
  const children = (result?.groups ?? []).map((group) => {
    const child = history.filter((c) => c.group_key === group.key).at(-1);
    if (!child)
      throw new DomainError(
        500,
        "GROUP_CHILD_MISSING",
        "A published group has no sealed child execution.",
      );
    const execution = executions.find((e) => e.source_job_id === child.job_id)!;
    return {
      id: String(child.id),
      group_key: group.key,
      label: group.label,
      input_bundle_id: String(child.input_bundle_id),
      job_id: String(child.job_id),
      supersedes_child_id: child.supersedes_child_id as string | null,
      execution,
    };
  });
  const phases = executions.filter((e) => e.run.execution_mode !== "workflow");
  const grouping =
    phases.filter((e) => e.run.execution_mode === "grouping").at(-1) ?? null;
  const aggregate =
    phases.find((e) => e.run.execution_mode === "aggregate") ?? null;
  const questions = (
    await db.query(
      "SELECT * FROM grouping_questions WHERE parent_job_id=$1 ORDER BY created_at,id",
      [jobId],
    )
  ).rows;
  const used = Number(
    (
      await db.query(
        "SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) AS used FROM grouped_inference_charges WHERE parent_job_id=$1",
        [jobId],
      )
    ).rows[0].used,
  );
  return {
    job,
    record,
    jobs,
    executions,
    children,
    child_history: history,
    decision: decision
      ? {
          id: String(decision.id),
          sequence: Number(decision.sequence),
          source_run_id: String(decision.source_run_id),
          result: result!,
        }
      : null,
    grouping,
    aggregate,
    questions,
    coverage: result ? groupingCoverage(result) : null,
    spent_or_reserved_usd: used,
    completed_groups: children.filter((c) => c.execution.completed).length,
    failed_groups: children.filter(
      (c) => c.execution.terminal && !c.execution.completed,
    ).length,
  };
}
export type GroupedState = Awaited<ReturnType<typeof groupedExecutionState>>;
