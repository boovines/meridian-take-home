import type { z } from "zod";
import {
  DomainError,
  validateDraftConnection,
  type Board,
  type Workflow,
  type CanvasNode,
  type Connection,
  type workflowInput,
  type workflowPatch,
  type nodeInput,
  type nodePatch,
  type connectionInput,
  type connectionPatch,
} from "../domain/canvas";
import type { Database, Queryable } from "./database";

// pg returns bigint as text; revisions are restricted to JavaScript's safe range.
function record<T>(row: Record<string, unknown>): T {
  return {
    ...row,
    ...("revision" in row ? { revision: Number(row.revision) } : {}),
    ...("content_revision" in row
      ? { content_revision: Number(row.content_revision) }
      : {}),
  } as T;
}
async function workflow(
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
function editable(w: Workflow) {
  if (w.state !== "draft")
    throw new DomainError(
      409,
      "WORKFLOW_LOCKED",
      w.state === "frozen"
        ? "This workflow is frozen."
        : "Cancel the active review before editing.",
    );
}
function expectRevision(current: { revision: number }, expected: number) {
  if (current.revision !== expected)
    throw new DomainError(
      409,
      "STALE_EDIT",
      "This item changed in another tab. Your unsaved text is preserved; reload the saved version before retrying.",
      { current },
    );
}
async function touch(tx: Queryable, id: string, semantic: boolean) {
  await tx.query(
    "UPDATE workflows SET updated_at=now(), content_revision=content_revision+$2 WHERE id=$1",
    [id, semantic ? 1 : 0],
  );
}
async function activeNodes(tx: Queryable, id: string): Promise<CanvasNode[]> {
  return (
    await tx.query(
      "SELECT * FROM nodes WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
      [id],
    )
  ).rows.map((r) => record<CanvasNode>(r));
}
async function activeNode(
  tx: Queryable,
  id: string,
  nodeId: string,
): Promise<CanvasNode> {
  const row = (
    await tx.query(
      "SELECT * FROM nodes WHERE workflow_id=$1 AND id=$2 AND deleted_at IS NULL",
      [id, nodeId],
    )
  ).rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Block not found.");
  return record<CanvasNode>(row);
}
async function validateJoin(
  tx: Queryable,
  id: string,
  splitId: string,
  nodeId?: string,
) {
  const rows = (
    await tx.query(
      "SELECT id FROM nodes WHERE workflow_id=$1 AND id=$2 AND split_mode='parallel' AND deleted_at IS NULL",
      [id, splitId],
    )
  ).rows;
  if (splitId === nodeId || !rows.length)
    throw new DomainError(
      422,
      "INVALID_MERGE",
      "Choose a different active parallel split on this board.",
    );
}
async function validateEndpoints(
  tx: Queryable,
  id: string,
  data: z.infer<typeof connectionInput>,
) {
  const nodes = (
    await tx.query(
      "SELECT * FROM nodes WHERE workflow_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL",
      [id, [data.source_node_id, data.target_node_id]],
    )
  ).rows.map((r) => record<CanvasNode>(r));
  validateDraftConnection(nodes, data);
}
async function updateRow(
  tx: Queryable,
  table: "nodes" | "connections",
  id: string,
  data: Record<string, unknown>,
) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  await tx.query(
    `UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(",")}, revision=revision+1, updated_at=now() WHERE id=$1`,
    [id, ...keys.map((k) => data[k])],
  );
}

