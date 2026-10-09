export interface ProviderTrace {
  version: 1;
  stages: { stage: "preflight" | "reservation" | "response" | "reconciliation"; elapsed_ms: number; outcome: "completed" | "failed"; code?: string }[];
  stages_omitted?: number;
  preflight_attempts?: number;
  preflight_failures?: string[];
  input_tokens?: number;
  output_tokens?: number;
  reservation_id?: string;
  reserved_usd?: number;
  actual_usd?: number;
  http_status?: number;
  sdk_error_types?: string[];
  response_status?: string;
  response_output_types?: string[];
  response_content_types?: string[];
}
export const auditKinds = [
  "initial_output",
  "model_request",
  "model_response",
  "final_output",
  "failure",
] as const;
export type AuditKind = (typeof auditKinds)[number];
export interface AuditSummary {
  model?: string;
  provider_trace?: ProviderTrace;
  document_count?: number;
  document_bytes?: number;
  page_count?: number;
  failure_code?: string;
  failure_category?: string;
  timing?: unknown;
  document_ids?: string[];
  batch_index?: number;
  evidence_issues?: { path: string[]; reason: string }[];
  evidence_issues_omitted?: number;
}
export interface AuditEvent {
  id: string;
  workflow_id: string;
  step_execution_id: string | null;
  case_result_id: string | null;
  attempt_token: string;
  sequence: number;
  kind: AuditKind;
  artifact_id: string;
  summary: AuditSummary & { elapsed_ms: number };
  created_at: string;
}
export type RecordAudit = (
  kind: AuditKind,
  payload: unknown,
  summary?: AuditSummary,
) => Promise<void>;
