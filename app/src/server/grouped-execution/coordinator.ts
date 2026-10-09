import { randomUUID } from "node:crypto";
import type { Database } from "../database";
import { DomainError } from "../../domain/errors";
import { GROUP_LIMITS } from "../../domain/grouped-execution";
import type { Json } from "../../domain/runtime";
import { workflow } from "../workflows/store";
import { JobService } from "../engineering/job-service";
import { specForPlan } from "../engineering/plan-service";
import { BundleService } from "../runtime/bundle-service";
import { RunService } from "../runtime/run-service";
import { RepairService } from "../repairs/service";
import { GroupedExecutionService } from "./service";
import {
  groupedExecutionState,
  activeStatuses,
  type GroupedState,
} from "./state";
import { activeGroupParent } from "./ownership";
export interface GroupedTick {
  done: boolean;
  capture?: boolean;
  start: { id: string; kind: "execution" | "repair" }[];
  cancel: string[];
}
const idle = (): GroupedTick => ({ done: false, start: [], cancel: [] });
export class GroupedCoordinator {
  constructor(private db: Database) {}
  async advance(id: string): Promise<GroupedTick> {
    let state = await groupedExecutionState(this.db, id);
    if (!activeStatuses.includes(state.job.status))
      return { ...idle(), done: true };
    if (state.job.status === "cancel_requested")
      throw new DomainError(
        409,
        "GROUP_CANCELLED",
        "The selected-email operation was cancelled.",
      );
    await this.clock(state);
    const service = new GroupedExecutionService(this.db);
    if (!state.record.input_bundle_id) return { ...idle(), capture: true };
    if (!state.grouping) {
      await service.startGrouping(id, randomUUID());
      state = await groupedExecutionState(this.db, id);
    }
    if (
      state.grouping?.completed &&
      state.decision?.source_run_id !== state.grouping.run.id
    ) {
      await service.publishGrouping(id, state.grouping.run.id);
      state = await groupedExecutionState(this.db, id);
    }
    const currentQuestions = state.questions.filter(
      (q) => q.decision_id === state.decision?.id,
    );
    if (
      state.grouping?.terminal &&
      state.grouping.completed &&
      currentQuestions.length &&
      currentQuestions.every((q) => q.status === "answered") &&
      state.decision!.sequence <= GROUP_LIMITS.clarification_rounds
    ) {
      await service.startGrouping(id, randomUUID());
      state = await groupedExecutionState(this.db, id);
    }
    // Removed or materially changed groups retain history but their old workers
    // cannot continue publishing against a superseded source assignment.
    const current = new Set(state.children.map((c) => c.job_id));
    const obsoleteOriginals = new Set(
      state.child_history
        .filter((c) => !current.has(String(c.job_id)))
        .map((c) => String(c.job_id)),
    );
    const cancel = state.executions
      .filter((e) => obsoleteOriginals.has(e.source_job_id) && !e.terminal)
      .map((e) => e.active_job.id);
    for (const jobId of cancel)
      await new JobService(this.db).requestCancel(state.job.workflow_id, jobId);
    const groupingBusy = !!state.grouping && !state.grouping.terminal;
    const unresolved = currentQuestions.some((q) => q.status === "open");
    const childrenBusy = state.children.some((c) => !c.execution.terminal);
    if (!groupingBusy && !unresolved && !childrenBusy && !cancel.length) {
      if (state.decision && !state.aggregate) {
        await this.startAggregate(state);
        state = await groupedExecutionState(this.db, id);
      } else if (!state.decision || state.aggregate?.terminal) {
        await this.finish(state);
        return { ...idle(), done: true };
      }
    }
    const allowed = new Set([
      ...state.children.map((c) => c.execution.active_job.id),
      ...(state.grouping ? [state.grouping.active_job.id] : []),
      ...(state.aggregate ? [state.aggregate.active_job.id] : []),
    ]);
    const running = state.jobs.filter(
      (j) => allowed.has(j.id) && j.status === "running",
    ).length;
    const slots = Math.max(0, GROUP_LIMITS.concurrent_children - running);
    const start = state.jobs
      .filter(
        (j) =>
          allowed.has(j.id) && j.status === "queued" && !cancel.includes(j.id),
      )
      .slice(0, slots)
      .map((j) => ({ id: j.id, kind: j.kind as "execution" | "repair" }));
    await this.db.transaction(async (tx) => {
      await workflow(tx, state.job.workflow_id, true);
      await activeGroupParent(
        tx,
        id,
        state.job.workflow_id,
        state.job.plan_version_id,
      );
      const waiting = !running && !start.length;
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,progress=$4,updated_at=now() WHERE id=$1",
        [
          id,
          waiting ? "waiting_for_human" : "running",
          state.aggregate
            ? "combining group results"
            : groupingBusy
              ? "grouping selected sources"
              : waiting
                ? "waiting for clarification"
                : "processing groups",
          {
            group_count: state.children.length,
            completed_groups: state.completed_groups,
            failed_groups: state.failed_groups,
            coverage: state.coverage,
            spent_or_reserved_usd: state.spent_or_reserved_usd,
          },
        ],
      );
    });
    return { done: false, start, cancel };
  }
  private async clock(state: GroupedState) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, state.job.workflow_id, true);
      const parent = await activeGroupParent(
        tx,
        state.job.id,
        state.job.workflow_id,
        state.job.plan_version_id,
      );
      const record = (
        await tx.query("SELECT * FROM grouped_executions WHERE job_id=$1", [
          parent.id,
        ])
      ).rows[0];
      const elapsed =
        Number(record.active_elapsed_ms) +
        (record.active_since
          ? Math.max(
              0,
              Date.now() - new Date(String(record.active_since)).getTime(),
            )
          : 0);
      if (elapsed >= Number((record.limits as { active_ms: number }).active_ms))
        throw new DomainError(
          422,
          "GROUP_TIME_LIMIT",
          "The selected-email operation reached its shared active-time limit.",
        );
      const working =
        !record.input_bundle_id ||
        state.jobs.some((j) => j.status === "running" || j.status === "queued");
      await tx.query(
        "UPDATE grouped_executions SET active_elapsed_ms=$2,active_since=$3 WHERE job_id=$1",
        [parent.id, elapsed, working ? new Date().toISOString() : null],
      );
    });
  }
  private async startAggregate(state: GroupedState) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, state.job.workflow_id, true);
      await activeGroupParent(
        tx,
        state.job.id,
        state.job.workflow_id,
        state.job.plan_version_id,
      );
      if (
        (
          await tx.query(
            "SELECT r.id FROM workflow_runs r JOIN workflow_jobs j ON j.id=r.job_id WHERE j.parent_job_id=$1 AND r.execution_mode='aggregate'",
            [state.job.id],
          )
        ).rows.length
      )
        return;
      const spec = await specForPlan(
          tx,
          state.job.workflow_id,
          state.job.plan_version_id,
        ),
        outcomes = spec.board.nodes.filter((n) => n.type === "outcome");
      const outcome = state.job.source_request.aggregation_node_id
        ? outcomes.find(
            (n) => n.id === state.job.source_request.aggregation_node_id,
          )
        : outcomes.length === 1
          ? outcomes[0]
          : undefined;
      if (!outcome)
        throw new DomainError(
          422,
          "AGGREGATION_OUTCOME_REQUIRED",
          "Choose an approved Outcome block for the combined report.",
        );
      const input = {
        grouping: state.decision!.result,
        coverage: state.coverage,
        groups: state.children.map((c) => ({
          key: c.group_key,
          label: c.label,
          source_run_id: c.execution.source_run_id,
          run_id: c.execution.run.id,
          implementation_version_id: c.execution.run.implementation_version_id,
          input_bundle_id: c.input_bundle_id,
          status: c.execution.completed
            ? "completed"
            : c.execution.terminal
              ? "needs_attention"
              : "pending",
          output: c.execution.completed ? c.execution.output : null,
          error: c.execution.run.failure_message,
          recovery: c.execution.recovery,
        })),
        business_results_verified: false,
      };
      const capture = (
        await tx.query(
          "SELECT b.source_kind FROM grouped_executions g JOIN input_bundles b ON b.id=g.input_bundle_id WHERE g.job_id=$1",
          [state.job.id],
        )
      ).rows[0];
      const bundle = await new BundleService(this.db).createInTransaction(
        tx,
        state.job.workflow_id,
        {
          source_kind: capture.source_kind as "gmail" | "fixture",
          shipment_reference: null,
          manifest: { input: input as Json, message_ids: [], artifacts: [] },
        },
      );
      await new RunService(this.db).startInTransaction(
        tx,
        state.job.workflow_id,
        {
          request_key: randomUUID(),
          implementation_version_id: state.job.input_version_id!,
          input_bundle_id: String(bundle.id),
          rerun_of_id: null,
        },
        {
          parent_job_id: state.job.id,
          execution_mode: "aggregate",
          phase_node_id: outcome.id,
        },
      );
    });
  }
  private async finish(state: GroupedState) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, state.job.workflow_id, true);
      await activeGroupParent(
        tx,
        state.job.id,
        state.job.workflow_id,
        state.job.plan_version_id,
      );
      const complete =
        !!state.coverage?.complete &&
        state.children.every((c) => c.execution.completed) &&
        !!state.aggregate?.completed;
      await tx.query(
        "UPDATE grouped_executions SET result_run_id=$2,active_elapsed_ms=active_elapsed_ms+CASE WHEN active_since IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM (now()-active_since))*1000)::bigint END,active_since=NULL WHERE job_id=$1",
        [
          state.job.id,
          state.aggregate?.completed ? state.aggregate.run.id : null,
        ],
      );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,error_code=$4,error_message=$5,finished_at=now(),updated_at=now() WHERE id=$1",
        [
          state.job.id,
          complete ? "succeeded" : "failed",
          complete
            ? "completed · business results unverified"
            : "needs attention",
          complete ? null : "GROUP_INCOMPLETE",
          complete
            ? null
            : "Some selected sources or group executions remain incomplete. Preserved results are available for inspection.",
        ],
      );
    });
  }
  async stop(id: string, reason: string, cancelled: boolean) {
    let state = await groupedExecutionState(this.db, id);
    if (!activeStatuses.includes(state.job.status)) return;
    // Fence publication before cleaning up queued/paused child work. Completed
    // runs and already-settled charges are never rewritten.
    await new JobService(this.db).requestCancel(state.job.workflow_id, id);
    state = await groupedExecutionState(this.db, id);
    for (const child of state.jobs.filter((j) =>
      activeStatuses.includes(j.status),
    )) {
      await new JobService(this.db).requestCancel(
        state.job.workflow_id,
        child.id,
      );
      if (child.kind === "execution")
        await new RunService(this.db).finish(child.id, {
          status: "cancelled",
          error: null,
        });
      else if (child.kind === "repair")
        await new RepairService(this.db).finish(
          child.id,
          "cancelled",
          reason,
          "GROUP_STOPPED",
        );
    }
    await this.db.transaction(async (tx) => {
      await workflow(tx, state.job.workflow_id, true);
      await tx.query(
        "UPDATE grouping_questions SET status='cancelled' WHERE parent_job_id=$1 AND status='open'",
        [id],
      );
      await tx.query(
        "UPDATE grouped_executions SET active_elapsed_ms=active_elapsed_ms+CASE WHEN active_since IS NULL THEN 0 ELSE greatest(0,extract(epoch FROM (now()-active_since))*1000)::bigint END,active_since=NULL WHERE job_id=$1",
        [id],
      );
      await tx.query(
        "UPDATE workflow_jobs SET status=$2,phase=$3,error_code=$4,error_message=$5,finished_at=now(),updated_at=now() WHERE id=$1",
        [
          id,
          cancelled ? "cancelled" : "failed",
          cancelled ? "cancelled" : "needs attention",
          cancelled ? "CANCELLED" : "GROUP_STOPPED",
          reason,
        ],
      );
    });
  }
}
