import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { Board } from "../../domain/canvas";
import type {
  Plan,
  PlanStep,
  createPlanInput,
  planStepPatch,
  approvePlanInput,
  planRecommendations,
} from "../../domain/engineering";
import type { Database, Queryable } from "../database";
import { workflow, record, expectRevision } from "../workflows/store";
export async function frozenSpec(
  tx: Queryable,
  workflowId: string,
  specId?: string,
) {
  const row = (
    await tx.query(
      specId
        ? "SELECT * FROM frozen_specs WHERE workflow_id=$1 AND id=$2"
        : "SELECT f.* FROM frozen_specs f JOIN workflows w ON w.current_frozen_spec_id=f.id WHERE w.id=$1",
      specId ? [workflowId, specId] : [workflowId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(
      409,
      "FREEZE_REQUIRED",
      "Choose an existing frozen customer workflow before choosing its implementation.",
    );
  return {
    id: String(row.id),
    version_number: Number(row.version_number),
    parent_frozen_spec_id: row.parent_frozen_spec_id as string | null,
    board: row.graph as Board,
  };
}
/** Execution always follows its approved plan, even while a later draft is edited. */
export async function specForPlan(
  tx: Queryable,
  workflowId: string,
  planId: string,
) {
  const row = (
    await tx.query(
      "SELECT frozen_spec_id FROM implementation_plan_versions WHERE workflow_id=$1 AND id=$2",
      [workflowId, planId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Implementation plan not found.");
  return frozenSpec(tx, workflowId, String(row.frozen_spec_id));
}
export async function planById(
  tx: Queryable,
  workflowId: string,
  id: string,
): Promise<Plan> {
  const row = (
    await tx.query(
      "SELECT * FROM implementation_plan_versions WHERE workflow_id=$1 AND id=$2 FOR UPDATE",
      [workflowId, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Implementation plan not found.");
  return record(row);
}
export async function planSteps(
  tx: Queryable,
  id: string,
): Promise<PlanStep[]> {
  return (
    await tx.query(
      "SELECT * FROM implementation_plan_steps WHERE plan_version_id=$1 ORDER BY created_at,node_id",
      [id],
    )
  ).rows.map((r) => record<PlanStep>(r));
}
export class PlanService {
  constructor(private db: Database) {}
  async create(workflowId: string, data: z.infer<typeof createPlanInput>) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const parentSpec = data.parent_plan_version_id
        ? (await planById(tx, workflowId, data.parent_plan_version_id))
            .frozen_spec_id
        : undefined;
      const spec = await frozenSpec(
        tx,
        workflowId,
        data.frozen_spec_id ?? parentSpec,
      );
      const previous = (
        await tx.query(
          "SELECT * FROM implementation_plan_versions WHERE workflow_id=$1 AND creation_key=$2",
          [workflowId, data.request_key],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.parent_plan_version_id !== data.parent_plan_version_id ||
          previous.frozen_spec_id !== spec.id
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request key was used with a different parent plan.",
          );
        return record<Plan>(previous);
      }
      if (
        (
          await tx.query(
            "SELECT id FROM implementation_plan_versions WHERE workflow_id=$1 AND frozen_spec_id=$2 AND state='draft'",
            [workflowId, spec.id],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "DRAFT_EXISTS",
          "Finish the existing draft plan before creating another.",
        );
      let inherited: PlanStep[] = [];
      if (data.parent_plan_version_id) {
        const parent = await planById(
          tx,
          workflowId,
          data.parent_plan_version_id,
        );
        if (parent.state !== "approved" || parent.frozen_spec_id !== spec.id)
          throw new DomainError(
            409,
            "PARENT_NOT_APPROVED",
            "Revise an approved plan.",
          );
        inherited = await planSteps(tx, parent.id);
      }
      const plan = record<Plan>(
        (
          await tx.query(
            `INSERT INTO implementation_plan_versions(workflow_id,frozen_spec_id,version_number,parent_plan_version_id,creation_key)
    VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM implementation_plan_versions WHERE workflow_id=$1),$3,$4) RETURNING *`,
            [
              workflowId,
              spec.id,
              data.parent_plan_version_id,
              data.request_key,
            ],
          )
        ).rows[0],
      );
      for (const node of spec.board.nodes) {
        const prior = inherited.find((s) => s.node_id === node.id),
          human = ["human_handoff", "human_approval"].includes(node.type);
        await tx.query(
          "INSERT INTO implementation_plan_steps(workflow_id,plan_version_id,node_id,selected_method) VALUES($1,$2,$3,$4)",
          [
            workflowId,
            plan.id,
            node.id,
            human ? "human" : prior?.selected_method || "code",
          ],
        );
      }
      return plan;
    });
  }
  async editStep(
    workflowId: string,
    planId: string,
    nodeId: string,
    data: z.infer<typeof planStepPatch>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const plan = await planById(tx, workflowId, planId);
      if (plan.state !== "draft")
        throw new DomainError(
          409,
          "PLAN_APPROVED",
          "Create a new plan version to change approved choices.",
        );
      const row = (
        await tx.query(
          "SELECT * FROM implementation_plan_steps WHERE plan_version_id=$1 AND node_id=$2 FOR UPDATE",
          [planId, nodeId],
        )
      ).rows[0];
      if (!row) throw new DomainError(404, "NOT_FOUND", "Plan step not found.");
      const current = record<PlanStep>(row);
      expectRevision(current, data.expected_revision);
      const spec = await frozenSpec(tx, workflowId, plan.frozen_spec_id),
        node = spec.board.nodes.find((n) => n.id === nodeId)!;
      if (
        ["human_handoff", "human_approval"].includes(node.type) &&
        data.selected_method &&
        data.selected_method !== "human"
      )
        throw new DomainError(
          422,
          "HUMAN_REQUIRED",
          "This human step is required by the customer and cannot be automated.",
        );
      const method = data.selected_method || current.selected_method,
        changed = method !== current.selected_method;
      // Changing a method requires a separate explicit approval of that new choice.
      const approved = changed
        ? null
        : data.approved === undefined
          ? current.approved_at
          : data.approved
            ? new Date().toISOString()
            : null;
      const saved = record<PlanStep>(
        (
          await tx.query(
            "UPDATE implementation_plan_steps SET selected_method=$3,approved_at=$4,revision=revision+1,updated_at=now() WHERE plan_version_id=$1 AND node_id=$2 RETURNING *",
            [planId, nodeId, method, approved],
          )
        ).rows[0],
      );
      await tx.query(
        "UPDATE implementation_plan_versions SET revision=revision+1,updated_at=now() WHERE id=$1",
        [planId],
      );
      return saved;
    });
  }
  async recommendations(
    workflowId: string,
    planId: string,
    expectedRevision: number,
    data: z.infer<typeof planRecommendations>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const plan = await planById(tx, workflowId, planId);
      if (plan.state !== "draft")
        throw new DomainError(
          409,
          "PLAN_APPROVED",
          "The plan was approved while suggestions were being prepared.",
        );
      expectRevision(plan, expectedRevision);
      const spec = await frozenSpec(tx, workflowId, plan.frozen_spec_id),
        ids = new Set(data.steps.map((s) => s.node_id));
      if (
        ids.size !== spec.board.nodes.length ||
        data.steps.length !== ids.size ||
        spec.board.nodes.some((n) => !ids.has(n.id))
      )
        throw new DomainError(
          422,
          "INCOMPLETE_PLAN",
          "AI recommendations must cover each frozen step exactly once.",
        );
      for (const suggestion of data.steps) {
        const node = spec.board.nodes.find((n) => n.id === suggestion.node_id)!;
        if (
          ["human_handoff", "human_approval"].includes(node.type) &&
          suggestion.method !== "human"
        )
          throw new DomainError(
            422,
            "HUMAN_REQUIRED",
            "AI cannot remove a required human step.",
          );
        await tx.query(
          "UPDATE implementation_plan_steps SET recommended_method=$3,recommendation_reason=$4,approved_at=CASE WHEN selected_method=$3 THEN approved_at ELSE NULL END,selected_method=$3,revision=revision+1,updated_at=now() WHERE plan_version_id=$1 AND node_id=$2",
          [planId, suggestion.node_id, suggestion.method, suggestion.reason],
        );
      }
      // Suggest methods populates draft choices, never approves a changed method.
      await tx.query(
        "UPDATE implementation_plan_versions SET revision=revision+1,updated_at=now() WHERE id=$1",
        [planId],
      );
      return planSteps(tx, planId);
    });
  }
  async approve(
    workflowId: string,
    planId: string,
    data: z.infer<typeof approvePlanInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const plan = await planById(tx, workflowId, planId);
      if (plan.state === "approved") return plan;
      expectRevision(plan, data.expected_revision);
      const spec = await frozenSpec(tx, workflowId, plan.frozen_spec_id),
        steps = await planSteps(tx, planId);
      if (
        steps.length !== spec.board.nodes.length ||
        spec.board.nodes.some((n) => !steps.some((s) => s.node_id === n.id))
      )
        throw new DomainError(
          422,
          "INCOMPLETE_PLAN",
          "Every frozen step needs an implementation choice.",
        );
      if (steps.some((s) => !s.approved_at))
        throw new DomainError(
          422,
          "APPROVALS_REQUIRED",
          "Approve each step before approving the plan.",
        );
      return record<Plan>(
        (
          await tx.query(
            "UPDATE implementation_plan_versions SET state='approved',approved_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [planId],
          )
        ).rows[0],
      );
    });
  }
  async state(workflowId: string, specId?: string) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, workflowId, true),
        spec = await frozenSpec(tx, workflowId, specId);
      // Reading progress must also recover an expired slot if the worker is
      // offline. This fences publication; Temporal still owns activity retries.
      await tx.query(
        `UPDATE workflow_jobs SET status=CASE WHEN status='cancel_requested' THEN 'cancelled' ELSE 'failed' END,
          phase='expired',error_code='JOB_EXPIRED',error_message='Generation exceeded its time limit. Check the worker and start a new operation.',finished_at=now(),updated_at=now()
        WHERE workflow_id=$1 AND kind='generation' AND status IN ('queued','running','cancel_requested') AND deadline_at<now()`,
        [workflowId],
      );
      const plans = (
        await tx.query(
          "SELECT * FROM implementation_plan_versions WHERE workflow_id=$1 AND frozen_spec_id=$2 ORDER BY version_number DESC LIMIT 20",
          [workflowId, spec.id],
        )
      ).rows.map((r) => record<Plan>(r));
      const steps = (
        await tx.query(
          "SELECT * FROM implementation_plan_steps WHERE plan_version_id=ANY($1::uuid[]) ORDER BY created_at,node_id",
          [plans.map((p) => p.id)],
        )
      ).rows.map((r) => record<PlanStep>(r));
      const versions = (
        await tx.query(
          `SELECT v.* FROM implementation_versions v JOIN implementation_plan_versions p ON p.id=v.plan_version_id
           WHERE v.workflow_id=$1 AND p.frozen_spec_id=$2 AND (
             v.id IN (SELECT v2.id FROM implementation_versions v2 JOIN implementation_plan_versions p2 ON p2.id=v2.plan_version_id WHERE v2.workflow_id=$1 AND p2.frozen_spec_id=$2 ORDER BY v2.version_number DESC LIMIT 20)
             OR v.id IN (SELECT implementation_version_id FROM workflow_run_defaults WHERE workflow_id=$1 AND frozen_spec_id=$2)
             OR v.id IN (SELECT v3.id FROM implementation_versions v3 JOIN implementation_plan_versions p3 ON p3.id=v3.plan_version_id JOIN workflow_jobs j ON j.id=v3.created_by_job_id WHERE v3.workflow_id=$1 AND p3.frozen_spec_id=$2 AND j.kind='generation' ORDER BY v3.version_number DESC LIMIT 1)
           ) ORDER BY v.version_number DESC`,
          [workflowId, spec.id],
        )
      ).rows;
      const jobs = (
        await tx.query(
          "SELECT j.*,p.frozen_spec_id,f.version_number AS process_version FROM workflow_jobs j JOIN implementation_plan_versions p ON p.id=j.plan_version_id JOIN frozen_specs f ON f.id=p.frozen_spec_id WHERE j.workflow_id=$1 ORDER BY j.created_at DESC,j.id DESC LIMIT 20",
          [workflowId],
        )
      ).rows;
      const specs = (
        await tx.query(
          "SELECT id,version_number,parent_frozen_spec_id,created_at FROM frozen_specs WHERE workflow_id=$1 ORDER BY version_number DESC",
          [workflowId],
        )
      ).rows;
      return { workflow: w, spec, specs, plans, steps, versions, jobs };
    });
  }
}
