import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Board } from "../../domain/canvas";
import { stepContext } from "../../domain/process-signature";
import type { Queryable } from "../database";
/** Called in the freeze transaction: new spec and unapproved plan publish together. */
export async function createHandoffPlan(
  tx: Queryable,
  workflowId: string,
  specId: string,
  board: Board,
  parentSpecId: string,
) {
  const parent = (
    await tx.query(
      "SELECT p.*,f.graph FROM implementation_plan_versions p JOIN frozen_specs f ON f.id=p.frozen_spec_id WHERE p.workflow_id=$1 AND p.frozen_spec_id=$2 AND p.state='approved' ORDER BY p.version_number DESC LIMIT 1",
      [workflowId, parentSpecId],
    )
  ).rows[0];
  const oldSteps = parent
    ? (
        await tx.query(
          "SELECT * FROM implementation_plan_steps WHERE plan_version_id=$1",
          [parent.id],
        )
      ).rows
    : [];
  const plan = (
    await tx.query(
      "INSERT INTO implementation_plan_versions(workflow_id,frozen_spec_id,version_number,parent_plan_version_id,creation_key) VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM implementation_plan_versions WHERE workflow_id=$1),$3,$4) RETURNING *",
      [workflowId, specId, parent?.id ?? null, randomUUID()],
    )
  ).rows[0];
  for (const node of board.nodes) {
    const old = oldSteps.find((s) => s.node_id === node.id);
    const unchanged =
      old &&
      parent &&
      isDeepStrictEqual(
        stepContext(parent.graph as Board, node.id),
        stepContext(board, node.id),
      );
    const method = ["human_approval", "human_handoff"].includes(node.type)
      ? "human"
      : unchanged
        ? old.selected_method
        : "code";
    await tx.query(
      "INSERT INTO implementation_plan_steps(workflow_id,plan_version_id,node_id,selected_method) VALUES($1,$2,$3,$4)",
      [workflowId, plan.id, node.id, method],
    );
  }
  return plan;
}
