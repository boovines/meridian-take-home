import { clarificationSnapshot } from "./clarification-service";
import type { Database } from "../database";
import { RepairService } from "./service";
import { attemptById, sessionByJob } from "./service";
import { jobById } from "../engineering/job-service";
import { planById, planSteps, specForPlan } from "../engineering/plan-service";
import { runById } from "../runtime/store";
import {
  evaluationById,
  resultsByEvaluation,
} from "../evaluations/evaluation-service";
import { suiteCases } from "../evaluations/suite-service";
import { inputInventory } from "./evidence";
import type { EvaluationRun } from "../../domain/evaluation";
import type { RunRecord } from "../../domain/runtime";
export type RunRepairContext = Omit<
  Awaited<ReturnType<RepairService["evaluationGenerationContext"]>>,
  "evaluation"
> & {
  evaluation: EvaluationRun | null;
  source_run: RunRecord;
  clarification_context: Awaited<ReturnType<typeof clarificationSnapshot>>;
};
async function traces(db: Database, runId: string) {
  return (
    await db.query(
      "SELECT count(*) OVER() AS total_occurrences,id AS occurrence_id,run_id,node_id,node_visit_number,status,output_data,failure_code,failure_message FROM step_executions WHERE run_id=$1 ORDER BY (failure_code IS NULL),started_at,id LIMIT 300",
      [runId],
    )
  ).rows;
}
async function audits(db: Database, runId: string) {
  return (
    await db.query(
      "SELECT count(*) OVER() AS total_events,a.*,s.node_id FROM execution_audit_events a JOIN step_executions s ON s.id=a.step_execution_id WHERE s.run_id=$1 ORDER BY (a.kind<>'failure'),a.created_at,a.sequence LIMIT 300",
      [runId],
    )
  ).rows;
}
export async function runRepairContext(
  db: Database,
  attemptId: string,
  token?: string,
): Promise<RunRepairContext> {
  const attempt = await attemptById(db, attemptId);
  const s = (
    await db.query("SELECT job_id FROM repair_sessions WHERE id=$1", [
      attempt.session_id,
    ])
  ).rows[0];
  const session = await sessionByJob(db, String(s.job_id)),
    job = await jobById(db, session.job_id);
  if (!session.source_run_id || !session.input_bundle_id)
    throw new Error("Run recovery scope is incomplete.");
  const source = await runById(db, session.source_run_id),
    plan = await planById(db, session.workflow_id, session.plan_version_id);
  const previous = (
    await db.query(
      "SELECT * FROM repair_attempts WHERE session_id=$1 AND attempt_number<$2 ORDER BY attempt_number",
      [session.id, attempt.attempt_number],
    )
  ).rows;
  const regression =
    session.suite_version_id && attempt.baseline_evaluation_id
      ? await new RepairService(db).evaluationGenerationContext(attemptId)
      : null;
  const sourceInventory = inputInventory(
    (
      await db.query(
        "SELECT id,shipment_reference,manifest FROM input_bundles WHERE workflow_id=$1 AND id=$2",
        [job.workflow_id, session.input_bundle_id],
      )
    ).rows,
  );
  return {
    attempt,
    clarification_context: await clarificationSnapshot(db, attemptId, token),
    session,
    plan,
    source_run: source,
    spec: await specForPlan(db, session.workflow_id, session.plan_version_id),
    steps: await planSteps(db, plan.id),
    evaluation: session.baseline_evaluation_id
      ? await evaluationById(db, session.baseline_evaluation_id)
      : null,
    results: session.baseline_evaluation_id
      ? await resultsByEvaluation(db, session.baseline_evaluation_id)
      : [],
    cases: session.suite_version_id
      ? await suiteCases(db, session.suite_version_id)
      : [],
    input_inventory: [
      ...new Map(
        [...sourceInventory, ...(regression?.input_inventory ?? [])].map(
          (b) => [b.input_bundle_id, b],
        ),
      ).values(),
    ],
    traces: [...(await traces(db, source.id)), ...(regression?.traces ?? [])],
    audit_events: [
      ...(await audits(db, source.id)),
      ...(regression?.audit_events ?? []),
    ],
    baseline_repetitions: [],
    previous_attempts: await Promise.all(
      previous.map(async (prior) => {
        const evaluated = regression?.previous_attempts.find(
          (a) =>
            a.attempt_number === Number(prior.attempt_number) &&
            a.session_id === session.id,
        );
        return {
          session_id: String(prior.session_id),
          attempt_number: Number(prior.attempt_number),
          candidate_version_id: prior.candidate_version_id as string | null,
          baseline_evaluation_id: prior.baseline_evaluation_id as string | null,
          diagnosis: prior.diagnosis as typeof attempt.diagnosis,
          status: prior.status as typeof attempt.status,
          decision_reason: prior.decision_reason as string | null,
          error_message: prior.error_message as string | null,
          evaluation_run_id: prior.evaluation_run_id as string | null,
          candidate_trace_scope: {
            selection:
              "Captured input rerun and failed regression cases from this recovery attempt.",
            case_ids: evaluated?.candidate_trace_scope.case_ids ?? [],
          },
          candidate_traces: [
            ...(prior.rerun_id ? await traces(db, String(prior.rerun_id)) : []),
            ...(evaluated?.candidate_traces ?? []),
          ],
          candidate_audit_events: [
            ...(prior.rerun_id ? await audits(db, String(prior.rerun_id)) : []),
            ...(evaluated?.candidate_audit_events ?? []),
          ],
          candidate_results: evaluated?.candidate_results ?? [],
        };
      }),
    ),
  };
}
