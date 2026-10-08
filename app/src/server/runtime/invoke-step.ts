import {
  validateExtraction,
  validateExtractionSchema,
  type ExtractionRequest,
} from "../../domain/extraction";
import { evidenceDocuments } from "./extraction";
import { DomainError } from "../../domain/errors";
import { createHash } from "node:crypto";
import type { RecordAudit } from "../../domain/execution-audit";
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
  ): Promise<{ output: Json; metadata: Json }>;
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
    if (result.kind === "reason" || result.kind === "extract") {
      if (result.kind === "extract")
        validateExtractionSchema(result.output_schema);
      if (method !== "agent")
        throw new DomainError(
          422,
          "METHOD_VIOLATION",
          "Only an approved Agent step can request model reasoning.",
        );
      if (result.document_ids.length && !readDocuments)
        throw new DomainError(
          422,
          "DOCUMENT_ACCESS_DENIED",
          "No captured document reader is available.",
        );
      const documents = readDocuments
        ? await readDocuments(result.document_ids)
        : [];
      signal.throwIfAborted();
      const sourcePages =
        result.kind === "extract" ? await evidenceDocuments(documents) : [];
      await audit?.(
        "model_request",
        {
          kind: result.kind,
          ...(result.kind === "extract"
            ? {
                output_schema: result.output_schema,
                critical_paths: result.critical_paths,
                source_pages: sourcePages,
              }
            : {}),
          instructions: result.instructions,
          data: result.data,
          model: adapters.model ?? { provider: "unknown", name: "unknown" },
          documents: documents.map((d) => ({
            artifact_id: d.artifact_id,
            name: d.name,
            media_type: d.media_type,
            byte_size: d.bytes.length,
            sha256: createHash("sha256").update(d.bytes).digest("hex"),
          })),
        },
        {
          model: adapters.model?.name ?? "unknown",
          document_ids: result.document_ids,
        },
      );
      signal.throwIfAborted();
      if (result.kind === "extract" && !adapters.extract)
        throw new DomainError(
          503,
          "EXTRACTION_UNAVAILABLE",
          "No evidence-aware extraction provider is configured.",
        );
      const extraction =
        result.kind === "extract"
          ? await adapters.extract!(result, documents, signal)
          : null;
      const raw = extraction
        ? extraction.output
        : await adapters.reason(
            result.instructions,
            result.data,
            signal,
            documents,
          );
      signal.throwIfAborted();
      await audit?.(
        "model_response",
        extraction ? { output: raw, provider: extraction.metadata } : raw,
      );
      const envelope =
        result.kind === "extract"
          ? validateExtraction(result, raw, sourcePages)
          : null;
      const tool_result = envelope ? envelope.data : raw;
      const processed = await adapters.invoke(
        project,
        nodeId,
        {
          ...context,
          tool_result,
          ...(envelope ? { extraction_evidence: envelope.fields } : {}),
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
      await audit?.("failure", {
        code: failure.code,
        category: failure.category,
        ...(error instanceof DomainError && error.code.startsWith("EXTRACTION_")
          ? { evidence_issues: error.details ?? null }
          : {}),
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
  ];
  const routeCode =
    /^(INVALID_ROUTES|AMBIGUOUS_ROUTE|NO_MATCHING_ROUTE|INVALID_OUTCOME):/.exec(
      message,
    )?.[1];
  const category =
    known &&
    ["HUMAN_RESPONSE_REQUIRED", "INVALID_DOCUMENT"].includes(error.code)
      ? "input"
      : routeCode ||
          (known && implementationCodes.includes(error.code)) ||
          (error instanceof Error && error.name === "ZodError")
        ? "implementation"
        : known &&
            [
              "SANDBOX_UNAVAILABLE",
              "MODEL_UNAVAILABLE",
              "MODEL_PROJECT_SPEND_LIMIT",
              "MODEL_QUOTA_EXCEEDED",
              "AUDIT_UNAVAILABLE",
              "EXTRACTION_UNAVAILABLE",
              "EXTRACTION_PROVIDER_ERROR",
              "INFERENCE_BUDGET_LIMIT",
              "BUDGET_UNAVAILABLE",
              "EVALUATION_CONFIGURATION_CHANGED",
            ].includes(error.code)
          ? "infrastructure"
          : "unknown";
  return {
    code: known ? error.code : routeCode || "STEP_EXECUTION_FAILED",
    message: message.slice(0, 2000),
    category,
  };
}
