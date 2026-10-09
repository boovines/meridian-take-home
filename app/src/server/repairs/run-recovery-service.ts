import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Database, Queryable } from "../database";
import type {
  WorkflowJob,
  ImplementationVersion,
} from "../../domain/engineering";
import {
  repairBlocker,
  type RepairSession,
  type RepairAttempt,
} from "../../domain/repair";
import { DomainError } from "../../domain/errors";
import {
  recoveryEligibility,
  RECOVERY_LIMITS,
  startRecoveryInput,
} from "../../domain/run-recovery";
import { DEMO_LIMITS } from "../../domain/runtime";
import { regressionDecision } from "../../domain/grading";
import { workflow } from "../workflows/store";
import { runById } from "../runtime/store";
import { jobById } from "../engineering/job-service";
import { evaluationConfiguration } from "../evaluations/configuration";
import {
  EvaluationService,
  evaluationById,
  resultsByEvaluation,
} from "../evaluations/evaluation-service";
import { suiteCases } from "../evaluations/suite-service";
import { attemptById, sessionByJob } from "./service";

export class RunRecoveryService {
  constructor(private db: Database) {}
  async state(wid: string, runId: string) {
    const run = await runById(this.db, runId);
    if (run.workflow_id !== wid)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Run not found on this workflow.",
      );
    const session = (
      await this.db.query(
        `SELECT s.* FROM repair_sessions s WHERE s.workflow_id=$1 AND s.origin='run'
      AND (s.source_run_id=$2 OR EXISTS(SELECT 1 FROM repair_attempts a WHERE a.session_id=s.id AND a.rerun_id=$2))`,
        [wid, runId],
      )
    ).rows[0] as unknown as RepairSession | undefined;
    if (!session) return null;
    return {
      session,
      job: await jobById(this.db, session.job_id),
      attempts: (
        await this.db.query(
          "SELECT * FROM repair_attempts WHERE session_id=$1 ORDER BY attempt_number",
          [session.id],
        )
      ).rows as unknown as RepairAttempt[],
      questions: (
        await this.db.query(
          "SELECT * FROM engineer_questions WHERE session_id=$1 ORDER BY created_at,id",
          [session.id],
        )
      ).rows,
      spent_or_reserved_usd: Number(
        (
          await this.db.query(
            "SELECT coalesce(sum(coalesce(actual_usd,reserved_usd)),0) AS used FROM recovery_inference_charges WHERE session_id=$1",
            [session.id],
          )
        ).rows[0].used,
      ),
    };
  }
  async start(wid: string, runId: string, raw: { request_key: string }) {
    const data = startRecoveryInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      return this.startInTransaction(tx, wid, runId, data.request_key);
    });
  }
  // Called after manual-run completion under the same workflow lock. The queued
  // repair row is the durable outbox; failure/completion delivery is idempotent.
  async startInTransaction(
    tx: Queryable,
    wid: string,
    runId: string,
    requestKey: string,
  ) {
    const run = await runById(tx, runId);
    if (run.workflow_id !== wid)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Run not found on this workflow.",
      );
    const existing = (
      await tx.query("SELECT * FROM repair_sessions WHERE source_run_id=$1", [
        runId,
      ])
    ).rows[0] as unknown as RepairSession | undefined;
    const requestJob = (
      await tx.query(
        "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
        [wid, requestKey],
      )
    ).rows[0];
    if (requestJob && (!existing || requestJob.id !== existing.job_id))
      throw new DomainError(
        409,
        "REQUEST_REUSED",
        "This request belongs to another operation.",
      );
    if (existing)
      return { session: existing, job: await jobById(tx, existing.job_id) };
    const eligibility = recoveryEligibility(run);
    if (!eligibility.eligible)
      throw new DomainError(422, "RUN_NOT_REPAIRABLE", eligibility.reason);
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
    const version = (
      await tx.query(
        "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
        [wid, run.implementation_version_id],
      )
    ).rows[0] as unknown as ImplementationVersion;
    const suite = (
      await tx.query(
        "SELECT id FROM evaluation_suite_versions WHERE workflow_id=$1 AND state='locked' ORDER BY version_number DESC LIMIT 1",
        [wid],
      )
    ).rows[0];
    const config = evaluationConfiguration();
    const baseline = suite
      ? (
          await tx.query(
            "SELECT id FROM evaluation_runs WHERE workflow_id=$1 AND implementation_version_id=$2 AND suite_version_id=$3 AND execution_configuration=$4::jsonb AND status='completed' ORDER BY created_at DESC LIMIT 1",
            [wid, version.id, suite.id, JSON.stringify(config)],
          )
        ).rows[0]
      : undefined;
    const jobId = randomUUID();
    const job = (
      await tx.query(
        `INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,suite_version_id,executor_ref,deadline_at)
      VALUES($1,$2,'repair',$3,$4,$5,$6,$7,$8,now()+interval '2 hours') RETURNING *`,
        [
          jobId,
          wid,
          requestKey,
          { origin: "run", source_run_id: runId },
          version.plan_version_id,
          version.id,
          suite?.id ?? null,
          `job-${jobId}`,
        ],
      )
    ).rows[0] as unknown as WorkflowJob;
    const session = (
      await tx.query(
        `INSERT INTO repair_sessions(workflow_id,job_id,origin,source_run_id,input_bundle_id,plan_version_id,suite_version_id,initial_version_id,initial_evaluation_id,baseline_version_id,baseline_evaluation_id,execution_configuration,recovery_limits)
      VALUES($1,$2,'run',$3,$4,$5,$6,$7,$8,$7,$8,$9,$10) RETURNING *`,
        [
          wid,
          jobId,
          runId,
          run.input_bundle_id,
          version.plan_version_id,
          suite?.id ?? null,
          version.id,
          baseline?.id ?? null,
          config,
          RECOVERY_LIMITS,
        ],
      )
    ).rows[0] as unknown as RepairSession;
    return { job, session };
  }
  private async active(tx: Queryable, jobId: string) {
    const job = await jobById(tx, jobId);
    await workflow(tx, job.workflow_id, true);
    const latest = await jobById(tx, jobId),
      session = await sessionByJob(tx, jobId);
    if (
      session.origin !== "run" ||
      session.status !== "running" ||
      latest.status !== "running"
    )
      throw new DomainError(
        409,
        "RECOVERY_INACTIVE",
        "This recovery no longer accepts work.",
      );
    if (new Date(latest.deadline_at).getTime() <= Date.now())
      throw new DomainError(
        409,
        "RECOVERY_LIMIT",
        "The recovery time limit was reached.",
      );
    if (
      !isDeepStrictEqual(
        session.execution_configuration,
        evaluationConfiguration(),
      )
    )
      throw new DomainError(
        409,
        "RECOVERY_CONFIGURATION_CHANGED",
        "Execution settings changed. Inspect the retained results before starting new work.",
      );
    return { job: latest, session };
  }
  async baselineEvaluation(jobId: string) {
    return this.db.transaction(async (tx) => {
      const { job, session } = await this.active(tx, jobId);
      if (!session.suite_version_id || session.baseline_evaluation_id)
        return null;
      const evaluation = await new EvaluationService(this.db).createRun(
        tx,
        job,
        session.initial_version_id,
        session.suite_version_id,
        "recovery-baseline",
      );
      await tx.query(
        "UPDATE workflow_jobs SET phase='establishing regression baseline',updated_at=now() WHERE id=$1",
        [jobId],
      );
      return evaluation.id;
    });
  }
  async recordBaseline(jobId: string, evaluationId: string) {
    return this.db.transaction(async (tx) => {
      const { session } = await this.active(tx, jobId),
        evaluation = await evaluationById(tx, evaluationId);
      if (
        evaluation.job_id !== jobId ||
        evaluation.implementation_version_id !== session.initial_version_id ||
        evaluation.suite_version_id !== session.suite_version_id ||
        evaluation.status !== "completed" ||
        !isDeepStrictEqual(
          evaluation.execution_configuration,
          session.execution_configuration,
        )
      )
        throw new DomainError(
          422,
          "REGRESSION_BASELINE_UNKNOWN",
          "A comparable completed regression baseline could not be established. Inspect the evaluation before continuing.",
        );
      await tx.query(
        "UPDATE repair_sessions SET baseline_evaluation_id=$2,updated_at=now() WHERE id=$1",
        [session.id, evaluation.id],
      );
    });
  }
  async createRerun(attemptId: string) {
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId);
      const sessionRow = (
        await tx.query("SELECT job_id FROM repair_sessions WHERE id=$1", [
          old.session_id,
        ])
      ).rows[0];
      const { job, session } = await this.active(tx, String(sessionRow.job_id)),
        attempt = await attemptById(tx, attemptId);
      if (attempt.rerun_id) return attempt.rerun_id;
      if (attempt.status !== "running" || !attempt.candidate_version_id)
        throw new DomainError(
          409,
          "NO_CANDIDATE",
          "Generate a candidate before rerunning.",
        );
      const row = (
        await tx.query(
          `INSERT INTO workflow_runs(workflow_id,job_id,implementation_version_id,input_bundle_id,kind,rerun_of_id,limits)
        VALUES($1,$2,$3,$4,'recovery',$5,$6) RETURNING id`,
          [
            job.workflow_id,
            job.id,
            attempt.candidate_version_id,
            session.input_bundle_id,
            session.source_run_id,
            DEMO_LIMITS,
          ],
        )
      ).rows[0];
      await tx.query("UPDATE repair_attempts SET rerun_id=$2 WHERE id=$1", [
        attemptId,
        row.id,
      ]);
      await tx.query(
        "UPDATE workflow_jobs SET phase=$2,progress=$3,updated_at=now() WHERE id=$1",
        [
          job.id,
          `rerunning captured input · attempt ${attempt.attempt_number}/3`,
          {
            session_id: session.id,
            attempt: attempt.attempt_number,
            run_id: row.id,
          },
        ],
      );
      return String(row.id);
    });
  }
  async regressionEvaluation(attemptId: string) {
    return this.db.transaction(async (tx) => {
      const attempt = await attemptById(tx, attemptId),
        s = (
          await tx.query("SELECT job_id FROM repair_sessions WHERE id=$1", [
            attempt.session_id,
          ])
        ).rows[0];
      const { job, session } = await this.active(tx, String(s.job_id));
      if (
        !attempt.rerun_id ||
        !attempt.candidate_version_id ||
        (await runById(tx, attempt.rerun_id)).status !== "completed" ||
        !session.suite_version_id
      )
        return null;
      const evaluation = await new EvaluationService(this.db).createRun(
        tx,
        job,
        attempt.candidate_version_id,
        session.suite_version_id,
        `recovery-${attempt.id}`,
      );
      await tx.query(
        "UPDATE repair_attempts SET evaluation_run_id=$2 WHERE id=$1",
        [attempt.id, evaluation.id],
      );
      await tx.query(
        "UPDATE workflow_jobs SET phase='checking existing regression suite',updated_at=now() WHERE id=$1",
        [job.id],
      );
      return evaluation.id;
    });
  }
  async decide(attemptId: string) {
    return this.db.transaction(async (tx) => {
      const old = await attemptById(tx, attemptId),
        s = (
          await tx.query("SELECT * FROM repair_sessions WHERE id=$1", [
            old.session_id,
          ])
        ).rows[0] as unknown as RepairSession;
      if (old.status !== "running") return { done: s.status !== "running" };
      const { job, session } = await this.active(tx, s.job_id),
        attempt = await attemptById(tx, attemptId);
      if (!attempt.rerun_id)
        throw new DomainError(
          409,
          "RERUN_REQUIRED",
          "Rerun the captured input before accepting a repair.",
        );
      const run = await runById(tx, attempt.rerun_id);
      if (
        !["completed", "failed", "needs_attention", "cancelled"].includes(
          run.status,
        )
      )
        throw new DomainError(
          409,
          "RERUN_PENDING",
          "Wait for the rerun to finish.",
        );
      const build = (
        await tx.query("SELECT build_result FROM repair_attempts WHERE id=$1", [
          attemptId,
        ])
      ).rows[0].build_result as { ok: boolean } | null;
      if (run.status === "completed" && !build?.ok)
        throw new DomainError(
          409,
          "BUILD_CHECK_REQUIRED",
          "A successful candidate build check is required before acceptance.",
        );
      let accepted = run.status === "completed";
      let regressionBlocker: string | null = null;
      let reason = accepted
        ? "Completed after repair — business results not yet verified. No locked regression suite is available."
        : run.failure_message || "The rerun did not complete.";
      if (accepted && session.suite_version_id) {
        if (!attempt.evaluation_run_id || !session.baseline_evaluation_id)
          throw new DomainError(
            409,
            "REGRESSION_REQUIRED",
            "A complete regression comparison is required.",
          );
        const evaluation = await evaluationById(tx, attempt.evaluation_run_id);
        const candidateResults = await resultsByEvaluation(tx, evaluation.id);
        const decision = regressionDecision(
          await resultsByEvaluation(tx, session.baseline_evaluation_id),
          candidateResults,
          await suiteCases(tx, session.suite_version_id),
        );
        accepted =
          evaluation.status === "completed" &&
          isDeepStrictEqual(
            evaluation.execution_configuration,
            session.execution_configuration,
          ) &&
          decision.accepted;
        if (!accepted)
          regressionBlocker = !isDeepStrictEqual(
            evaluation.execution_configuration,
            session.execution_configuration,
          )
            ? "Regression settings changed; no comparable acceptance decision is available."
            : repairBlocker(evaluation, candidateResults);
        reason = accepted
          ? `Completed after repair — business results not yet verified. ${decision.reason} One regression run does not establish repeated confirmation.`
          : regressionBlocker || decision.reason;
      }
      await tx.query(
        "UPDATE repair_attempts SET status=$2,decision_reason=$3,finished_at=now(),attempt_token=NULL WHERE id=$1",
        [attempt.id, accepted ? "accepted" : "rejected", reason],
      );
      const blocked =
        !!regressionBlocker ||
        (run.status !== "completed" &&
          run.failure_category !== "implementation");
      const done =
        accepted || blocked || attempt.attempt_number >= session.attempt_limit;
      await tx.query(
        "UPDATE repair_sessions SET baseline_version_id=$2,baseline_evaluation_id=$3,status=$4,stop_reason=$5,finished_at=$6,updated_at=now() WHERE id=$1",
        [
          session.id,
          accepted ? attempt.candidate_version_id : session.baseline_version_id,
          accepted ? attempt.evaluation_run_id : session.baseline_evaluation_id,
          accepted ? "recovered" : done ? "needs_attention" : "running",
          done ? reason : null,
          done ? new Date().toISOString() : null,
        ],
      );
      if (accepted)
        await tx.query(
          "INSERT INTO workflow_run_defaults(workflow_id,implementation_version_id,recovery_session_id) VALUES($1,$2,$3) ON CONFLICT(workflow_id) DO UPDATE SET implementation_version_id=excluded.implementation_version_id,recovery_session_id=excluded.recovery_session_id,updated_at=now()",
          [session.workflow_id, attempt.candidate_version_id, session.id],
        );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,progress=$4,finished_at=$5,updated_at=now() WHERE id=$1",
        [
          job.id,
          done ? "succeeded" : "running",
          accepted
            ? "recovered · business results unverified"
            : done
              ? "needs engineer attention"
              : "repair candidate rejected",
          {
            session_id: session.id,
            attempt: attempt.attempt_number,
            decision: reason,
            run_id: run.id,
          },
          done ? new Date().toISOString() : null,
        ],
      );
      return { done };
    });
  }
}
