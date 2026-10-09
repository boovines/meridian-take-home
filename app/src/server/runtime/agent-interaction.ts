import { captureInferenceTrace } from "../integrations/inference-trace";
import type { ProviderTrace } from "../../domain/execution-audit";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { stepResult } from "../../domain/project";
import { DomainError } from "../../domain/errors";
import type { RecordAudit } from "../../domain/execution-audit";
import { validateExtraction } from "../../domain/extraction";
import { evidenceDocuments } from "./extraction";
import type { ReasoningDocument } from "./documents";
import type { StepAdapters } from "./invoke-step";

/** One bounded, audited Agent interaction; the caller owns method and schema checks. */
export async function agentInteraction(
  request: Extract<z.infer<typeof stepResult>, { kind: "extract" | "reason" }>,
  adapters: StepAdapters, signal: AbortSignal,
  readDocuments?: (ids: string[]) => Promise<ReasoningDocument[]>,
  audit?: RecordAudit, batchIndex?: number,
  saveProviderTrace?: (trace: ProviderTrace) => void,
) {
  if (request.document_ids.length && !readDocuments)
    throw new DomainError(
      422,
      "DOCUMENT_ACCESS_DENIED",
      "No captured document reader is available.",
    );
  const documents = readDocuments
    ? await readDocuments(request.document_ids)
    : [];
  signal.throwIfAborted();
  const sourcePages =
    request.kind === "extract" ? await evidenceDocuments(documents) : [];
  await audit?.(
    "model_request",
    {
      kind: request.kind,
      ...(request.kind === "extract"
        ? {
            output_schema: request.output_schema,
            critical_paths: request.critical_paths,
            source_pages: sourcePages,
          }
        : {}),
      instructions: request.instructions,
      data: request.data,
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
      document_ids: request.document_ids,
      document_count: documents.length,
      document_bytes: documents.reduce((sum, d) => sum + d.bytes.length, 0),
      ...(sourcePages.length ? { page_count: sourcePages.reduce((sum, d) => sum + d.page_count, 0) } : {}),
      ...(batchIndex === undefined ? {} : { batch_index: batchIndex }),
    },
  );
  signal.throwIfAborted();
  if (request.kind === "extract" && !adapters.extract)
    throw new DomainError(
      503,
      "EXTRACTION_UNAVAILABLE",
      "No evidence-aware extraction provider is configured.",
    );
  let providerTrace: ProviderTrace | undefined;
  const raw = await captureInferenceTrace(async () =>
    request.kind === "extract"
      ? await adapters.extract!(request, documents, signal)
      : await adapters.reason(
          request.instructions,
          request.data,
          signal,
          documents,
        ), trace => { providerTrace = trace; saveProviderTrace?.(trace); });
  signal.throwIfAborted();
  await audit?.("model_response", raw, { ...(batchIndex === undefined ? {} : { batch_index: batchIndex }), ...(providerTrace ? { provider_trace: providerTrace } : {}) });
  const envelope =
    request.kind === "extract"
      ? validateExtraction(request, raw, sourcePages)
      : null;
  const tool_result = envelope ? envelope.data : raw;

  return { tool_result, envelope };
}
