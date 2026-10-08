export const auditKinds = [
  "initial_output",
  "model_request",
  "model_response",
  "final_output",
  "failure",
] as const;
export type AuditKind = (typeof auditKinds)[number];
export interface AuditEvent {
  id: string;
  workflow_id: string;
  step_execution_id: string | null;
  case_result_id: string | null;
  attempt_token: string;
  sequence: number;
  kind: AuditKind;
  artifact_id: string;
  summary: { elapsed_ms: number; model?: string; document_ids?: string[] };
  created_at: string;
}
export type RecordAudit = (
  kind: AuditKind,
  payload: unknown,
  summary?: { model?: string; document_ids?: string[] },
) => Promise<void>;
