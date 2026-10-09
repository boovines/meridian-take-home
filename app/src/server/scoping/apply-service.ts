import { randomUUID } from "node:crypto";
import type { z } from "zod";
import {
  scopingApply,
  scaffoldBoard,
  scopeReady,
  previewOutput,
  interviewOutput,
} from "../../domain/scoping";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import {
  workflow,
  editable,
  expectRevision,
  readBoard,
} from "../workflows/store";
import { session, version, requireUnapplied } from "./store";
export class ScaffoldApplyService {
  constructor(private db: Database) {}
  async apply(id: string, data: z.infer<typeof scopingApply>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true),
        s = await session(tx, id);
      if (
        s.apply_request_key === data.request_key &&
        s.applied_preview_id === data.preview_id
      )
        return readBoard(tx, id);
      editable(w);
      requireUnapplied(s);
      expectRevision(w, data.expected_workflow_revision);
      expectRevision(s, data.expected_revision);
      const current = await readBoard(tx, id);
      if (current.nodes.length || current.connections.length)
        throw new DomainError(
          409,
          "BOARD_NOT_EMPTY",
          "The board is no longer empty. Your notes and preview are preserved; existing blocks will not be overwritten.",
        );
      if (
        s.current_preview_id !== data.preview_id ||
        s.note_revision !== s.incorporated_note_revision
      )
        throw new DomainError(
          409,
          "STALE_PREVIEW",
          "Incorporate your latest notes and generate a current preview before applying.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM scoping_operations WHERE workflow_id=$1 AND status IN ('queued','running')",
            [id],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "SCOPING_BUSY",
          "Wait for the current response before applying.",
        );
      const v = await version(tx, id, data.preview_id);
      if (!v || v.kind !== "preview" || v.scope_id !== s.current_scope_id)
        throw new DomainError(
          409,
          "STALE_PREVIEW",
          "This preview is no longer current.",
        );
      const sv = await version(tx, id, v.scope_id);
      const scope = interviewOutput.parse(sv?.data).scope;
      if (!scopeReady(scope))
        throw new DomainError(
          409,
          "SCOPE_NOT_READY",
          "Resolve structural questions before applying.",
        );
      const graph = previewOutput.parse(v.data).graph;
      const ids = Object.fromEntries([
        ...graph.nodes.map((n) => [n.key, randomUUID()]),
        ...graph.connections.map((c) => [`edge:${c.key}`, randomUUID()]),
      ]);
      const board = scaffoldBoard(graph, w, scope, ids);
      for (const n of board.nodes)
        await tx.query(
          "INSERT INTO nodes(id,workflow_id,type,title,instructions,config,x,y,split_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            n.id,
            id,
            n.type,
            n.title,
            n.instructions,
            n.config,
            n.x,
            n.y,
            n.split_mode,
          ],
        );
      // Pair only after all referenced splits exist.
      for (const n of board.nodes.filter((n) => n.join_for_split_id))
        await tx.query("UPDATE nodes SET join_for_split_id=$2 WHERE id=$1", [
          n.id,
          n.join_for_split_id,
        ]);
      for (const c of board.connections)
        await tx.query(
          "INSERT INTO connections(id,workflow_id,source_node_id,target_node_id,condition_text,is_default) VALUES($1,$2,$3,$4,$5,$6)",
          [
            c.id,
            id,
            c.source_node_id,
            c.target_node_id,
            c.condition_text,
            c.is_default,
          ],
        );
      for (const u of scope.unresolved) {
        const a = graph.unresolved_anchors.find((a) => a.key === u.key)!;
        await tx.query(
          "INSERT INTO scoping_obligations(workflow_id,preview_id,source_key,question,anchors) VALUES($1,$2,$3,$4,$5)",
          [
            id,
            v.id,
            u.key,
            u.question,
            {
              nodes: a.node_keys.map((k) =>
                board.nodes.find((n) => n.id === ids[k])!,
              ),
              connections: a.connection_keys.map((k) =>
                board.connections.find((c) => c.id === ids[`edge:${k}`])!,
              ),
            },
          ],
        );
      }
      await tx.query(
        "UPDATE workflows SET desired_outcome=$2,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=$1",
        [id, graph.desired_outcome],
      );
      await tx.query(
        "UPDATE scoping_sessions SET applied_preview_id=$2,applied_content_revision=$3,apply_request_key=$4,applied_element_ids=$5,applied_at=now(),revision=revision+1,updated_at=now() WHERE workflow_id=$1",
        [id, v.id, w.content_revision + 1, data.request_key, ids],
      );
      return readBoard(tx, id);
    });
  }
}
