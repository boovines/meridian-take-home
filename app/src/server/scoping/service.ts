import type { z } from "zod";
import {
  interviewOutput,
  previewOutput,
  scopeReady,
  scaffoldBoard,
  type saveScopingNote,
  type scopingRequest,
  type ScopingState,
  type ScopingInput,
  type ScopingMessage,
  type ScopingVersion,
} from "../../domain/scoping";
import { DomainError } from "../../domain/errors";
import type { Database } from "../database";
import {
  workflow,
  editable,
  expectRevision,
  readBoard,
} from "../workflows/store";
import {
  session,
  operation,
  operationRecord,
  version,
  expire,
  requireUnapplied,
} from "./store";
export class ScopingService {
  constructor(private db: Database) {}
  async state(id: string): Promise<ScopingState> {
    return this.db.transaction(async (tx) => {
      await workflow(tx, id, true);
      const s = await session(tx, id);
      await expire(tx, id);
      const op = (
        await tx.query(
          "SELECT * FROM scoping_operations WHERE workflow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      const reviewed =
        s.applied_content_revision !== null &&
        (
          await tx.query(
            "SELECT id FROM review_runs WHERE workflow_id=$1 AND status='completed' AND analyzed_content_revision >= $2 LIMIT 1",
            [id, s.applied_content_revision],
          )
        ).rows.length > 0;
      return {
        session: s,
        messages: (
          await tx.query(
            "SELECT id,author,body,created_at FROM scoping_messages WHERE workflow_id=$1 ORDER BY sequence",
            [id],
          )
        ).rows as unknown as ScopingMessage[],
        versions: (
          await tx.query(
            "SELECT * FROM scoping_versions WHERE workflow_id=$1 ORDER BY created_at,id",
            [id],
          )
        ).rows as unknown as ScopingVersion[],
        operation: op ? publicOperation(operationRecord(op)) : null,
        needs_review: s.applied_content_revision !== null && !reviewed,
      };
    });
  }
  async saveNote(id: string, data: z.infer<typeof saveScopingNote>) {
    return this.db.transaction(async (tx) => {
      editable(await workflow(tx, id, true));
      const s = await session(tx, id);
      if (s.note_revision !== data.expected_revision)
        throw new DomainError(
          409,
          "NOTE_CONFLICT",
          "The saved note changed in another tab. Your text is preserved; compare it with the saved note before retrying.",
          { current: s },
        );
      if (s.note !== data.note)
        await tx.query(
          "UPDATE scoping_sessions SET note=$2,note_revision=note_revision+1,updated_at=now() WHERE workflow_id=$1",
          [id, data.note],
        );
      return session(tx, id);
    });
  }
  async request(id: string, data: z.infer<typeof scopingRequest>) {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      const old = (
        await tx.query(
          "SELECT * FROM scoping_operations WHERE workflow_id=$1 AND request_key=$2",
          [id, data.request_key],
        )
      ).rows[0];
      if (old) return operationRecord(old);
      editable(w);
      const s = await session(tx, id);
      requireUnapplied(s);
      expectRevision(s, data.expected_revision);
      if (s.note_revision !== data.expected_note_revision)
        throw new DomainError(
          409,
          "NOTE_CONFLICT",
          "Save and incorporate the current note before continuing.",
        );
      const board = await readBoard(tx, id);
      if (board.nodes.length || board.connections.length)
        throw new DomainError(
          409,
          "BOARD_NOT_EMPTY",
          "Initial generation requires an empty board. Your notes and conversation are preserved.",
        );
      if (!s.note.trim())
        throw new DomainError(
          422,
          "EMPTY_NOTE",
          "Write a few thoughts about your process first.",
        );
      await expire(tx, id);
      if (data.action === "notes") {
        await tx.query(
          "UPDATE scoping_operations SET status='cancelled',finished_at=now() WHERE workflow_id=$1 AND status IN ('queued','running')",
          [id],
        );
      } else if (
        (
          await tx.query(
            "SELECT id FROM scoping_operations WHERE workflow_id=$1 AND status IN ('queued','running')",
            [id],
          )
        ).rows.length
      ) {
        throw new DomainError(
          409,
          "SCOPING_BUSY",
          "Wait for the current response or cancel it first.",
        );
      }
      const scopeVersion = await version(tx, id, s.current_scope_id);
      const scope =
        scopeVersion && "scope" in scopeVersion.data
          ? scopeVersion.data.scope
          : null;
      const previewVersion = await version(tx, id, s.current_preview_id);
      const preview =
        previewVersion && "graph" in previewVersion.data
          ? previewVersion.data.graph
          : null;
      if (["answer", "revise"].includes(data.action) && !data.body.trim())
        throw new DomainError(
          422,
          "MISSING_ANSWER",
          "Enter an answer or describe the change you want.",
        );
      if (
        data.action === "preview" &&
        (!scope ||
          !scopeReady(scope) ||
          s.incorporated_note_revision !== s.note_revision)
      )
        throw new DomainError(
          409,
          "SCOPE_NOT_READY",
          "Confirm a scope with no structural blockers using the current saved note first.",
        );
      if (
        ["answer", "revise"].includes(data.action) &&
        s.incorporated_note_revision !== s.note_revision
      )
        throw new DomainError(
          409,
          "UPDATED_NOTE",
          "Use updated notes before continuing the interview.",
        );
      const body =
        data.body ||
        (data.action === "preview"
          ? "I confirm the displayed scope and assumptions. Generate a workflow preview."
          : data.action === "notes"
            ? "Use my updated notes to reassess the scope."
            : "Help me scope an initial workflow from my notes.");
      const messages = (
        await tx.query(
          "SELECT author,body FROM scoping_messages WHERE workflow_id=$1 ORDER BY sequence",
          [id],
        )
      ).rows as unknown as ScopingMessage[];
      const input: ScopingInput = {
        note: s.note,
        note_revision: s.note_revision,
        action: data.action,
        messages: [...messages, { author: "expert", body }],
        scope,
        scope_id: s.current_scope_id,
        preview,
        workflow: w,
      };
      if (Buffer.byteLength(JSON.stringify(input)) > 180000)
        throw new DomainError(
          422,
          "SCOPING_TOO_LARGE",
          "This conversation exceeds the scoping limit. Shorten the note before starting another turn.",
        );
      const kind = data.action === "preview" ? "preview" : "interview";
      const op = operationRecord(
        (
          await tx.query(
            "INSERT INTO scoping_operations(workflow_id,request_key,kind,session_revision,input,model) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
            [
              id,
              data.request_key,
              kind,
              s.revision + 1,
              input,
              process.env.OPENAI_SCOPING_MODEL ||
                process.env.OPENAI_REVIEW_MODEL ||
                "gpt-5.4-mini",
            ],
          )
        ).rows[0],
      );
      await tx.query(
        "INSERT INTO scoping_messages(workflow_id,operation_id,author,body) VALUES($1,$2,'expert',$3)",
        [id, op.id, body],
      );
      await tx.query(
        "UPDATE scoping_sessions SET revision=revision+1,incorporated_note_revision=$2,current_scope_id=CASE WHEN $3 THEN current_scope_id ELSE NULL END,current_preview_id=CASE WHEN $3 THEN current_preview_id ELSE NULL END,updated_at=now() WHERE workflow_id=$1",
        [id, s.note_revision, kind === "preview"],
      );
      return op;
    });
  }
  async prepare(id: string) {
    return this.db.transaction(async (tx) => {
      const found = await operation(tx, id);
      const w = await workflow(tx, found.workflow_id, true);
      await expire(tx, w.id);
      const op = await operation(tx, id),
        s = await session(tx, w.id);
      if (!["queued", "running"].includes(op.status)) return null;
      if (
        s.revision !== op.session_revision ||
        w.state !== "draft" ||
        s.applied_preview_id
      ) {
        await tx.query(
          "UPDATE scoping_operations SET status='cancelled',finished_at=now() WHERE id=$1",
          [id],
        );
        return null;
      }
      await tx.query(
        "UPDATE scoping_operations SET status='running' WHERE id=$1",
        [id],
      );
      return op;
    });
  }
  async publish(id: string, untrusted: unknown) {
    return this.db.transaction(async (tx) => {
      const found = await operation(tx, id);
      const w = await workflow(tx, found.workflow_id, true);
      await expire(tx, w.id);
      const op = await operation(tx, id),
        s = await session(tx, w.id);
      if (!["queued", "running"].includes(op.status)) return op;
      if (
        s.revision !== op.session_revision ||
        w.state !== "draft" ||
        s.applied_preview_id
      ) {
        await tx.query(
          "UPDATE scoping_operations SET status='cancelled',finished_at=now() WHERE id=$1",
          [id],
        );
        return operation(tx, id);
      }
      const data =
        op.kind === "interview"
          ? interviewOutput.parse(untrusted)
          : previewOutput.parse(untrusted);
      if (
        "scope" in data &&
        new Set(data.scope.unresolved.map((u) => u.key)).size !==
          data.scope.unresolved.length
      )
        throw new DomainError(
          422,
          "INVALID_SCOPE",
          "Unresolved questions must have unique keys.",
        );
      if ("graph" in data) {
        if (!op.input.scope || !scopeReady(op.input.scope))
          throw new DomainError(
            422,
            "SCOPE_NOT_READY",
            "The scope is not ready for generation.",
          );
        scaffoldBoard(data.graph, w, op.input.scope);
      }
      const v = (
        await tx.query(
          "INSERT INTO scoping_versions(workflow_id,operation_id,kind,note_revision,scope_id,data) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
          [
            w.id,
            id,
            op.kind === "interview" ? "scope" : "preview",
            op.input.note_revision,
            op.kind === "preview" ? op.input.scope_id : null,
            data,
          ],
        )
      ).rows[0];
      await tx.query(
        `UPDATE scoping_sessions SET ${op.kind === "interview" ? "current_scope_id" : "current_preview_id"}=$2,revision=revision+1,updated_at=now() WHERE workflow_id=$1`,
        [w.id, v.id],
      );
      await tx.query(
        "INSERT INTO scoping_messages(workflow_id,operation_id,author,body) VALUES($1,$2,'agent',$3)",
        [w.id, id, data.message],
      );
      await tx.query(
        "UPDATE scoping_operations SET status='completed',finished_at=now() WHERE id=$1",
        [id],
      );
      return operation(tx, id);
    });
  }
  async finish(
    id: string,
    status: "cancelled" | "failed",
    message?: string,
    workflowId?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const op = await operation(tx, id);
      if (workflowId && op.workflow_id !== workflowId)
        throw new DomainError(
          404,
          "NOT_FOUND",
          "Operation not found on this workflow.",
        );
      await workflow(tx, op.workflow_id, true);
      await tx.query(
        "UPDATE scoping_operations SET status=$2,error_message=$3,finished_at=now() WHERE id=$1 AND status IN ('queued','running')",
        [id, status, message || null],
      );
      return operation(tx, id);
    });
  }
}

function publicOperation(op: import("../../domain/scoping").ScopingOperation) {
  const {
    id,
    workflow_id,
    kind,
    status,
    session_revision,
    model,
    error_message,
    deadline_at,
  } = op;
  return {
    id,
    workflow_id,
    kind,
    status,
    session_revision,
    model,
    error_message,
    deadline_at,
  };
}
