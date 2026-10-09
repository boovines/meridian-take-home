import type { Queryable } from "../database";
import type {
  ScopingSession,
  ScopingOperation,
  ScopingVersion,
} from "../../domain/scoping";
import { DomainError } from "../../domain/errors";
export async function session(
  tx: Queryable,
  id: string,
): Promise<ScopingSession> {
  await tx.query(
    "INSERT INTO scoping_sessions(workflow_id) VALUES($1) ON CONFLICT DO NOTHING",
    [id],
  );
  const r = (
    await tx.query("SELECT * FROM scoping_sessions WHERE workflow_id=$1", [id])
  ).rows[0];
  return {
    ...r,
    revision: Number(r.revision),
    note_revision: Number(r.note_revision),
    incorporated_note_revision:
      r.incorporated_note_revision === null
        ? null
        : Number(r.incorporated_note_revision),
    applied_content_revision:
      r.applied_content_revision === null
        ? null
        : Number(r.applied_content_revision),
  } as ScopingSession;
}
export function operationRecord(r: Record<string, unknown>): ScopingOperation {
  return {
    ...r,
    session_revision: Number(r.session_revision),
  } as unknown as ScopingOperation;
}
export async function operation(tx: Queryable, id: string) {
  const r = (
    await tx.query("SELECT * FROM scoping_operations WHERE id=$1", [id])
  ).rows[0];
  if (!r)
    throw new DomainError(404, "NOT_FOUND", "Scoping operation not found.");
  return operationRecord(r);
}
export async function version(
  tx: Queryable,
  workflowId: string,
  id: string | null,
) {
  if (!id) return null;
  return (
    await tx.query(
      "SELECT * FROM scoping_versions WHERE workflow_id=$1 AND id=$2",
      [workflowId, id],
    )
  ).rows[0] as unknown as ScopingVersion;
}
export async function expire(tx: Queryable, workflowId: string) {
  await tx.query(
    "UPDATE scoping_operations SET status='failed',error_message='The operation exceeded its time limit. Your notes and previous previews are preserved; try again.',finished_at=now() WHERE workflow_id=$1 AND status IN ('queued','running') AND deadline_at<now()",
    [workflowId],
  );
}
export function requireUnapplied(s: ScopingSession) {
  if (s.applied_preview_id)
    throw new DomainError(
      409,
      "ALREADY_APPLIED",
      "The initial workflow has already been applied. Edit its blocks on the canvas.",
    );
}
