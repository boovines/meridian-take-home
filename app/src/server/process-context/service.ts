import type { z } from "zod";
import {
  saveProcessContext,
  type ProcessContextRecord,
} from "../../domain/process-context";
import { DomainError } from "../../domain/errors";
import { getDatabase, type Database, type Queryable } from "../database";
import { workflow, editable } from "../workflows/store";

export async function readProcessContext(
  tx: Queryable,
  id: string,
): Promise<ProcessContextRecord> {
  const row = (
    await tx.query(
      "SELECT revision,context FROM workflow_process_context WHERE workflow_id=$1",
      [id],
    )
  ).rows[0];
  return {
    revision: Number(row?.revision ?? 1),
    context: (row?.context ?? null) as ProcessContextRecord["context"],
  };
}
export class ProcessContextService {
  constructor(private db: Database) {}
  async load(id: string) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, id, true);
      return readProcessContext(tx, id);
    });
  }
  async save(id: string, input: z.infer<typeof saveProcessContext>) {
    const data = saveProcessContext.parse(input);
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const current = await readProcessContext(tx, id);
      if (current.revision !== data.expected_revision)
        throw new DomainError(
          409,
          "STALE_CONTEXT",
          "Process context changed in another tab. Reload saved context before replacing it.",
        );
      if (JSON.stringify(current.context) === JSON.stringify(data.context))
        return current;
      const row = (
        await tx.query(
          `INSERT INTO workflow_process_context(workflow_id,revision,context) VALUES($1,$2,$3)
        ON CONFLICT(workflow_id) DO UPDATE SET revision=excluded.revision,context=excluded.context,updated_at=now() RETURNING revision,context`,
          [id, current.revision + 1, data.context],
        )
      ).rows[0];
      await tx.query(
        "UPDATE workflows SET content_revision=content_revision+1,updated_at=now() WHERE id=$1",
        [id],
      );
      return {
        revision: Number(row.revision),
        context: row.context,
      } as ProcessContextRecord;
    });
  }
}
export async function processContextService() {
  return new ProcessContextService(await getDatabase());
}