export class CanvasService {
  constructor(private db: Database) {}
  async list(): Promise<Workflow[]> {
    return (
      await this.db.query(
        "SELECT * FROM workflows ORDER BY updated_at DESC,id DESC LIMIT 100",
      )
    ).rows.map((r) => record<Workflow>(r));
  }
  async create(data: z.infer<typeof workflowInput>): Promise<Workflow> {
    return record(
      (
        await this.db.query(
          "INSERT INTO workflows(name,desired_outcome) VALUES ($1,$2) RETURNING *",
          [data.name, data.desired_outcome],
        )
      ).rows[0],
    );
  }
  async load(id: string): Promise<Board> {
    return this.db.transaction(async (tx) => {
      // Shared lock prevents a graph mutation between these reads.
      const row = (
        await tx.query("SELECT * FROM workflows WHERE id=$1 FOR SHARE", [id])
      ).rows[0];
      if (!row) throw new DomainError(404, "NOT_FOUND", "Workflow not found.");
      return {
        workflow: record<Workflow>(row),
        nodes: await activeNodes(tx, id),
        connections: (
          await tx.query(
            "SELECT * FROM connections WHERE workflow_id=$1 AND deleted_at IS NULL ORDER BY created_at,id",
            [id],
          )
        ).rows.map((r) => record<Connection>(r)),
      };
    });
  }
  async updateWorkflow(id: string, data: z.infer<typeof workflowPatch>) {
    return this.db.transaction(async (tx) => {
      const current = await workflow(tx, id, true);
      editable(current);
      expectRevision(current, data.expected_revision);
      const name = data.name ?? current.name,
        goal = data.desired_outcome ?? current.desired_outcome;
      if (name === current.name && goal === current.desired_outcome)
        return current;
      return record<Workflow>(
        (
          await tx.query(
            "UPDATE workflows SET name=$2,desired_outcome=$3,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id, name, goal],
          )
        ).rows[0],
      );
    });
  }
  async addNode(id: string, data: z.infer<typeof nodeInput>) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      if (data.join_for_split_id)
        await validateJoin(tx, id, data.join_for_split_id);
      const row = (
        await tx.query(
          "INSERT INTO nodes(workflow_id,type,title,instructions,config,x,y,split_mode,join_for_split_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [
            id,
            data.type,
            data.title,
            data.instructions,
            data.config,
            data.x,
            data.y,
            data.split_mode,
            data.join_for_split_id,
          ],
        )
      ).rows[0];
      await touch(tx, id, true);
      return record<CanvasNode>(row);
    });
  }
  async editNode(id: string, nodeId: string, data: z.infer<typeof nodePatch>) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const current = await activeNode(tx, id, nodeId);
      expectRevision(current, data.expected_revision);
      const { expected_revision: _, ...patch } = data;
      void _;
      if (patch.join_for_split_id)
        await validateJoin(tx, id, patch.join_for_split_id, nodeId);
      const changed = Object.fromEntries(
        Object.entries(patch).filter(
          ([k, v]) =>
            JSON.stringify(v) !==
            JSON.stringify(current[k as keyof CanvasNode]),
        ),
      );
      await updateRow(tx, "nodes", nodeId, changed);
      if (Object.keys(changed).length)
        await touch(
          tx,
          id,
          Object.keys(changed).some((k) => k !== "x" && k !== "y"),
        );
      return record<CanvasNode>(
        (await tx.query("SELECT * FROM nodes WHERE id=$1", [nodeId])).rows[0],
      );
    });
  }
  async deleteNode(id: string, nodeId: string, expected: number) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const current = await activeNode(tx, id, nodeId);
      expectRevision(current, expected);
      await tx.query(
        "UPDATE nodes SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1",
        [nodeId],
      );
      await tx.query(
        "UPDATE connections SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE workflow_id=$1 AND (source_node_id=$2 OR target_node_id=$2) AND deleted_at IS NULL",
        [id, nodeId],
      );
      await tx.query(
        "UPDATE nodes SET join_for_split_id=NULL,revision=revision+1,updated_at=now() WHERE workflow_id=$1 AND join_for_split_id=$2 AND deleted_at IS NULL",
        [id, nodeId],
      );
      await touch(tx, id, true);
    });
  }
  async addConnection(id: string, data: z.infer<typeof connectionInput>) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      await validateEndpoints(tx, id, data);
      const row = (
        await tx.query(
          "INSERT INTO connections(workflow_id,source_node_id,target_node_id,condition_text,is_default) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [
            id,
            data.source_node_id,
            data.target_node_id,
            data.condition_text,
            data.is_default,
          ],
        )
      ).rows[0];
      await touch(tx, id, true);
      return record<Connection>(row);
    });
  }
  async editConnection(
    id: string,
    connectionId: string,
    data: z.infer<typeof connectionPatch>,
  ) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const row = (
        await tx.query(
          "SELECT * FROM connections WHERE workflow_id=$1 AND id=$2 AND deleted_at IS NULL",
          [id, connectionId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(404, "NOT_FOUND", "Connection not found.");
      const current = record<Connection>(row);
      expectRevision(current, data.expected_revision);
      const { expected_revision: _, ...patch } = data;
      void _;
      await validateEndpoints(tx, id, { ...current, ...patch });
      await updateRow(tx, "connections", connectionId, patch);
      if (Object.keys(patch).length) await touch(tx, id, true);
      return record<Connection>(
        (
          await tx.query("SELECT * FROM connections WHERE id=$1", [
            connectionId,
          ])
        ).rows[0],
      );
    });
  }
  async deleteConnection(id: string, connectionId: string, expected: number) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const row = (
        await tx.query(
          "SELECT * FROM connections WHERE workflow_id=$1 AND id=$2 AND deleted_at IS NULL",
          [id, connectionId],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(404, "NOT_FOUND", "Connection not found.");
      expectRevision(record<Connection>(row), expected);
      await tx.query(
        "UPDATE connections SET deleted_at=now(),updated_at=now(),revision=revision+1 WHERE id=$1",
        [connectionId],
      );
      await touch(tx, id, true);
    });
  }
}
