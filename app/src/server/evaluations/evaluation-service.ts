import { evaluationConfiguration, assertEvaluationConfiguration } from "./configuration";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type {
  EvaluationRun,
  CaseResult,
  startEvaluationInput,
} from "../../domain/evaluation";
import {
  DEMO_LIMITS,
  type Json,
  type RuntimeError,
} from "../../domain/runtime";
import { grade, verdict } from "../../domain/grading";
import type {
  WorkflowJob,
  ImplementationVersion,
} from "../../domain/engineering";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { suiteById, suiteCases } from "./suite-service";
export async function evaluationById(tx: Queryable, id: string) {
  const row = (
    await tx.query("SELECT * FROM evaluation_runs WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Evaluation not found.");
  return row as unknown as EvaluationRun;
}
export async function resultsByEvaluation(tx: Queryable, id: string) {
  return (
    await tx.query(
      "SELECT r.*,wr.id AS workflow_run_id FROM evaluation_case_results r LEFT JOIN workflow_runs wr ON wr.evaluation_case_result_id=r.id WHERE r.evaluation_run_id=$1 ORDER BY r.created_at,r.id",
      [id],
    )
  ).rows as unknown as CaseResult[];
}
const terminal = ["completed", "blocked", "cancelled"];
export class EvaluationService {
  constructor(private db: Database) {}
  async start(wid: string, data: z.infer<typeof startEvaluationInput>) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const source = {
        implementation_version_id: data.implementation_version_id,
        suite_version_id: data.suite_version_id,
      };
      const existing = (
        await tx.query(
          "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
          [wid, data.request_key],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.kind !== "evaluation" ||
          !isDeepStrictEqual(existing.source_request, source)
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request belongs to different evaluation inputs.",
          );
        return {
          job: existing as unknown as WorkflowJob,
          evaluation: (
            await tx.query(
              "SELECT * FROM evaluation_runs WHERE job_id=$1 AND run_key='initial'",
              [existing.id],
            )
          ).rows[0] as unknown as EvaluationRun,
        };
      }
      const suite = await suiteById(tx, wid, data.suite_version_id);
      if (suite.state !== "locked")
        throw new DomainError(
          422,
          "SUITE_NOT_LOCKED",
          "Verify and lock the suite before evaluating.",
        );
      const version = (
        await tx.query(
          "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
          [wid, data.implementation_version_id],
        )
      ).rows[0] as unknown as ImplementationVersion;
      if (!version)
        throw new DomainError(
          422,
          "INVALID_VERSION",
          "Choose code from this workflow.",
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
      const id = randomUUID(),
        job = (
          await tx.query(
            `INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,suite_version_id,executor_ref,deadline_at) VALUES($1,$2,'evaluation',$3,$4,$5,$6,$7,$8,now()+interval '4 hours') RETURNING *`,
            [
              id,
              wid,
              data.request_key,
              source,
              version.plan_version_id,
              version.id,
              suite.id,
              `job-${id}`,
            ],
          )
        ).rows[0] as unknown as WorkflowJob;
      return {
        job,
        evaluation: await this.createRun(
          tx,
          job,
          version.id,
          suite.id,
          "initial",
        ),
      };
    });
  }
  async createRun(
    tx: Queryable,
    job: WorkflowJob,
    versionId: string,
    suiteId: string,
    key: string,
  ) {
    const prior = (
      await tx.query(
        "SELECT * FROM evaluation_runs WHERE job_id=$1 AND run_key=$2",
        [job.id, key],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.implementation_version_id !== versionId ||
        prior.suite_version_id !== suiteId
      )
        throw new DomainError(
          409,
          "EVALUATION_KEY_REUSED",
          "Evaluation identity belongs to other versions.",
        );
      return prior as unknown as EvaluationRun;
    }
    const suite = await suiteById(tx, job.workflow_id, suiteId);
    const version = (
      await tx.query(
        "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
        [job.workflow_id, versionId],
      )
    ).rows[0];
    if (
      suite.state !== "locked" ||
      job.suite_version_id !== suiteId ||
      !version ||
      version.plan_version_id !== job.plan_version_id
    )
      throw new DomainError(
        422,
        "INVALID_EVALUATION",
        "Evaluation requires a locked suite and code using the operation's approved plan.",
      );
    const run = (
      await tx.query(
        "INSERT INTO evaluation_runs(workflow_id,job_id,implementation_version_id,suite_version_id,run_key) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [job.workflow_id, job.id, versionId, suiteId, key],
      )
    ).rows[0] as unknown as EvaluationRun;
    await tx.query(
      "INSERT INTO evaluation_case_results(workflow_id,evaluation_run_id,suite_version_id,case_id) SELECT workflow_id,$2,suite_version_id,id FROM evaluation_cases WHERE suite_version_id=$1",
      [suiteId, run.id],
    );
    return run;
  }
  async prepare(jobId: string, evaluationId?: string) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, jobId);
      const run = (
        await tx.query(
          evaluationId
            ? "SELECT * FROM evaluation_runs WHERE job_id=$1 AND id=$2"
            : "SELECT * FROM evaluation_runs WHERE job_id=$1 AND run_key='initial'",
          evaluationId ? [jobId, evaluationId] : [jobId],
        )
      ).rows[0] as unknown as EvaluationRun;
      if (
        !run ||
        (job.kind !== "evaluation" && !(job.kind === "repair" && evaluationId))
      )
        throw new DomainError(
          422,
          "INVALID_JOB",
          "Expected an evaluation operation.",
        );
      if (
        terminal.includes(run.status) ||
        ["succeeded", "failed", "cancelled"].includes(job.status)
      )
        return null;
      if (job.status === "cancel_requested")
        throw new DomainError(
          409,
          "JOB_CANCELLED",
          "Evaluation cancelled before starting.",
        );
      const configuration = evaluationConfiguration();
      const previous = (await tx.query(
        "SELECT e.execution_configuration FROM repair_confirmations c JOIN repair_confirmations earlier ON earlier.attempt_id=c.attempt_id AND earlier.round=1 JOIN evaluation_runs e ON e.id=earlier.evaluation_run_id WHERE c.evaluation_run_id=$1 AND c.round>1", [run.id]
      )).rows[0];
      if (previous) assertEvaluationConfiguration(previous.execution_configuration as Json);
      if (!isDeepStrictEqual(run.execution_configuration, {})) assertEvaluationConfiguration(run.execution_configuration);
      else await tx.query("UPDATE evaluation_runs SET execution_configuration=$2 WHERE id=$1", [run.id, configuration]);
      run.execution_configuration = configuration;
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='checking build',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [jobId],
      );
      await tx.query(
        "UPDATE evaluation_runs SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [run.id],
      );
      return {
        evaluation: run,
        results: await resultsByEvaluation(tx, run.id),
        deadline_at: job.deadline_at,
      };
    });
  }
  async beginCase(resultId: string) {
    return this.db.transaction(async (tx) => {
      let result = (
        await tx.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
          resultId,
        ])
      ).rows[0] as unknown as CaseResult;
      if (!result)
        throw new DomainError(404, "NOT_FOUND", "Case result not found.");
      await workflow(tx, result.workflow_id, true);
      result = (
        await tx.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
          resultId,
        ])
      ).rows[0] as unknown as CaseResult;
      const evaluation = await evaluationById(tx, result.evaluation_run_id),
        job = await jobById(tx, evaluation.job_id);
      if (result.status === "finished") return { skip: true as const };
      if (job.status !== "running" || evaluation.status !== "running")
        throw new DomainError(
          409,
          "EVALUATION_INACTIVE",
          "This evaluation can no longer execute cases.",
        );
      assertEvaluationConfiguration(evaluation.execution_configuration);
      const c = (await suiteCases(tx, evaluation.suite_version_id)).find(
        (c) => c.id === result.case_id,
      )!;
      await tx.query(
        "UPDATE evaluation_case_results SET status='running',started_at=coalesce(started_at,now()) WHERE id=$1",
        [resultId],
      );
      await tx.query(
        "UPDATE workflow_jobs SET phase=$2,progress=$3,updated_at=now() WHERE id=$1",
        [
          job.id,
          `evaluating ${c.name}`,
          { evaluation_id: evaluation.id, case_name: c.name },
        ],
      );
      if (c.kind === "step") return { skip: false as const, kind: c.kind };
      let run = (
        await tx.query(
          "SELECT id FROM workflow_runs WHERE evaluation_case_result_id=$1",
          [resultId],
        )
      ).rows[0];
      if (!run)
        run = (
          await tx.query(
            "INSERT INTO workflow_runs(workflow_id,job_id,implementation_version_id,input_bundle_id,kind,evaluation_case_result_id,limits) VALUES($1,$2,$3,$4,'evaluation',$5,$6) RETURNING id",
            [
              result.workflow_id,
              job.id,
              evaluation.implementation_version_id,
              c.input_bundle_id,
              resultId,
              DEMO_LIMITS,
            ],
          )
        ).rows[0];
      return { skip: false as const, kind: c.kind, run_id: String(run.id) };
    });
  }
  async recordCase(
    id: string,
    data: { actual: Json } | { error: RuntimeError },
    attemptToken?: string,
  ) {
    return this.db.transaction(async (tx) => {
      let result = (
        await tx.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
          id,
        ])
      ).rows[0] as unknown as CaseResult;
      if (!result)
        throw new DomainError(404, "NOT_FOUND", "Case result not found.");
      await workflow(tx, result.workflow_id, true);
      result = (
        await tx.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
          id,
        ])
      ).rows[0] as unknown as CaseResult;
      if (result.status === "finished") return result;
      const evaluation = await evaluationById(tx, result.evaluation_run_id),
        job = await jobById(tx, evaluation.job_id);
      if (
        result.status !== "running" ||
        evaluation.status !== "running" ||
        job.status !== "running"
      )
        throw new DomainError(
          409,
          "EVALUATION_INACTIVE",
          "This evaluation can no longer publish case results.",
        );
      if (attemptToken) {
        const token = (
          await tx.query(
            "SELECT attempt_token FROM evaluation_case_results WHERE id=$1",
            [id],
          )
        ).rows[0].attempt_token;
        if (token !== attemptToken)
          throw new DomainError(
            409,
            "STALE_EVALUATION_RESULT",
            "A newer case invocation owns this result.",
          );
      }
      const c = (await suiteCases(tx, evaluation.suite_version_id)).find(
        (c) => c.id === result.case_id,
      )!;
      const error = "error" in data ? data.error : null,
        actual = "actual" in data ? data.actual : null;
      const checks = error ? [] : grade(actual, c.assertions);
      const outcome = error
        ? "error"
        : checks.every((c) => c.passed)
          ? "passed"
          : "failed";
      return (
        await tx.query(
          "UPDATE evaluation_case_results SET status='finished',attempt_token=NULL,outcome=$2,actual_output=$3,check_results=$4,failure_category=$5,failure_code=$6,failure_message=$7,finished_at=now() WHERE id=$1 RETURNING *",
          [
            id,
            outcome,
            JSON.stringify(actual),
            JSON.stringify(checks),
            error?.category || null,
            error?.code || null,
            error?.message || null,
          ],
        )
      ).rows[0] as unknown as CaseResult;
    });
  }
  async finish(
    jobId: string,
    error?: RuntimeError,
    cancelled = false,
    evaluationId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const old = await jobById(tx, jobId);
      await workflow(tx, old.workflow_id, true);
      return this.finishInTransaction(
        tx,
        await jobById(tx, jobId),
        error,
        cancelled,
        evaluationId,
      );
    });
  }
  // Caller holds the workflow row lock; parent repair cleanup uses the same transaction.
  async finishInTransaction(
    tx: Queryable,
    job: WorkflowJob,
    error?: RuntimeError,
    cancelled = false,
    evaluationId?: string,
  ) {
    const jobId = job.id;
    const evaluation = (
      await tx.query(
        evaluationId
          ? "SELECT * FROM evaluation_runs WHERE job_id=$1 AND id=$2"
          : "SELECT * FROM evaluation_runs WHERE job_id=$1 AND run_key='initial'",
        evaluationId ? [jobId, evaluationId] : [jobId],
      )
    ).rows[0] as unknown as EvaluationRun;
    if (!evaluation || terminal.includes(evaluation.status)) return;
    const cancel = cancelled || job.status === "cancel_requested";
    const pending = (await resultsByEvaluation(tx, evaluation.id)).some(
      (r) => r.status !== "finished",
    );
    const problem =
      error ||
      (!cancel && pending
        ? {
            code: "INCOMPLETE_EVALUATION",
            message: "Some cases did not finish.",
            category: "infrastructure" as const,
          }
        : undefined);
    const status = cancel ? "cancelled" : problem ? "blocked" : "completed";
    // A stopped parent cannot leave a child visit appearing active forever.
    // These are history projections; Temporal still owns child cancellation.
    await tx.query(
      "UPDATE human_requests h SET status='cancelled',cancelled_at=now() FROM workflow_runs r WHERE h.run_id=r.id AND r.evaluation_case_result_id IN (SELECT id FROM evaluation_case_results WHERE evaluation_run_id=$1) AND h.status='pending'",
      [evaluation.id],
    );
    await tx.query(
      "UPDATE step_executions s SET status='cancelled',finished_at=now(),updated_at=now(),attempt_token=NULL FROM workflow_runs r WHERE s.run_id=r.id AND r.evaluation_case_result_id IN (SELECT id FROM evaluation_case_results WHERE evaluation_run_id=$1) AND s.status IN ('running','waiting_for_human')",
      [evaluation.id],
    );
    await tx.query(
      "UPDATE workflow_runs SET status=$2,failure_category=$3,failure_code=$4,failure_message=$5,active_elapsed_ms=active_elapsed_ms+CASE WHEN active_since IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM (now()-active_since))*1000)::bigint END,active_since=NULL,finished_at=now(),updated_at=now() WHERE evaluation_case_result_id IN (SELECT id FROM evaluation_case_results WHERE evaluation_run_id=$1) AND kind='evaluation' AND status IN ('queued','running','waiting_for_human')",
      [
        evaluation.id,
        cancel ? "cancelled" : "failed",
        cancel ? null : problem?.category || "infrastructure",
        cancel ? "CANCELLED" : problem?.code || "EVALUATION_ENDED",
        cancel
          ? "The evaluation was cancelled."
          : problem?.message ||
            "The parent evaluation ended before this execution finished.",
      ],
    );

    await tx.query(
      "UPDATE evaluation_case_results SET status='finished',outcome='not_run',failure_category=$2,failure_code=$3,failure_message=$4,finished_at=now() WHERE evaluation_run_id=$1 AND status<>'finished'",
      [
        evaluation.id,
        problem?.category || null,
        cancel ? "CANCELLED" : problem?.code || "NOT_RUN",
        cancel
          ? "The evaluation was cancelled."
          : problem?.message || "Case did not run.",
      ],
    );
    const results = await resultsByEvaluation(tx, evaluation.id),
      cases = await suiteCases(tx, evaluation.suite_version_id);
    const resultVerdict =
      status === "completed" ? verdict(results, cases.length) : "inconclusive";
    await tx.query(
      "UPDATE evaluation_runs SET status=$2,verdict=$3,failure_category=$4,failure_code=$5,failure_message=$6,finished_at=now(),updated_at=now() WHERE id=$1",
      [
        evaluation.id,
        status,
        resultVerdict,
        problem?.category || null,
        problem?.code || null,
        problem?.message || null,
      ],
    );
    // Repair owns its exclusive job across multiple candidate evaluations.
    if (job.kind === "evaluation")
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,error_code=$4,error_message=$5,finished_at=now(),updated_at=now() WHERE id=$1",
        [
          jobId,
          cancel ? "cancelled" : problem ? "failed" : "succeeded",
          `evaluation ${resultVerdict}`,
          problem?.code || null,
          problem?.message || null,
        ],
      );
  }
  async state(wid: string, id?: string) {
    await workflow(this.db, wid);
    const runs = (
      await this.db.query(
        `SELECT e.*,v.version_number AS code_version_number,s.version_number AS suite_version_number FROM evaluation_runs e JOIN implementation_versions v ON v.id=e.implementation_version_id JOIN evaluation_suite_versions s ON s.id=e.suite_version_id WHERE e.workflow_id=$1 ${id ? "AND e.id=$2" : ""} ORDER BY e.created_at DESC,e.id DESC LIMIT 20`,
        id ? [wid, id] : [wid],
      )
    ).rows as unknown as EvaluationRun[];
    if (id && !runs.length)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Evaluation not found on this workflow.",
      );
    return {
      runs,
      results: runs[0] ? await resultsByEvaluation(this.db, runs[0].id) : [],
    };
  }
}
