import {
  EXTRACTION_BATCH_POLICY,
  validateExtractionSchema,
  type ExtractionRequest,
} from "../../domain/extraction";
import { agentInteraction } from "./agent-interaction";
import { DomainError } from "../../domain/errors";
import type { RecordAudit, ProviderTrace } from "../../domain/execution-audit";
import type { Method } from "../../domain/engineering";
import { stepResult, type Project } from "../../domain/project";
import type { Json, RuntimeError } from "../../domain/runtime";
import type { ReasoningDocument } from "./documents";
export interface StepAdapters {
  model?: {
    provider: string;
    name: string;
    system?: string;
    reasoning_effort?: string;
    max_output_tokens?: number;
  };
  invoke(
    project: Project,
    nodeId: string,
    context: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<unknown>;
  extract?(
    request: ExtractionRequest,
    documents: ReasoningDocument[],
    signal: AbortSignal,
  ): Promise<Json>;
  reason(
    instructions: string,
    data: Json,
    signal: AbortSignal,
    documents?: ReasoningDocument[],
  ): Promise<Json>;
}
export async function invokeApprovedStep(
  project: Project,
  nodeId: string,
  method: Method,
  context: Record<string, Json>,
  adapters: StepAdapters,
  signal: AbortSignal,
  readDocuments?: (ids: string[]) => Promise<ReasoningDocument[]>,
  audit?: RecordAudit,
) {
  let batchIndex: number | undefined;
  let providerTrace: ProviderTrace | undefined;
  const saveProviderTrace = (trace: ProviderTrace) => { providerTrace = trace; };
  try {
    signal.throwIfAborted();
    if (method === "human" && !Object.hasOwn(context, "human_response"))
      throw new DomainError(
        422,
        "HUMAN_RESPONSE_REQUIRED",
        "This step requires a fresh human response or verified scripted response.",
      );
    const initial = await adapters.invoke(project, nodeId, context, signal);
    signal.throwIfAborted();
    await audit?.("initial_output", initial);
    let result = stepResult.parse(initial);
    if (result.kind === "reason" || result.kind === "extract" || result.kind === "extract_batch") {
      if (result.kind === "extract")
        validateExtractionSchema(result.output_schema);
      if (method !== "agent")
        throw new DomainError(
          422,
          "METHOD_VIOLATION",
          "Only an approved Agent step can request model reasoning.",
        );
      let tool_result: Json;
      let evidence: Json | undefined;
      if (result.kind === "extract_batch") {
        // Validate every schema up front; a malformed later schema must not waste earlier calls.
        for (const request of result.batches) validateExtractionSchema(request.output_schema);
        const outputs: Json[] = [], fields: Json[] = [];
        for (const [index, request] of result.batches.entries()) {
          batchIndex = index;
          providerTrace = undefined;
          signal.throwIfAborted();
          const value = await agentInteraction(request, adapters, signal, readDocuments, audit, index, saveProviderTrace);
          outputs.push(value.tool_result);
          fields.push(value.envelope!.fields);
          if (Buffer.byteLength(JSON.stringify({ outputs, fields })) > EXTRACTION_BATCH_POLICY.max_combined_result_bytes)
            throw new DomainError(422, "STEP_INPUT_TOO_LARGE", "Combined extraction data and evidence exceed 400 KB. Use a smaller schema or an engineer-reviewed process change; no partial result was published.");
        }
        tool_result = { batches: outputs };
        evidence = { batches: fields };
      } else {
        const value = await agentInteraction(result, adapters, signal, readDocuments, audit, undefined, saveProviderTrace);
        tool_result = value.tool_result;
        evidence = value.envelope?.fields;
      }
      const processed = await adapters.invoke(
        project,
        nodeId,
        {
          ...context,
          tool_result,
          ...(evidence ? { extraction_evidence: evidence } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      await audit?.("final_output", processed);
      result = stepResult.parse(processed);
    }
    if (result.kind !== "complete")
      throw new DomainError(
        422,
        "METHOD_VIOLATION",
        "The step must complete after its single approved interaction.",
      );
    if (Buffer.byteLength(JSON.stringify(result)) > 128_000)
      throw new DomainError(
        422,
        "STEP_OUTPUT_TOO_LARGE",
        "Keep step output under 128 KB; use document artifacts for large payloads.",
      );
    return result;
  } catch (error) {
    if (
      !signal.aborted &&
      !(error instanceof DomainError && error.code === "AUDIT_UNAVAILABLE")
    ) {
      const failure = invocationFailure(error);
      const details = error instanceof DomainError && error.code.startsWith("EXTRACTION_")
        ? error.details as { issues?: { path: string[]; reason: string }[] } | null : null;
      const issues = details?.issues ?? [];
      await audit?.("failure", {
        code: failure.code,
        category: failure.category,
        ...(providerTrace ? { provider_trace: providerTrace } : {}),
        ...(error instanceof DomainError && error.code === "MODEL_RESPONSE_TIMEOUT" ? { timing: error.details } : {}),
        ...(error instanceof DomainError && error.code.startsWith("EXTRACTION_")
          ? { evidence_issues: error.details ?? null }
          : {}),
      }, {
        failure_code: failure.code, failure_category: failure.category,
        ...(providerTrace ? { provider_trace: providerTrace } : {}),
        ...(batchIndex === undefined ? {} : { batch_index: batchIndex }),
        ...(error instanceof DomainError && error.code === "MODEL_RESPONSE_TIMEOUT" ? { timing: error.details } : {}),
        ...(issues.length ? {
          evidence_issues: issues.slice(0, 5).map(i => ({ path: i.path.slice(0, 16).map(p => p.slice(0, 100)), reason: i.reason.slice(0, 500) })),
          evidence_issues_omitted: Math.max(0, issues.length - 5),
        } : {}),
      });
    }
    throw error;
  }
}
export function invocationFailure(error: unknown): RuntimeError {
  const known = error instanceof DomainError,
    message =
      error instanceof Error ? error.message : "Step invocation failed.";
  const implementationCodes = [
    "STEP_CRASH",
    "GROUPING_OUTPUT_INVALID",
    "INVALID_PHASE_ROUTES",
    "METHOD_VIOLATION",
    "STEP_OUTPUT_TOO_LARGE",
    "STEP_INPUT_TOO_LARGE",
    "AGENT_CONTEXT_TOO_LARGE",
    "DOCUMENT_ACCESS_DENIED",
    "DOCUMENT_CONTEXT_TOO_LARGE",
    // The generated module selects document_ids; an unsupported selection can
    // be repaired without mutating the captured evidence or adding capabilities.
    "UNSUPPORTED_DOCUMENT",
    "MODEL_OUTPUT_LIMIT",
    "MODEL_OUTPUT_INVALID",
    "EXTRACTION_SCHEMA_INVALID",
    "EXTRACTION_EVIDENCE_INVALID",
    "EXTRACTION_UNRESOLVED",
    "REPAIR_EVIDENCE_LEAK",
    "REPAIR_INTEGRITY_UNCHECKABLE",
  ];
  const routeCode =
    /^(INVALID_ROUTES|AMBIGUOUS_ROUTE|NO_MATCHING_ROUTE|INVALID_OUTCOME):/.exec(
      message,
    )?.[1];
  const category =
    known &&
    ["HUMAN_RESPONSE_REQUIRED", "INVALID_DOCUMENT", "CAPTURED_DOCUMENT_UNAVAILABLE"].includes(error.code)
      ? "input"
      : routeCode ||
          (known && implementationCodes.includes(error.code)) ||
          (error instanceof Error && error.name === "ZodError")
        ? "implementation"
        : known &&
            [
              "REPAIR_INTEGRITY_LIMIT",
              "EVALUATION_CONFIGURATION_CHANGED",
              "SANDBOX_UNAVAILABLE",
              "MODEL_UNAVAILABLE",
              "MODEL_RESPONSE_TIMEOUT",
              "STEP_EXECUTION_TIMEOUT",
              "MODEL_PROJECT_SPEND_LIMIT",
              "MODEL_QUOTA_EXCEEDED",
              "BUDGET_UNAVAILABLE",
              "TOKEN_PREFLIGHT_TRANSIENT",
              "INFERENCE_BUDGET_LIMIT",
              "AUDIT_UNAVAILABLE",
              "EXTRACTION_UNAVAILABLE",
            ].includes(error.code)
          ? "infrastructure"
          : "unknown";
  return {
    code: known ? error.code : routeCode || "STEP_EXECUTION_FAILED",
    message: message.slice(0, 2000),
    category,
  };
}
