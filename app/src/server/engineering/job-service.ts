import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type {
  WorkflowJob,
  ImplementationVersion,
  generateInput,
} from "../../domain/engineering";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
import { planById, planSteps, specForPlan } from "./plan-service";
const terminal = ["succeeded", "failed", "cancelled"];
export async function jobById(tx: Queryable, id: string): Promise<WorkflowJob> {
  const row = (await tx.query("SELECT * FROM workflow_jobs WHERE id=$1", [id]))
    .rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Operation not found.");
  return row as unknown as WorkflowJob;
}
export class JobService {
  constructor(private db: Database) {}
  async startGeneration(
    workflowId: string,
    data: z.infer<typeof generateInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const source = {
        plan_version_id: data.plan_version_id,
        input_version_id: data.input_version_id,
      };
      const existing = (
        await tx.query(
          "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
          [workflowId, data.request_key],
        )
      ).rows[0];
      if (existing) {
        if (
          existing.kind !== "generation" ||
          !isDeepStrictEqual(existing.source_request, source)
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request key belongs to different operation inputs.",
          );
        return existing as unknown as WorkflowJob;
      }
      const plan = await planById(tx, workflowId, data.plan_version_id);
      if (plan.state !== "approved")
        throw new DomainError(
          409,
          "PLAN_NOT_APPROVED",
          "Approve the implementation plan before generation.",
        );
      if (
        data.input_version_id &&
        !(
          await tx.query(
            "SELECT id FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
            [workflowId, data.input_version_id],
          )
        ).rows.length
      )
        throw new DomainError(
          422,
          "INVALID_SEED",
          "The starting code must belong to this workflow.",
        );
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
          "Wait for or cancel the active operation before starting another.",
        );
      const id = randomUUID();
      return (
        await tx.query(
          `INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,executor_ref,deadline_at)
    VALUES($1,$2,'generation',$3,$4,$5,$6,$7,now()+interval '45 minutes') RETURNING *`,
          [
            id,
            workflowId,
            data.request_key,
            source,
            plan.id,
            data.input_version_id,
            `job-${id}`,
          ],
        )
      ).rows[0] as unknown as WorkflowJob;
    });
  }
  async prepareGeneration(id: string) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, id);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, id);
      if (terminal.includes(job.status)) return null;
      if (job.status === "cancel_requested")
        throw new DomainError(
          409,
          "JOB_CANCELLED",
          "The operation was cancelled.",
        );
      if (new Date(job.deadline_at).getTime() < Date.now())
        throw new DomainError(
          409,
          "JOB_EXPIRED",
          "Generation exceeded its time limit.",
        );
      if (job.kind !== "generation")
        throw new DomainError(
          422,
          "INVALID_JOB",
          "This operation is not generation.",
        );
      const plan = await planById(tx, job.workflow_id, job.plan_version_id);
      if (plan.state !== "approved")
        throw new DomainError(
          409,
          "PLAN_NOT_APPROVED",
          "The operation requires its approved plan.",
        );
      const spec = await specForPlan(tx, job.workflow_id, job.plan_version_id),
        steps = await planSteps(tx, plan.id);
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='preparing',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [id],
      );
      return { job: await jobById(tx, id), plan, steps, spec };
    });
  }
  async progress(id: string, phase: string, progress: Record<string, unknown>) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, id);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, id);
      if (job.status !== "running")
        throw new DomainError(
          409,
          "JOB_INACTIVE",
          "The operation can no longer publish progress.",
        );
      await tx.query(
        "UPDATE workflow_jobs SET phase=$2,progress=$3,updated_at=now() WHERE id=$1",
        [id, phase, progress],
      );
    });
  }
  async requestCancel(workflowId: string, id: string) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const job = await jobById(tx, id);
      if (job.workflow_id !== workflowId)
        throw new DomainError(
          404,
          "NOT_FOUND",
          "Operation not found on this workflow.",
        );
      if (terminal.includes(job.status) || job.status === "cancel_requested")
        return job;
      await tx.query(
        "UPDATE workflow_jobs SET status='cancel_requested',phase='stopping',updated_at=now() WHERE id=$1",
        [id],
      );
      return jobById(tx, id);
    });
  }
  async finish(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    error?: { code: string; message: string },
  ) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, id);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, id);
      if (terminal.includes(job.status)) return job;
      const outcome = job.status === "cancel_requested" ? "cancelled" : status;
      if (
        outcome === "succeeded" &&
        job.kind === "generation" &&
        !(
          await tx.query(
            "SELECT id FROM implementation_versions WHERE created_by_job_id=$1",
            [id],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "NO_GENERATED_PROJECT",
          "Generation cannot succeed without a published project version.",
        );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$2,error_code=$3,error_message=$4,finished_at=now(),updated_at=now() WHERE id=$1",
        [id, outcome, error?.code || null, error?.message || null],
      );
      return jobById(tx, id);
    });
  }
  async publishVersion(
    id: string,
    data: {
      artifactId: string;
      entrypoint: string;
      nodeFileMap: Record<string, string>;
      generationKey: string;
    },
  ) {
    return this.db.transaction(async (tx) => {
      let job = await jobById(tx, id);
      await workflow(tx, job.workflow_id, true);
      job = await jobById(tx, id);
      const previous = (
        await tx.query(
          "SELECT * FROM implementation_versions WHERE created_by_job_id=$1 AND generation_key=$2",
          [id, data.generationKey],
        )
      ).rows[0];
      if (previous) return previous as unknown as ImplementationVersion;
      if (job.status !== "running")
        throw new DomainError(
          409,
          "JOB_INACTIVE",
          "The operation ended before this version could be published.",
        );
      if (new Date(job.deadline_at).getTime() < Date.now())
        throw new DomainError(
          409,
          "JOB_EXPIRED",
          "The generation time limit was reached.",
        );
      const artifact = (
        await tx.query(
          "SELECT * FROM artifacts WHERE id=$1 AND workflow_id=$2 AND state='ready' AND kind='generated_project'",
          [data.artifactId, job.workflow_id],
        )
      ).rows[0];
      if (!artifact)
        throw new DomainError(
          422,
          "INVALID_ARTIFACT",
          "Only a ready project artifact from this workflow can be published.",
        );
      const steps = await planSteps(tx, job.plan_version_id),
        ids = Object.keys(data.nodeFileMap);
      if (
        ids.length !== steps.length ||
        steps.some((s) => !ids.includes(s.node_id))
      )
        throw new DomainError(
          422,
          "INCOMPLETE_PROJECT",
          "The generated project must map every approved step.",
        );
      const result = (
        await tx.query(
          `INSERT INTO implementation_versions(workflow_id,plan_version_id,version_number,parent_version_id,created_by_job_id,generation_key,artifact_id,entrypoint,node_file_map)
    VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM implementation_versions WHERE workflow_id=$1),$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            job.workflow_id,
            job.plan_version_id,
            job.input_version_id,
            id,
            data.generationKey,
            data.artifactId,
            data.entrypoint,
            data.nodeFileMap,
          ],
        )
      ).rows[0];
      return result as unknown as ImplementationVersion;
    });
  }
}
