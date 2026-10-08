import { z } from "zod";
import { PDFDocument } from "pdf-lib";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  extractionEnvelope,
  extractionInstructions,
  type ExtractionRequest,
} from "../../domain/extraction";
import { DomainError } from "../../domain/errors";
import type { Json } from "../../domain/runtime";
import type { ReasoningDocument } from "../runtime/documents";
import { configuredInferenceBudget } from "./inference-budget";

const origin = "https://api.cloud.llamaindex.ai";
export const llamaExtractConfiguration = {
  provider: "llamacloud",
  tier: "agentic",
  version: "2.5",
  parse_tier: "agentic",
  disable_cache: true,
} as const;
interface Options {
  fetch?: typeof fetch;
  poll_ms?: number;
  api_key?: string;
  project_id?: string;
}
// One combined PDF retains document boundaries via an explicit original-page map.
// This supports cross-page/header context without introducing domain-specific merge rules.
export async function llamaExtract(
  request: ExtractionRequest,
  documents: ReasoningDocument[],
  signal: AbortSignal,
  options: Options = {},
) {
  const key = options.api_key || process.env.LLAMA_CLOUD_API_KEY,
    project = options.project_id || process.env.LLAMA_CLOUD_PROJECT_ID;
  if (!key || !project)
    throw new DomainError(
      503,
      "EXTRACTION_UNAVAILABLE",
      "Configure the LlamaCloud key and project ID before extraction.",
    );
  const transport = options.fetch || fetch;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(150000)]);
  const pageMap: Array<{
    page: number;
    artifact_id: string;
    source_page: number;
  }> = [];
  const merged = await PDFDocument.create();
  for (const document of documents) {
    deadline.throwIfAborted();
    if (document.media_type !== "application/pdf")
      throw new DomainError(
        422,
        "UNSUPPORTED_DOCUMENT",
        "This LlamaExtract adapter currently accepts captured PDF documents only.",
      );
    const pdf = await PDFDocument.load(document.bytes, {
      updateMetadata: false,
    });
    for (const [i, page] of (
      await merged.copyPages(pdf, pdf.getPageIndices())
    ).entries()) {
      merged.addPage(page);
      pageMap.push({
        page: pageMap.length + 1,
        artifact_id: document.artifact_id,
        source_page: document.source_page_numbers?.[i] ?? i + 1,
      });
    }
  }
  if (!pageMap.length)
    throw new DomainError(
      422,
      "INVALID_DOCUMENT",
      "Extraction requires at least one source page.",
    );
  const bytes = await merged.save({ useObjectStreams: false });
  const schema = z.toJSONSchema(extractionEnvelope) as Record<string, unknown>;
  (schema.properties as Record<string, unknown>).data = request.output_schema;
  delete schema.$schema;
  const configuration = {
    ...llamaExtractConfiguration,
    provider: undefined,
    data_schema: schema,
    cite_sources: true,
    confidence_scores: false,
    extraction_target: "per_doc",
    system_prompt: `${extractionInstructions}\nTask: ${request.instructions}\nContext: ${JSON.stringify(request.data)}\nCritical paths: ${JSON.stringify(request.critical_paths)}\nThe uploaded PDF concatenates captured sources. In fields.evidence use original artifact IDs and original source_page, not combined page numbers. Exact map: ${JSON.stringify(pageMap)}`,
  };
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        configuration,
        documents: documents.map((d) => ({
          id: d.artifact_id,
          sha256: createHash("sha256").update(d.bytes).digest("hex"),
        })),
      }),
    )
    .digest("hex");
  // Official pricing: agentic extract 15 + agentic parse 10 credits/page;
  // $1.25/1000 credits. Reserve extra headroom; retained unknown jobs stay charged.
  const reservation = await configuredInferenceBudget()?.reserve(
    "llamacloud",
    pageMap.length * 25 * 0.00125 * 1.2 + 0.01,
    {
      configuration: llamaExtractConfiguration,
      request_sha256: requestHash,
      pages: pageMap.length,
    },
    deadline,
  );
  let fileId: string | undefined,
    jobId: string | undefined,
    completed = false;
  async function api(
    path: string,
    init: RequestInit = {},
    requestSignal = deadline,
    retry = false,
  ) {
    const url = new URL(path, origin);
    url.searchParams.set("project_id", project!);
    for (let attempt = 0; ; attempt++) {
      requestSignal.throwIfAborted();
      const response = await transport(url, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, ...init.headers },
        signal: requestSignal,
      });
      if (response.ok) return response;
      if (
        retry &&
        attempt === 0 &&
        (response.status === 429 || response.status >= 500)
      ) {
        await delay(250, undefined, { signal: requestSignal });
        continue;
      }
      throw new DomainError(
        503,
        "EXTRACTION_PROVIDER_ERROR",
        `LlamaCloud request failed (${response.status}); no output accepted.`,
      );
    }
  }
  try {
    const form = new FormData();
    form.set(
      "file",
      new Blob([bytes as BlobPart], { type: "application/pdf" }),
      "captured-documents.pdf",
    );
    form.set("purpose", "extract");
    const upload = await (
      await api("/api/v1/beta/files", { method: "POST", body: form })
    ).json();
    if (typeof upload.id !== "string" || !/^dfl-[a-zA-Z0-9-]+$/.test(upload.id))
      throw new DomainError(
        503,
        "EXTRACTION_PROVIDER_ERROR",
        "LlamaCloud returned an invalid file identity.",
      );
    fileId = upload.id;
    const started = await (
      await api("/api/v2/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_input: fileId, configuration }),
      })
    ).json();
    if (
      typeof started.id !== "string" ||
      !/^ext-[a-zA-Z0-9-]+$/.test(started.id)
    )
      throw new DomainError(
        503,
        "EXTRACTION_PROVIDER_ERROR",
        "LlamaCloud returned an invalid extraction identity.",
      );
    jobId = started.id;
    await reservation?.annotate({ file_id: fileId, job_id: jobId });
    while (true) {
      const job = await (
        await api(
          `/api/v2/extract/${jobId}?expand=extract_metadata&expand=configuration&expand=usage`,
          {},
          deadline,
          true,
        )
      ).json();
      if (job.status === "FAILED" || job.status === "CANCELLED")
        throw new DomainError(
          503,
          "EXTRACTION_PROVIDER_ERROR",
          `LlamaCloud extraction ${job.status.toLowerCase()}; inspect retained job evidence.`,
        );
      if (job.status === "COMPLETED") {
        completed = true;
        deadline.throwIfAborted();
        const credits = job.usage?.credits;
        if (
          typeof credits === "number" &&
          Number.isFinite(credits) &&
          credits >= 0
        )
          await reservation?.settle(credits * 0.00125, {
            usage: job.usage,
            parse_job_id: job.extract_metadata?.parse_job_id ?? null,
          });
        // Keep actual resolved config and job identities; parse-cache reuse is
        // deliberately unknown unless the provider supplies evidence. Extract cache is disabled.
        return {
          output: job.extract_result as Json,
          metadata: JSON.parse(
            JSON.stringify({
              provider: "llamacloud",
              job_id: jobId,
              file_id: fileId,
              request_sha256: requestHash,
              configuration: job.configuration ?? configuration,
              usage: job.usage ?? null,
              parse_job_id: job.extract_metadata?.parse_job_id ?? null,
              parse_cache_reuse: "unknown",
              extract_cache_disabled: true,
              source_pages: pageMap,
              field_metadata: job.extract_metadata?.field_metadata ?? null,
            }),
          ) as Json,
        };
      }
      await delay(options.poll_ms ?? 1000, undefined, { signal: deadline });
    }
  } finally {
    const cleanup = AbortSignal.timeout(5000);
    if (jobId && !completed)
      await api(
        `/api/v2/extract/${jobId}/cancel`,
        { method: "POST" },
        cleanup,
      ).catch(() => {});
    if (fileId)
      await api(
        `/api/v1/beta/files/${fileId}`,
        { method: "DELETE" },
        cleanup,
      ).catch(async () => {
        await reservation?.annotate({ file_cleanup_failed: true });
      });
  }
}
