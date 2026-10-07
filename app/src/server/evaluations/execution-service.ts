import { randomUUID } from "node:crypto";
import { workflow } from "../workflows/store";
import { DomainError } from "../../domain/canvas";
import type { CaseResult } from "../../domain/evaluation";
import {
  selectRoutes,
  type Json,
  type RuntimeError,
} from "../../domain/runtime";
import type { Project } from "../../domain/project";
import type { Database } from "../database";
import { VersionService } from "../engineering/version-service";
import { frozenSpec, planSteps } from "../engineering/plan-service";
import { jobById } from "../engineering/job-service";
import {
  invokeApprovedStep,
  invocationFailure,
  type StepAdapters,
} from "../runtime/invoke-step";
import { suiteCases } from "./suite-service";
import { EvaluationService, evaluationById } from "./evaluation-service";
export class EvaluationExecutionService {
  constructor(
    private db: Database,
    private versions = new VersionService(db),
  ) {}
  async build(
    id: string,
    validate: (project: Project, signal: AbortSignal) => Promise<unknown>,
    signal: AbortSignal,
  ) {
    const e = await evaluationById(this.db, id),
      job = await jobById(this.db, e.job_id);
    if (job.status !== "running")
      throw new DomainError(
        409,
        "EVALUATION_INACTIVE",
        "Evaluation no longer accepts work.",
      );
    const { project } = await this.versions.load(
      e.workflow_id,
      e.implementation_version_id,
    );
    await validate(project, signal);
  }
  async step(id: string, adapters: StepAdapters, signal: AbortSignal) {
    const result = (
      await this.db.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
        id,
      ])
    ).rows[0] as unknown as CaseResult;
    if (!result)
      throw new DomainError(404, "NOT_FOUND", "Case result not found.");
    if (result.status === "finished") return;
    const evaluation = await evaluationById(this.db, result.evaluation_run_id),
      job = await jobById(this.db, evaluation.job_id);
    if (job.status !== "running" || result.status !== "running")
      throw new DomainError(
        409,
        "EVALUATION_INACTIVE",
        "Evaluation no longer accepts work.",
      );
    const c = (await suiteCases(this.db, evaluation.suite_version_id)).find(
      (c) => c.id === result.case_id,
    )!;
    if (c.kind !== "step" || !c.node_id || !c.input_data)
      throw new DomainError(
        422,
        "INVALID_CASE",
        "Expected an isolated step case.",
      );
    const service = new EvaluationService(this.db);
    const token = await this.db.transaction(async (tx) => {
      await workflow(tx, result.workflow_id, true);
      const current = (
        await tx.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
          id,
        ])
      ).rows[0];
      const active = await jobById(tx, evaluation.job_id);
      if (current.status === "finished") return null;
      if (current.status !== "running" || active.status !== "running")
        throw new DomainError(
          409,
          "EVALUATION_INACTIVE",
          "Case no longer accepts invocations.",
        );
      if (Number(current.invocation_count) >= 2)
        throw new DomainError(
          422,
          "CASE_RETRY_LIMIT",
          "This case exhausted its infrastructure retry allowance.",
        );
      const next = randomUUID();
      await tx.query(
        "UPDATE evaluation_case_results SET attempt_token=$2,invocation_count=invocation_count+1 WHERE id=$1",
        [id, next],
      );
      return next;
    });
    if (!token) return;
    try {
      const { project } = await this.versions.load(
        result.workflow_id,
        evaluation.implementation_version_id,
      );
      const spec = await frozenSpec(this.db, result.workflow_id),
        node = spec.board.nodes.find((n) => n.id === c.node_id)!;
      const method = (await planSteps(this.db, job.plan_version_id)).find(
        (s) => s.node_id === c.node_id,
      )!.selected_method;
      const output = await invokeApprovedStep(
        project,
        c.node_id,
        method,
        c.input_data as Record<string, Json>,
        adapters,
        signal,
      );
      selectRoutes(
        node,
        spec.board.connections.filter((e) => e.source_node_id === node.id),
        output.matching_connection_ids,
      );
      signal.throwIfAborted();
      await service.recordCase(id, { actual: output.output }, token);
    } catch (error) {
      if (signal.aborted) throw error;
      await service.recordCase(id, { error: invocationFailure(error) }, token);
    }
  }
  async workflow(id: string) {
    const run = (
      await this.db.query(
        "SELECT * FROM workflow_runs WHERE evaluation_case_result_id=$1",
        [id],
      )
    ).rows[0];
    if (!run)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "The evaluated workflow run is missing.",
      );
    const service = new EvaluationService(this.db);
    if (run.status === "completed") {
      const output = (
        await this.db.query(
          "SELECT output_data FROM step_executions WHERE run_id=$1 AND id=$2 AND status='completed'",
          [run.id, run.result_step_id],
        )
      ).rows[0];
      if (!output)
        throw new DomainError(
          422,
          "MISSING_OUTPUT",
          "The completed run has no result.",
        );
      await service.recordCase(id, { actual: output.output_data as Json });
    } else
      await service.recordCase(id, {
        error: {
          code: String(run.failure_code || "EXECUTION_INCOMPLETE"),
          message: String(
            run.failure_message || `Workflow execution is ${run.status}.`,
          ),
          category: (run.failure_category ||
            "unknown") as RuntimeError["category"],
        },
      });
  }
}
