import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type {
  WorkflowJob,
  ImplementationVersion,
} from "../../domain/engineering";
import {
  startRepairInput,
  repairBlocker,
  repairSources,
  type RepairSession,
  type RepairAttempt,
} from "../../domain/repair";
import { regressionDecision } from "../../domain/grading";
import type { Project } from "../../domain/project";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { planById, planSteps, frozenSpec } from "../engineering/plan-service";
import {
  EvaluationService,
  evaluationById,
  resultsByEvaluation,
} from "../evaluations/evaluation-service";
import { suiteById, suiteCases } from "../evaluations/suite-service";
import { inputInventory } from "./evidence";
export async function sessionByJob(tx: Queryable, jobId: string) {
  const row = (
    await tx.query("SELECT * FROM repair_sessions WHERE job_id=$1", [jobId])
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Repair session not found.");
  return row as unknown as RepairSession;
}
export async function attemptById(tx: Queryable, id: string) {
  const row = (
    await tx.query("SELECT * FROM repair_attempts WHERE id=$1", [id])
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Repair attempt not found.");
  return row as unknown as RepairAttempt;
}
function active(job: WorkflowJob, session: RepairSession) {
  if (job.status !== "running" || session.status !== "running")
    throw new DomainError(
      409,
      "REPAIR_INACTIVE",
      "This repair session no longer accepts changes.",
    );
  if (new Date(job.deadline_at).getTime() <= Date.now())
    throw new DomainError(
      409,
      "REPAIR_EXPIRED",
      "The repair session reached its two-hour limit.",
    );
}
async function evaluationTraces(
  db: Queryable,
  workflowId: string,
  evaluationId: string,
  caseIds?: string[],
) {
  return (
    await db.query(
      "SELECT count(*) OVER() AS total_occurrences,c.case_id,s.id AS occurrence_id,s.run_id,s.node_id,s.node_visit_number,s.status,s.output_data,s.failure_code,s.failure_message FROM step_executions s JOIN workflow_runs r ON r.id=s.run_id JOIN evaluation_case_results c ON c.id=r.evaluation_case_result_id WHERE c.workflow_id=$1 AND c.evaluation_run_id=$2 AND ($3::uuid[] IS NULL OR c.case_id=ANY($3::uuid[])) ORDER BY (s.failure_code IS NULL),s.started_at,s.id LIMIT 300",
      [workflowId, evaluationId, caseIds ?? null],
    )
  ).rows;
}
async function evaluationAudits(
  db: Queryable,
  workflowId: string,
  evaluationId: string,
  caseIds?: string[],
) {
  return (
    await db.query(
      `SELECT count(*) OVER() AS total_events,a.*,c.case_id,COALESCE(s.node_id,t.node_id) AS node_id
    FROM execution_audit_events a
    LEFT JOIN step_executions s ON s.id=a.step_execution_id
    LEFT JOIN workflow_runs r ON r.id=s.run_id
    JOIN evaluation_case_results c ON c.id=COALESCE(a.case_result_id,r.evaluation_case_result_id)
    JOIN evaluation_cases t ON t.id=c.case_id
    WHERE a.workflow_id=$1 AND c.evaluation_run_id=$2 AND ($3::uuid[] IS NULL OR c.case_id=ANY($3::uuid[]))
    ORDER BY (a.kind<>'failure'),a.created_at,a.sequence LIMIT 300`,
      [workflowId, evaluationId, caseIds ?? null],
    )
  ).rows;
}
export class RepairService {
  constructor(private db: Database) {}
  async start(wid: string, raw: z.infer<typeof startRepairInput>) {
    const data = startRepairInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const source = { baseline_evaluation_id: data.baseline_evaluation_id };
      const prior = (
        await tx.query(
          "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
          [wid, data.request_key],
        )
      ).rows[0] as unknown as WorkflowJob | undefined;
      if (prior) {
        if (
          prior.kind !== "repair" ||
          !isDeepStrictEqual(prior.source_request, source)
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request belongs to a different repair baseline.",
          );
        return { job: prior, session: await sessionByJob(tx, prior.id) };
      }
      const evaluation = await evaluationById(tx, data.baseline_evaluation_id);
      if (evaluation.workflow_id !== wid)
        throw new DomainError(
          404,
          "NOT_FOUND",
          "Evaluation not found on this workflow.",
        );
      const blocker = repairBlocker(
        evaluation,
        await resultsByEvaluation(tx, evaluation.id),
      );
      if (blocker)
        throw new DomainError(422, "BASELINE_NOT_REPAIRABLE", blocker);
      const suite = await suiteById(tx, wid, evaluation.suite_version_id);
      if (suite.state !== "locked")
        throw new DomainError(
          422,
          "SUITE_NOT_LOCKED",
          "Repair requires locked expectations.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM evaluation_suite_versions WHERE workflow_id=$1 AND version_number>$2",
            [wid, suite.version_number],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "SUITE_CHANGED",
          "Finish the latest suite revision and evaluate the chosen baseline against it before starting repair.",
        );
      const version = (
        await tx.query(
          "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
          [wid, evaluation.implementation_version_id],
        )
      ).rows[0] as unknown as ImplementationVersion;
      const plan = await planById(tx, wid, version.plan_version_id);
      if (plan.state !== "approved")
        throw new DomainError(
          422,
          "PLAN_NOT_APPROVED",
          "Repair requires the engineer-approved plan.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM workflow_jobs WHERE workflow_id=$1 AND status IN ('queued','running','waiting_for_human','cancel_requested')",
            [wid],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "OPERATION_ACTIVE",
          "Wait for or cancel the active operation first.",
        );
      const id = randomUUID();
      const job = (
        await tx.query(
          "INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,suite_version_id,executor_ref,deadline_at) VALUES($1,$2,'repair',$3,$4,$5,$6,$7,$8,now()+interval '2 hours') RETURNING *",
          [
            id,
            wid,
            data.request_key,
            source,
            plan.id,
            version.id,
            suite.id,
            `job-${id}`,
          ],
        )
      ).rows[0] as unknown as WorkflowJob;
      const session = (
        await tx.query(
          "INSERT INTO repair_sessions(workflow_id,job_id,plan_version_id,suite_version_id,initial_version_id,initial_evaluation_id,baseline_version_id,baseline_evaluation_id) VALUES($1,$2,$3,$4,$5,$6,$5,$6) RETURNING *",
          [wid, id, plan.id, suite.id, version.id, evaluation.id],
        )
      ).rows[0] as unknown as RepairSession;
      return { job, session };
    });
  }
  async prepare(jobId: string) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, jobId);
      const session = await sessionByJob(tx, jobId);
      if (!["queued", "running"].includes(session.status)) return null;
      if (job.status === "cancel_requested")
        throw new DomainError(
          409,
          "REPAIR_CANCELLED",
          "This repair session was cancelled.",
        );
      if (
        !["queued", "running"].includes(job.status) ||
        new Date(job.deadline_at).getTime() <= Date.now()
      )
        throw new DomainError(
          409,
          "REPAIR_EXPIRED",
          "This repair operation is no longer active.",
        );
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='preparing repair',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [jobId],
      );
      await tx.query(
        "UPDATE repair_sessions SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [session.id],
      );
      return {
        session: await sessionByJob(tx, jobId),
        deadline_at: job.deadline_at,
      };
    });
  }
  async beginAttempt(jobId: string, number: number) {
    return this.db.transaction(async (tx) => {
      const old = await jobById(tx, jobId);
      await workflow(tx, old.workflow_id, true);
      const job = await jobById(tx, jobId),
        session = await sessionByJob(tx, jobId);
      active(job, session);
      const prior = (
        await tx.query(
          "SELECT * FROM repair_attempts WHERE session_id=$1 AND attempt_number=$2",
          [session.id, number],
        )
      ).rows[0];
      if (prior) return prior as unknown as RepairAttempt;
      const attempts = (
        await tx.query("SELECT * FROM repair_attempts WHERE session_id=$1", [
          session.id,
        ])
      ).rows;
      if (
        number !== attempts.length + 1 ||
        number > session.attempt_limit ||
        attempts.some((a) => a.status === "running")
      )
        throw new DomainError(
          409,
          "ATTEMPT_LIMIT",
          "Repair attempts must run sequentially within the three-attempt limit.",
        );
      const attempt = (
        await tx.query(
          "INSERT INTO repair_attempts(workflow_id,session_id,attempt_number,baseline_version_id,baseline_evaluation_id) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [
            session.workflow_id,
            session.id,
            number,
            session.baseline_version_id,
            session.baseline_evaluation_id,
          ],
        )
      ).rows[0] as unknown as RepairAttempt;
      await tx.query(
        "UPDATE workflow_jobs SET phase=$2,progress=$3,updated_at=now() WHERE id=$1",
        [
          jobId,
          `repair attempt ${number}: diagnosing`,
          {
            session_id: session.id,
            attempt: number,
            attempt_limit: session.attempt_limit,
          },
        ],
      );
      return attempt;
    });
  }
  async claimGeneration(attemptId: string) {
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId);
      await workflow(tx, old.workflow_id, true);
      const attempt = await attemptById(tx, attemptId),
        session = (
          await tx.query("SELECT * FROM repair_sessions WHERE id=$1", [
            attempt.session_id,
          ])
        ).rows[0] as unknown as RepairSession,
        job = await jobById(tx, session.job_id);
      active(job, session);
      if (attempt.status !== "running" || attempt.candidate_version_id)
        return { attempt, session, job, token: null };
      const row = (
        await tx.query(
          "SELECT invocation_count FROM repair_attempts WHERE id=$1",
          [attemptId],
        )
      ).rows[0];
      if (Number(row.invocation_count) >= 2)
        throw new DomainError(
          422,
          "REPAIR_RETRY_LIMIT",
          "This attempt exhausted its generation retry allowance.",
        );
      const token = randomUUID();
      await tx.query(
        "UPDATE repair_attempts SET invocation_count=invocation_count+1,attempt_token=$2 WHERE id=$1",
        [attemptId, token],
      );
      return { attempt, session, job, token };
    });
  }
  async generationContext(attemptId: string) {
    const attempt = await attemptById(this.db, attemptId),
      session = (
        await this.db.query("SELECT * FROM repair_sessions WHERE id=$1", [
          attempt.session_id,
        ])
      ).rows[0] as unknown as RepairSession;
    const plan = await planById(
      this.db,
      session.workflow_id,
      session.plan_version_id,
    );
    const cases = await suiteCases(this.db, session.suite_version_id);
    const bundleIds = [
      ...new Set(
        cases.flatMap((c) => (c.input_bundle_id ? [c.input_bundle_id] : [])),
      ),
    ];
    const inventory = inputInventory(
      (
        await this.db.query(
          "SELECT id,shipment_reference,manifest FROM input_bundles WHERE workflow_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
          [session.workflow_id, bundleIds],
        )
      ).rows,
    );
    const previous = (
      await this.db.query(
        "SELECT session_id,attempt_number,candidate_version_id,baseline_evaluation_id,diagnosis,status,decision_reason,error_message,evaluation_run_id FROM repair_attempts WHERE session_id=$1 AND attempt_number<$2 ORDER BY attempt_number",
        [session.id, attempt.attempt_number],
      )
    ).rows as unknown as Pick<
      RepairAttempt,
      | "session_id"
      | "attempt_number"
      | "candidate_version_id"
      | "baseline_evaluation_id"
      | "diagnosis"
      | "status"
      | "decision_reason"
      | "error_message"
      | "evaluation_run_id"
    >[];
    // An explicit restart must not forget the completed candidate which exposed
    // a harness/operational blocker. Keep one prior-session candidate only when
    // this session has no candidate history, with exactly the same starting evidence.
    if (!previous.length) {
      const priorSession = await this.db.query(
        `SELECT a.session_id,a.attempt_number,a.candidate_version_id,a.baseline_evaluation_id,a.diagnosis,a.status,a.decision_reason,a.error_message,a.evaluation_run_id
         FROM repair_sessions s JOIN repair_attempts a ON a.session_id=s.id
         WHERE s.workflow_id=$1 AND s.id<>$2 AND s.plan_version_id=$3 AND s.suite_version_id=$4
         AND s.status NOT IN ('queued','running') AND a.baseline_evaluation_id=$5
         AND a.status IN ('accepted','rejected') AND a.candidate_version_id IS NOT NULL AND a.evaluation_run_id IS NOT NULL
         ORDER BY s.created_at DESC,a.attempt_number DESC LIMIT 1`,
        [session.workflow_id, session.id, session.plan_version_id, session.suite_version_id, attempt.baseline_evaluation_id],
      );
      previous.push(...(priorSession.rows as unknown as typeof previous));
    }
    // Current-session history has at most two earlier candidates. Historical
    // diagnostics never change the retained baseline or reset the attempt count.
    const baselineResults = await resultsByEvaluation(
      this.db,
      attempt.baseline_evaluation_id,
    );
    const previousAttempts = await Promise.all(
      previous.map(async (prior) => {
        const results = prior.evaluation_run_id
          ? await resultsByEvaluation(this.db, prior.evaluation_run_id)
          : [];
        const earlierBaseline =
          prior.baseline_evaluation_id === attempt.baseline_evaluation_id
            ? baselineResults
            : await resultsByEvaluation(this.db, prior.baseline_evaluation_id);
        const priorPasses = new Map(
          earlierBaseline.map((result) => [
            result.case_id,
            result.check_results.filter((check) => check.passed),
          ]),
        );
        const diagnosticCases = results
          .filter(
            (result) =>
              result.outcome === "failed" ||
              result.outcome === "error" ||
              result.outcome === "not_run" ||
              priorPasses
                .get(result.case_id)
                ?.some(
                  (check) =>
                    !result.check_results.some(
                      (actual) => actual.key === check.key && actual.passed,
                    ),
                ),
          )
          .map((result) => result.case_id);
        return {
          ...prior,
          candidate_trace_scope: {
            selection:
              "Cases with failed assertions, previously passing assertions lost, or execution errors/incomplete evidence. Passing non-regressing cases remain stored but are not included.",
            case_ids: diagnosticCases,
          },
          candidate_traces: prior.evaluation_run_id
            ? await evaluationTraces(
                this.db,
                session.workflow_id,
                prior.evaluation_run_id,
                diagnosticCases,
              )
            : [],
          candidate_audit_events: prior.evaluation_run_id
            ? await evaluationAudits(
                this.db,
                session.workflow_id,
                prior.evaluation_run_id,
                diagnosticCases,
              )
            : [],
          candidate_results: results.map((result) => ({
            case_id: result.case_id,
            outcome: result.outcome,
            check_results: result.check_results,
            failure_code: result.failure_code,
            failure_message: result.failure_message,
            failure_category: result.failure_category,
          })),
        };
      }),
    );
    return {
      attempt,
      session,
      plan,
      steps: await planSteps(this.db, plan.id),
      spec: await frozenSpec(this.db, session.workflow_id),
      evaluation: await evaluationById(this.db, attempt.baseline_evaluation_id),
      results: baselineResults,
      cases,
      input_inventory: inventory,
      traces: await evaluationTraces(
        this.db,
        session.workflow_id,
        attempt.baseline_evaluation_id,
      ),
      audit_events: await evaluationAudits(
        this.db,
        session.workflow_id,
        attempt.baseline_evaluation_id,
      ),
      previous_attempts: previousAttempts,
    };
  }
  async publishCandidate(
    attemptId: string,
    token: string,
    artifactId: string,
    project: Project,
    diagnosis: z.infer<typeof repairSources>["diagnosis"],
  ) {
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId);
      await workflow(tx, old.workflow_id, true);
      const attempt = await attemptById(tx, attemptId),
        session = (
          await tx.query("SELECT * FROM repair_sessions WHERE id=$1", [
            attempt.session_id,
          ])
        ).rows[0] as unknown as RepairSession,
        job = await jobById(tx, session.job_id);
      if (attempt.candidate_version_id) return attempt;
      active(job, session);
      const row = (
        await tx.query(
          "SELECT attempt_token FROM repair_attempts WHERE id=$1",
          [attemptId],
        )
      ).rows[0];
      if (attempt.status !== "running" || row.attempt_token !== token)
        throw new DomainError(
          409,
          "STALE_REPAIR_RESULT",
          "A newer invocation owns this repair attempt.",
        );
      const artifact = (
        await tx.query(
          "SELECT * FROM artifacts WHERE workflow_id=$1 AND id=$2 AND kind='generated_project' AND state='ready'",
          [job.workflow_id, artifactId],
        )
      ).rows[0];
      if (
        !artifact ||
        project.workflow_id !== job.workflow_id ||
        project.plan_version_id !== job.plan_version_id ||
        artifact.metadata === null ||
        (artifact.metadata as Record<string, unknown>).repair_attempt_id !==
          attempt.id
      )
        throw new DomainError(
          422,
          "INVALID_CANDIDATE",
          "The candidate must belong to this repair attempt and its approved plan.",
        );
      const spec = await frozenSpec(tx, job.workflow_id),
        steps = await planSteps(tx, job.plan_version_id);
      if (
        project.frozen_spec_id !== spec.id ||
        Object.keys(project.node_file_map).length !== steps.length ||
        steps.some((s) => !project.node_file_map[s.node_id]) ||
        diagnosis.affected_node_ids.some((id) => !project.node_file_map[id])
      )
        throw new DomainError(
          422,
          "INVALID_CANDIDATE",
          "The candidate must preserve the frozen process and every approved step.",
        );
      const version = (
        await tx.query(
          "INSERT INTO implementation_versions(workflow_id,plan_version_id,version_number,parent_version_id,created_by_job_id,generation_key,artifact_id,entrypoint,node_file_map) VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM implementation_versions WHERE workflow_id=$1),$3,$4,$5,$6,$7,$8) RETURNING *",
          [
            job.workflow_id,
            job.plan_version_id,
            attempt.baseline_version_id,
            job.id,
            `repair-${attempt.id}`,
            artifactId,
            project.entrypoint,
            project.node_file_map,
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE repair_attempts SET candidate_version_id=$2,diagnosis=$3,attempt_token=NULL WHERE id=$1",
        [attempt.id, version.id, diagnosis],
      );
      return attemptById(tx, attempt.id);
    });
  }
  async createEvaluation(attemptId: string, round = 1) {
    if (!Number.isInteger(round) || round < 1 || round > 3) throw new DomainError(422, "INVALID_CONFIRMATION", "Confirmation round must be 1, 2, or 3.");
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId);
      await workflow(tx, old.workflow_id, true);
      const attempt = await attemptById(tx, attemptId),
        session = (
          await tx.query("SELECT * FROM repair_sessions WHERE id=$1", [
            attempt.session_id,
          ])
        ).rows[0] as unknown as RepairSession,
        job = await jobById(tx, session.job_id);
      active(job, session);
      const prior = (await tx.query("SELECT evaluation_run_id FROM repair_confirmations WHERE attempt_id=$1 AND round=$2", [attemptId, round])).rows[0];
      if (prior) return evaluationById(tx, String(prior.evaluation_run_id));
      if (attempt.status !== "running" || !attempt.candidate_version_id)
        throw new DomainError(
          409,
          "NO_CANDIDATE",
          "This attempt has no candidate ready for evaluation.",
        );
      const evaluation = await new EvaluationService(this.db).createRun(
        tx,
        job,
        attempt.candidate_version_id,
        session.suite_version_id,
        `repair-${attempt.id}-confirmation-${round}`,
      );
      await tx.query("INSERT INTO repair_confirmations(workflow_id,attempt_id,round,evaluation_run_id) VALUES($1,$2,$3,$4)", [attempt.workflow_id, attempt.id, round, evaluation.id]);
      await tx.query(
        "UPDATE repair_attempts SET evaluation_run_id=$2 WHERE id=$1",
        [attempt.id, evaluation.id],
      );
      return evaluation;
    });
  }
  async decide(attemptId: string) {
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId);
      await workflow(tx, old.workflow_id, true);
      const attempt = await attemptById(tx, attemptId),
        session = (
          await tx.query("SELECT * FROM repair_sessions WHERE id=$1", [
            attempt.session_id,
          ])
        ).rows[0] as unknown as RepairSession,
        job = await jobById(tx, session.job_id);
      if (attempt.status !== "running") return { attempt, session };
      active(job, session);
      if (!attempt.evaluation_run_id)
        throw new DomainError(
          409,
          "EVALUATION_REQUIRED",
          "Run the full suite before deciding this attempt.",
        );
      const evaluation = await evaluationById(tx, attempt.evaluation_run_id);
      if (!["completed", "blocked"].includes(evaluation.status))
        throw new DomainError(
          409,
          "EVALUATION_INCOMPLETE",
          "Wait for the candidate's complete evaluation.",
        );
      const results = await resultsByEvaluation(tx, evaluation.id),
        baseline = await resultsByEvaluation(
          tx,
          attempt.baseline_evaluation_id,
        ),
        expected = await suiteCases(tx, session.suite_version_id);
      const decision = regressionDecision(baseline, results, expected);
      const confirmations = (await tx.query("SELECT c.round,e.status,e.verdict,e.execution_configuration FROM repair_confirmations c JOIN evaluation_runs e ON e.id=c.evaluation_run_id WHERE c.attempt_id=$1 ORDER BY c.round", [attempt.id])).rows;
      const completePass = decision.accepted && evaluation.status === "completed" && evaluation.verdict === "passed";
      if (completePass && confirmations.length < 3) {
        await tx.query("UPDATE workflow_jobs SET phase=$2,progress=$3,updated_at=now() WHERE id=$1", [job.id, `confirming repeatability ${confirmations.length}/3`, { session_id: session.id, attempt: attempt.attempt_number, confirmations_passed: confirmations.length, confirmations_required: 3 }]);
        return { attempt, session };
      }
      const confirmed = completePass && confirmations.length === 3 && confirmations.every((c, i) => c.round === i + 1 && c.status === "completed" && c.verdict === "passed" && JSON.stringify(c.execution_configuration) === JSON.stringify(confirmations[0].execution_configuration));
      await tx.query(
        "UPDATE repair_attempts SET status=$2,decision_reason=$3,finished_at=now(),attempt_token=NULL WHERE id=$1",
        [
          attempt.id,
          decision.accepted ? "accepted" : "rejected",
          decision.reason,
        ],
      );
      const blocker =
        evaluation.verdict === "passed"
          ? null
          : repairBlocker(evaluation, results);
      const done = confirmed,
        stop =
          done || !!blocker || attempt.attempt_number >= session.attempt_limit;
      const status = done ? "passed" : stop ? "needs_attention" : "running";
      const reason = done
        ? "Three consecutive complete passes with the same candidate, locked suite, and execution configuration. This is demo confirmation, not a guarantee for unseen inputs."
        : blocker ||
          (stop
            ? "The three-attempt limit was reached. Inspect the remaining failures before starting another session."
            : null);
      await tx.query(
        "UPDATE repair_sessions SET baseline_version_id=$2,baseline_evaluation_id=$3,status=$4,stop_reason=$5,finished_at=$6,updated_at=now() WHERE id=$1",
        [
          session.id,
          decision.accepted
            ? attempt.candidate_version_id
            : session.baseline_version_id,
          decision.accepted ? evaluation.id : session.baseline_evaluation_id,
          status,
          reason,
          stop ? new Date().toISOString() : null,
        ],
      );
      await tx.query(
        "UPDATE workflow_jobs SET phase=$2,progress=$3,status=$4,finished_at=$5,updated_at=now() WHERE id=$1",
        [
          job.id,
          stop
            ? `repair ${status}`
            : `attempt ${attempt.attempt_number} ${decision.accepted ? "accepted" : "rejected"}`,
          {
            session_id: session.id,
            attempt: attempt.attempt_number,
            decision: decision.reason,
          },
          stop ? "succeeded" : "running",
          stop ? new Date().toISOString() : null,
        ],
      );
      return {
        attempt: await attemptById(tx, attempt.id),
        session: await sessionByJob(tx, job.id),
      };
    });
  }
  async finish(
    jobId: string,
    status: "failed" | "cancelled" | "needs_attention",
    reason: string,
    code?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const old = await jobById(tx, jobId);
      await workflow(tx, old.workflow_id, true);
      const job = await jobById(tx, jobId),
        session = await sessionByJob(tx, jobId);
      if (!["queued", "running"].includes(session.status)) return session;
      const final = job.status === "cancel_requested" ? "cancelled" : status;
      const evaluations = (
        await tx.query(
          "SELECT id FROM evaluation_runs WHERE job_id=$1 AND status IN ('queued','running')",
          [jobId],
        )
      ).rows;
      for (const evaluation of evaluations)
        await new EvaluationService(this.db).finishInTransaction(
          tx,
          job,
          final === "cancelled"
            ? undefined
            : {
                code: code || "REPAIR_STOPPED",
                message: reason,
                category: "infrastructure",
              },
          final === "cancelled",
          String(evaluation.id),
        );
      await tx.query(
        "UPDATE repair_attempts SET status=$2,error_code=$3,error_message=$4,finished_at=now(),attempt_token=NULL WHERE session_id=$1 AND status='running'",
        [
          session.id,
          final === "cancelled" ? "cancelled" : "failed",
          code || null,
          reason,
        ],
      );
      await tx.query(
        "UPDATE repair_sessions SET status=$2,stop_reason=$3,finished_at=now(),updated_at=now() WHERE id=$1",
        [session.id, final, reason],
      );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,error_code=$4,error_message=$5,finished_at=now(),updated_at=now() WHERE id=$1",
        [
          jobId,
          final === "needs_attention" ? "succeeded" : final,
          `repair ${final}`,
          code || null,
          reason,
        ],
      );
      return sessionByJob(tx, jobId);
    });
  }
  async state(wid: string, id?: string) {
    await workflow(this.db, wid);
    const sessions = (
      await this.db.query(
        `SELECT * FROM repair_sessions WHERE workflow_id=$1 ${id ? "AND id=$2" : ""} ORDER BY created_at DESC,id DESC LIMIT 20`,
        id ? [wid, id] : [wid],
      )
    ).rows as unknown as RepairSession[];
    if (id && !sessions.length)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Repair session not found on this workflow.",
      );
    const attempts = sessions[0]
      ? ((
          await this.db.query(
            "SELECT * FROM repair_attempts WHERE session_id=$1 ORDER BY attempt_number",
            [sessions[0].id],
          )
        ).rows as unknown as RepairAttempt[])
      : [];
    const replays = sessions[0]
      ? (
          await this.db.query(
            "SELECT r.* FROM repair_replays r JOIN repair_attempts a ON a.id=r.attempt_id WHERE a.session_id=$1 ORDER BY a.attempt_number,r.call_number",
            [sessions[0].id],
          )
        ).rows
      : [];
    const confirmations = (await this.db.query("SELECT c.*,e.status,e.verdict FROM repair_confirmations c JOIN evaluation_runs e ON e.id=c.evaluation_run_id WHERE c.workflow_id=$1 ORDER BY c.created_at,c.round", [wid])).rows;
    return { sessions, attempts, replays, confirmations };
  }
}
