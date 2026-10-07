import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/canvas";
import type {
  WorkflowJob,
  ImplementationVersion,
} from "../../domain/engineering";
import {
  DEMO_LIMITS,
  type RuntimeProjection,
  type RuntimeError,
  type startRunInput,
} from "../../domain/runtime";
import type { Database } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { frozenSpec, planSteps } from "../engineering/plan-service";
import { finishedRuns, runById, runRecord } from "./store";

export class RunService {
  constructor(private db: Database) {}
  async start(workflowId: string, data: z.infer<typeof startRunInput>) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const source = {
        implementation_version_id: data.implementation_version_id,
        input_bundle_id: data.input_bundle_id,
        rerun_of_id: data.rerun_of_id,
      };
      const existing = (
        await tx.query(
          "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
          [workflowId, data.request_key],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.kind !== "execution" ||
          !isDeepStrictEqual(existing.source_request, source)
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request belongs to different run inputs.",
          );
        return {
          job: existing as unknown as WorkflowJob,
          run: runRecord(
            (
              await tx.query(
                "SELECT * FROM workflow_runs WHERE job_id=$1 AND kind='manual'",
                [existing.id],
              )
            ).rows[0],
          ),
        };
      }
      const version = (
        await tx.query(
          "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
          [workflowId, data.implementation_version_id],
        )
      ).rows[0] as unknown as ImplementationVersion;
      if (
        !version ||
        !(
          await tx.query(
            "SELECT id FROM input_bundles WHERE workflow_id=$1 AND id=$2",
            [workflowId, data.input_bundle_id],
          )
        ).rows.length
      )
        throw new DomainError(
          422,
          "INVALID_INPUT",
          "Code and captured inputs must belong to this workflow.",
        );
      if (data.rerun_of_id) {
        const old = await runById(tx, data.rerun_of_id);
        if (
          old.workflow_id !== workflowId ||
          old.implementation_version_id !== version.id ||
          old.input_bundle_id !== data.input_bundle_id ||
          !finishedRuns.includes(old.status)
        )
          throw new DomainError(
            422,
            "INVALID_RETRY",
            "A retry uses the finished run's exact code version and input bundle.",
          );
      }
      if (
        (
          await tx.query(
            "SELECT id FROM workflow_jobs WHERE workflow_id=$1 AND status IN ('queued','running','waiting_for_human','cancel_requested')",
            [workflowId],
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
          `INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,executor_ref,deadline_at) VALUES($1,$2,'execution',$3,$4,$5,$6,$7,now()+interval '1 day') RETURNING *`,
          [
            id,
            workflowId,
            data.request_key,
            source,
            version.plan_version_id,
            version.id,
            `job-${id}`,
          ],
        )
      ).rows[0] as unknown as WorkflowJob;
      const run = runRecord(
        (
          await tx.query(
            `INSERT INTO workflow_runs(workflow_id,job_id,implementation_version_id,input_bundle_id,rerun_of_id,limits) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
            [
              workflowId,
              id,
              version.id,
              data.input_bundle_id,
              data.rerun_of_id,
              DEMO_LIMITS,
            ],
          )
        ).rows[0],
      );
      return { job, run };
    });
  }
  async prepare(jobId: string) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, jobId);
      if (job.kind !== "execution")
        throw new DomainError(
          422,
          "INVALID_JOB",
          "Expected an execution operation.",
        );
      if (["succeeded", "failed", "cancelled"].includes(job.status))
        return null;
      if (job.status === "cancel_requested")
        throw new DomainError(
          409,
          "JOB_CANCELLED",
          "Run cancelled before starting.",
        );
      const row = (
        await tx.query(
          "SELECT * FROM workflow_runs WHERE job_id=$1 AND kind='manual'",
          [jobId],
        )
      ).rows[0];
      const run = runRecord(row);
      const spec = await frozenSpec(tx, job.workflow_id),
        steps = await planSteps(tx, job.plan_version_id);
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='executing',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [jobId],
      );
      await tx.query(
        "UPDATE workflow_runs SET status='running',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [run.id],
      );
      return {
        run,
        definition: {
          board: spec.board,
          methods: Object.fromEntries(
            steps.map((s) => [s.node_id, s.selected_method]),
          ),
          limits: run.limits,
        },
      };
    });
  }
  async project(id: string, p: RuntimeProjection) {
    await this.db.transaction(async (tx) => {
      const run = await runById(tx, id);
      await workflow(tx, run.workflow_id, true);
      if (finishedRuns.includes((await runById(tx, id)).status)) return;
      const job = await jobById(tx, run.job_id);
      if (!["running", "waiting_for_human"].includes(job.status)) return;
      const updated = await tx.query(
        `UPDATE workflow_runs SET status=$2,progress_sequence=$3,active_elapsed_ms=$4,active_since=$5,updated_at=now() WHERE id=$1 AND progress_sequence<$3 RETURNING id`,
        [id, p.status, p.sequence, p.active_elapsed_ms, p.active_since],
      );
      if (updated.rows.length)
        await tx.query(
          "UPDATE workflow_jobs SET status=$2,phase=$3,progress=$4,updated_at=now() WHERE id=$1",
          [
            run.job_id,
            p.status,
            p.status === "waiting_for_human"
              ? "waiting for a response"
              : "executing",
            { run_id: id, step_count: p.scheduled_step_attempts },
          ],
        );
    });
  }
  async finish(
    jobId: string,
    result: {
      status: "completed" | "failed" | "needs_attention" | "cancelled";
      error?: RuntimeError | null;
      result_step_id?: string | null;
      projection?: RuntimeProjection;
    },
  ) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, jobId);
      const row = (
        await tx.query(
          "SELECT * FROM workflow_runs WHERE job_id=$1 AND kind='manual'",
          [jobId],
        )
      ).rows[0];
      if (!row || finishedRuns.includes(String(row.status))) return;
      const status =
        job.status === "cancel_requested" ? "cancelled" : result.status;
      if (
        status === "completed" &&
        (!result.result_step_id ||
          !(
            await tx.query(
              "SELECT id FROM step_executions WHERE run_id=$1 AND id=$2 AND status='completed'",
              [row.id, result.result_step_id],
            )
          ).rows.length)
      )
        throw new DomainError(
          422,
          "NO_OUTCOME",
          "A completed run needs its completed outcome step.",
        );
      if (status === "completed") {
        const nodeId = (
          await tx.query("SELECT node_id FROM step_executions WHERE id=$1", [
            result.result_step_id,
          ])
        ).rows[0].node_id;
        const spec = await frozenSpec(tx, job.workflow_id);
        if (
          !spec.board.nodes.some((n) => n.id === nodeId && n.type === "outcome")
        )
          throw new DomainError(
            422,
            "NO_OUTCOME",
            "Only an Outcome block can complete the run.",
          );
      }
      await tx.query(
        "UPDATE human_requests SET status='cancelled',cancelled_at=now() WHERE run_id=$1 AND status='pending'",
        [row.id],
      );
      await tx.query(
        "UPDATE step_executions SET status='cancelled',finished_at=now(),updated_at=now(),attempt_token=NULL WHERE run_id=$1 AND status IN ('running','waiting_for_human')",
        [row.id],
      );
      const elapsed =
        result.projection?.active_elapsed_ms ??
        Number(row.active_elapsed_ms) +
          (row.active_since
            ? Math.max(
                0,
                Date.now() - new Date(String(row.active_since)).getTime(),
              )
            : 0);
      await tx.query(
        `UPDATE workflow_runs SET status=$2,result_step_id=$3,failure_category=$4,failure_code=$5,failure_message=$6,active_elapsed_ms=$7,active_since=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,
        [
          row.id,
          status,
          status === "completed" ? result.result_step_id : null,
          result.error?.category || null,
          result.error?.code || null,
          result.error?.message || null,
          elapsed,
        ],
      );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,error_code=$4,error_message=$5,finished_at=now(),updated_at=now() WHERE id=$1",
        [
          jobId,
          status === "completed"
            ? "succeeded"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
          status,
          result.error?.code || null,
          result.error?.message || null,
        ],
      );
    });
  }
  async state(workflowId: string, runId?: string) {
    await workflow(this.db, workflowId);
    const runs = (
      await this.db.query(
        `SELECT * FROM workflow_runs WHERE workflow_id=$1 ${runId ? "AND id=$2" : ""} ORDER BY created_at DESC,id DESC LIMIT 20`,
        runId ? [workflowId, runId] : [workflowId],
      )
    ).rows.map(runRecord);
    if (runId && !runs.length)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Run not found on this workflow.",
      );
    const selected = runs[0];
    return {
      runs,
      steps: selected
        ? (
            await this.db.query(
              "SELECT * FROM step_executions WHERE run_id=$1 ORDER BY occurrence_number",
              [selected.id],
            )
          ).rows
        : [],
      human_requests: selected
        ? (
            await this.db.query(
              "SELECT * FROM human_requests WHERE run_id=$1 ORDER BY created_at,id",
              [selected.id],
            )
          ).rows
        : [],
    };
  }
}
