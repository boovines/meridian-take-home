import { createHash } from "node:crypto";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import { bundleInput } from "../../domain/runtime";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
export class BundleService {
  constructor(private db: Database) {}
  async list(workflowId: string) {
    await workflow(this.db, workflowId);
    return (
      await this.db.query(
        "SELECT id,source_kind,shipment_reference,created_at FROM input_bundles WHERE workflow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50",
        [workflowId],
      )
    ).rows;
  }
  async read(workflowId: string, id: string) {
    await workflow(this.db, workflowId);
    const row = (
      await this.db.query(
        "SELECT * FROM input_bundles WHERE workflow_id=$1 AND id=$2",
        [workflowId, id],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        404,
        "NOT_FOUND",
        "Captured input not found on this workflow.",
      );
    return row;
  }
  async create(workflowId: string, raw: z.infer<typeof bundleInput>) {
    return this.db.transaction((tx) =>
      this.createInTransaction(tx, workflowId, raw),
    );
  }
  async createInTransaction(
    tx: Queryable,
    workflowId: string,
    raw: z.infer<typeof bundleInput>,
  ) {
    const data = bundleInput.parse(raw);
    const bytes = JSON.stringify(data.manifest);
    if (Buffer.byteLength(bytes) > 512_000)
      throw new DomainError(
        422,
        "INPUT_TOO_LARGE",
        "Keep the input manifest under 512 KB; store documents as artifacts.",
      );
    await workflow(tx, workflowId, true);
    const ids = [...new Set(data.manifest.artifacts.map((a) => a.artifact_id))];
    if (ids.length) {
      const ready = (
        await tx.query(
          "SELECT id FROM artifacts WHERE workflow_id=$1 AND id=ANY($2::uuid[]) AND state='ready' AND kind='source_document'",
          [workflowId, ids],
        )
      ).rows;
      if (ready.length !== ids.length)
        throw new DomainError(
          422,
          "INVALID_ARTIFACT",
          "Every document must be a ready source artifact owned by this workflow.",
        );
    }
    return (
      await tx.query(
        `INSERT INTO input_bundles(workflow_id,source_kind,shipment_reference,manifest,manifest_hash) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [
          workflowId,
          data.source_kind,
          data.shipment_reference,
          data.manifest,
          createHash("sha256").update(bytes).digest("hex"),
        ],
      )
    ).rows[0];
  }
}
