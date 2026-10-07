import {
  DomainError,
  type Board,
  type Workflow,
  type CanvasNode,
  type Connection,
} from "../../domain/canvas";
import type { Queryable } from "../database";

// pg returns bigint as text; revisions are restricted to JavaScript's safe range.
export function record<T>(row: Record<string, unknown>): T {
  return {
    ...row,
    ...("revision" in row ? { revision: Number(row.revision) } : {}),
    ...("content_revision" in row
      ? { content_revision: Number(row.content_revision) }
      : {}),
  } as T;
}
export async function workflow(
  tx: Queryable,
  id: string,
  lock = false,
): Promise<Workflow> {
  const row = (
    await tx.query(
      `SELECT * FROM workflows WHERE id = $1${lock ? " FOR UPDATE" : ""}`,
      [id],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Workflow not found.");
  return record(row);
}
export function editable(w: Workflow) {
  if (w.state !== "draft")
    throw new DomainError(
      409,
      "WORKFLOW_LOCKED",
      w.state === "frozen"
        ? "This workflow is frozen."
        : "Cancel the active review before editing.",
    );
}
export function expectRevision(
  current: { revision: number },
  expected: number,
) {
  if (current.revision !== expected)
    throw new DomainError(
      409,
      "STALE_EDIT",
      "This item changed in another tab. Your unsaved text is preserved; reload the saved version before retrying.",
      { current },
    );
}
export async function activeNodes(
  tx: Queryable,
  id: string,
): Promise<CanvasNode[]> {
  return (
    await tx.query(
      "SELECT * FROM nodes WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
      [id],
    )
  ).rows.map((r) => record<CanvasNode>(r));
}
export async function readBoard(tx: Queryable, id: string): Promise<Board> {
  return {
    workflow: await workflow(tx, id),
    nodes: await activeNodes(tx, id),
    connections: (
      await tx.query(
        "SELECT * FROM connections WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
        [id],
      )
    ).rows.map((r) => record<Connection>(r)),
  };
}
