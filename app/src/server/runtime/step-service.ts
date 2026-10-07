import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/canvas";
import { stepResult, type Project } from "../../domain/project";
import type {
  HumanRequest,
  ScheduleStep,
  StepReply,
  Json,
  RuntimeError,
} from "../../domain/runtime";
import { selectRoutes } from "../../domain/runtime";
import type { Database } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { frozenSpec, planSteps } from "../engineering/plan-service";
import { VersionService } from "../engineering/version-service";
import { finishedRuns, runById, stepById } from "./store";

export interface StepAdapters {
  invoke(
    project: Project,
    nodeId: string,
    context: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<unknown>;
  reason(instructions: string, data: Json, signal: AbortSignal): Promise<Json>;
}
export class StepService {
  constructor(
    private db: Database,
    private versions = new VersionService(db),
  ) {}
  private async prepare(data: ScheduleStep, resume: boolean) {
    return this.db.transaction(async (tx) => {
      let run = await runById(tx, data.run_id);
      await workflow(tx, run.workflow_id, true);
      run = await runById(tx, data.run_id);
      const job = await jobById(tx, run.job_id);
      if (
        finishedRuns.includes(run.status) ||
        !["running", "waiting_for_human"].includes(job.status)
      )
        throw new DomainError(
          409,
          "RUN_INACTIVE",
          "Run no longer accepts execution results.",
        );
      const spec = await frozenSpec(tx, run.workflow_id),
        node = spec.board.nodes.find((n) => n.id === data.node_id);
      const method = (await planSteps(tx, job.plan_version_id)).find(
        (s) => s.node_id === data.node_id,
      )?.selected_method;
      if (!node || !method)
        throw new DomainError(
          422,
          "INVALID_NODE",
          "This step is absent from the approved frozen plan.",
        );
      let prior = (
        await tx.query(
          "SELECT * FROM step_executions WHERE run_id=$1 AND scheduling_key=$2",
          [run.id, data.scheduling_key],
        )
      ).rows[0];
      if (
        prior &&
        (prior.node_id !== data.node_id ||
          Number(prior.occurrence_number) !== data.occurrence_number ||
          Number(prior.node_visit_number) !== data.node_visit_number ||
          prior.branch_ref !== data.branch_ref ||
          !isDeepStrictEqual(prior.input_step_refs, data.input_step_refs))
      )
        throw new DomainError(
          409,
          "SCHEDULE_REUSED",
          "A scheduling key cannot be reused for another visit.",
        );
      if (!prior) {
        if (resume)
          throw new DomainError(
            422,
            "NO_HUMAN_VISIT",
            "Cannot resume a visit that does not exist.",
          );
        if (run.scheduled_step_attempts >= run.limits.step_attempts)
          throw new DomainError(
            422,
            "RUN_LIMIT",
            "The run reached its fixed step limit.",
          );
        for (const [nodeId, stepId] of Object.entries(data.input_step_refs)) {
          const source = (
            await tx.query(
              "SELECT id FROM step_executions WHERE run_id=$1 AND id=$2 AND node_id=$3 AND status='completed'",
              [run.id, stepId, nodeId],
            )
          ).rows[0];
          if (!source)
            throw new DomainError(
              422,
              "INVALID_STEP_INPUT",
              "Step input references must identify completed visits in this run.",
            );
        }
        prior = (
          await tx.query(
            `INSERT INTO step_executions(workflow_id,run_id,node_id,occurrence_number,node_visit_number,scheduling_key,branch_ref,input_step_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
              run.workflow_id,
              run.id,
              node.id,
              data.occurrence_number,
              data.node_visit_number,
              data.scheduling_key,
              data.branch_ref,
              data.input_step_refs,
            ],
          )
        ).rows[0];
        await tx.query(
          "UPDATE workflow_runs SET scheduled_step_attempts=scheduled_step_attempts+1 WHERE id=$1",
          [run.id],
        );
      }
      const stepId = String(prior.id);
      if (prior.status === "completed")
        return {
          reply: {
            kind: "complete",
            step_id: stepId,
            connection_ids: prior.selected_connection_ids as string[],
          } as StepReply,
        };
      if (prior.status === "failed")
        return {
          reply: {
            kind: "error",
            step_id: stepId,
            error: {
              code: String(prior.failure_code),
              message: String(prior.failure_message),
              category: String(prior.failure_category),
            },
          } as StepReply,
        };
      if (prior.status === "cancelled")
        throw new DomainError(409, "RUN_INACTIVE", "This visit was cancelled.");
      let human: HumanRequest | null = null;
      if (method === "human") {
        let h = (
          await tx.query(
            "SELECT * FROM human_requests WHERE step_execution_id=$1",
            [stepId],
          )
        ).rows[0];
        if (!h)
          h = (
            await tx.query(
              "INSERT INTO human_requests(workflow_id,run_id,step_execution_id,response_type,prompt) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [
                run.workflow_id,
                run.id,
                stepId,
                node.type === "human_approval" ? "approval" : "text",
                node.instructions || node.title,
              ],
            )
          ).rows[0];
        human = h as unknown as HumanRequest;
        if (human.status !== "answered") {
          await tx.query(
            "UPDATE step_executions SET status='waiting_for_human' WHERE id=$1",
            [stepId],
          );
          return {
            reply: {
              kind: "human",
              step_id: stepId,
              request_id: human.id,
            } as StepReply,
          };
        }
      }
      const count = Number(prior.invocation_count);
      if (count >= 2)
        throw new DomainError(
          422,
          "STEP_RETRY_LIMIT",
          "This visit exhausted its infrastructure retry allowance.",
        );
      if (count > 0) {
        const current = await runById(tx, run.id);
        if (current.scheduled_step_attempts >= current.limits.step_attempts)
          throw new DomainError(
            422,
            "RUN_LIMIT",
            "The run reached its fixed step limit.",
          );
        await tx.query(
          "UPDATE workflow_runs SET scheduled_step_attempts=scheduled_step_attempts+1 WHERE id=$1",
          [run.id],
        );
      }
      const token = randomUUID();
      await tx.query(
        "UPDATE step_executions SET status='running',attempt_token=$2,invocation_count=invocation_count+1,updated_at=now() WHERE id=$1",
        [stepId, token],
      );
      const input = (
        await tx.query("SELECT manifest FROM input_bundles WHERE id=$1", [
          run.input_bundle_id,
        ])
      ).rows[0].manifest as { input: Json };
      const outputs: Record<string, Json> = {};
      if (Object.keys(data.input_step_refs).length) {
        const rows = (
          await tx.query(
            "SELECT id,node_id,output_data FROM step_executions WHERE run_id=$1 AND id=ANY($2::uuid[])",
            [run.id, Object.values(data.input_step_refs)],
          )
        ).rows;
        for (const row of rows)
          outputs[String(row.node_id)] = row.output_data as Json;
      }
      const context: Record<string, Json> = {
        input: input.input,
        steps: outputs,
      };
      if (human?.response) context.human_response = human.response;
      return { run, stepId, token, node, method, board: spec.board, context };
    });
  }
  async execute(
    data: ScheduleStep,
    adapters: StepAdapters,
    signal: AbortSignal,
    resume = false,
  ): Promise<StepReply> {
    const prepared = await this.prepare(data, resume);
    if (prepared.reply) return prepared.reply;
    const { run, stepId, token, node, method, board, context } = prepared;
    try {
      const { project } = await this.versions.load(
        run.workflow_id,
        run.implementation_version_id,
      );
      signal.throwIfAborted();
      let result = stepResult.parse(
        await adapters.invoke(project, node.id, context, signal),
      );
      if (result.kind === "reason") {
        if (method !== "agent")
          throw new DomainError(
            422,
            "METHOD_VIOLATION",
            "Only an approved Agent step can request model reasoning.",
          );
        const tool_result = await adapters.reason(
          result.instructions,
          result.data,
          signal,
        );
        result = stepResult.parse(
          await adapters.invoke(
            project,
            node.id,
            { ...context, tool_result },
            signal,
          ),
        );
      }
      if (result.kind !== "complete")
        throw new DomainError(
          422,
          "METHOD_VIOLATION",
          "The step must complete after its single approved interaction.",
        );
      if (Buffer.byteLength(JSON.stringify(result)) > 128_000)
        throw new DomainError(
          422,
          "STEP_OUTPUT_TOO_LARGE",
          "Keep step output under 128 KB; use document artifacts for large payloads.",
        );
      const routes = selectRoutes(
        node,
        board.connections.filter((e) => e.source_node_id === node.id),
        result.matching_connection_ids,
      ).map((e) => e.id);
      signal.throwIfAborted();
      return this.publish(data.run_id, stepId, token, { result, routes });
    } catch (error) {
      if (signal.aborted) throw error;
      const known = error instanceof DomainError;
      const message =
        error instanceof Error ? error.message : "Step invocation failed.";
      const implementationCodes = [
        "STEP_CRASH",
        "METHOD_VIOLATION",
        "STEP_OUTPUT_TOO_LARGE",
        "STEP_INPUT_TOO_LARGE",
        "AGENT_CONTEXT_TOO_LARGE",
      ];
      const routeCode =
        /^(INVALID_ROUTES|AMBIGUOUS_ROUTE|NO_MATCHING_ROUTE|INVALID_OUTCOME):/.exec(
          message,
        )?.[1];
      const category =
        routeCode ||
        (known && implementationCodes.includes(error.code)) ||
        (error instanceof Error && error.name === "ZodError")
          ? "implementation"
          : known &&
              ["SANDBOX_UNAVAILABLE", "MODEL_UNAVAILABLE"].includes(error.code)
            ? "infrastructure"
            : "unknown";
      const failure: RuntimeError = {
        code: known ? error.code : routeCode || "STEP_EXECUTION_FAILED",
        message: message.slice(0, 2000),
        category,
      };
      return this.publish(data.run_id, stepId, token, { error: failure });
    }
  }
  private async publish(
    runId: string,
    stepId: string,
    token: string,
    data: {
      result?: Extract<z.infer<typeof stepResult>, { kind: "complete" }>;
      routes?: string[];
      error?: RuntimeError;
    },
  ): Promise<StepReply> {
    return this.db.transaction(async (tx) => {
      let run = await runById(tx, runId);
      await workflow(tx, run.workflow_id, true);
      run = await runById(tx, runId);
      const job = await jobById(tx, run.job_id),
        step = await stepById(tx, stepId);
      const current = (
        await tx.query(
          "SELECT attempt_token FROM step_executions WHERE id=$1",
          [stepId],
        )
      ).rows[0];
      if (
        finishedRuns.includes(run.status) ||
        !["running", "waiting_for_human"].includes(job.status) ||
        step.status !== "running" ||
        current.attempt_token !== token
      )
        throw new DomainError(
          409,
          "STALE_STEP_RESULT",
          "This invocation can no longer publish its result.",
        );
      await tx.query(
        `UPDATE step_executions SET status=$2,output_data=$3,selected_connection_ids=$4,failure_category=$5,failure_code=$6,failure_message=$7,attempt_token=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,
        [
          stepId,
          data.error ? "failed" : "completed",
          data.result?.output === undefined
            ? null
            : JSON.stringify(data.result.output),
          JSON.stringify(data.routes || []),
          data.error?.category || null,
          data.error?.code || null,
          data.error?.message || null,
        ],
      );
      return data.error
        ? { kind: "error", step_id: stepId, error: data.error }
        : { kind: "complete", step_id: stepId, connection_ids: data.routes! };
    });
  }
}
