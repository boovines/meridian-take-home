import { PDFDocument } from "pdf-lib";
import {
  extractionEnvelope,
  validateExtraction,
  type ExtractionRequest,
  type ExtractionEnvelope,
  type ExtractionIssue,
} from "../../domain/extraction";
import { DomainError } from "../../domain/errors";
import type { Json } from "../../domain/runtime";
import type { ReasoningDocument } from "./documents";
import { evidenceDocuments } from "./extraction";
export type ExtractionProvider = (
  request: ExtractionRequest,
  documents: ReasoningDocument[],
  signal: AbortSignal,
) => Promise<{ output: Json; metadata: Json }>;

// A single, source-localized repair of extraction evidence. It never sees eval
// expectations and can replace only the exact scalar fields flagged by the host.
export async function extractWithReinspection(
  request: ExtractionRequest,
  documents: ReasoningDocument[],
  signal: AbortSignal,
  provider: ExtractionProvider,
) {
  const first = await provider(request, documents, signal);
  signal.throwIfAborted();
  const sources = await evidenceDocuments(documents);
  let issues: ExtractionIssue[];
  try {
    validateExtraction(request, first.output, sources);
    return first;
  } catch (error) {
    if (
      !(error instanceof DomainError) ||
      !["EXTRACTION_UNRESOLVED", "EXTRACTION_EVIDENCE_INVALID"].includes(
        error.code,
      )
    )
      throw error;
    issues = (error.details as { issues: ExtractionIssue[] }).issues;
  }
  const parsed = extractionEnvelope.safeParse(first.output);
  const skipped = (reason: string) => ({
    output: first.output,
    metadata: {
      first_provider: first.metadata,
      reinspection: { status: "not_attempted", reason, issues },
    } as Json,
  });
  if (
    !parsed.success ||
    issues.some((i) => !i.path.length || i.path.includes("*"))
  )
    return skipped("No precise scalar field was identified.");
  const paths = new Map(issues.map((i) => [JSON.stringify(i.path), i.path]));
  const affected = parsed.data.fields.filter((f) =>
    paths.has(JSON.stringify(f.path)),
  );
  if (
    affected.length !== paths.size ||
    affected.some((f) => !f.evidence.length)
  )
    return skipped("Affected fields cannot be localized to source pages.");
  const selected = new Map<string, Set<number>>();
  for (const f of affected)
    for (const e of f.evidence) {
      const source = sources.find((d) => d.artifact_id === e.artifact_id);
      if (!source || e.page > source.page_count)
        return skipped(
          "Source reference is invalid; do not guess a replacement page.",
        );
      const pages = selected.get(e.artifact_id) || new Set<number>();
      pages.add(e.page);
      selected.set(e.artifact_id, pages);
    }
  if ([...selected.values()].reduce((n, p) => n + p.size, 0) > 3)
    return skipped("Required evidence spans more than three pages.");
  const localized: ReasoningDocument[] = [];
  for (const [id, pages] of selected) {
    const doc = documents.find((d) => d.artifact_id === id)!;
    const pageNumbers = [...pages].sort((a, b) => a - b);
    if (doc.media_type === "application/pdf") {
      const source = await PDFDocument.load(doc.bytes, {
          updateMetadata: false,
        }),
        target = await PDFDocument.create();
      for (const page of await target.copyPages(
        source,
        pageNumbers.map((n) => n - 1),
      ))
        target.addPage(page);
      localized.push({
        ...doc,
        bytes: Buffer.from(await target.save()),
        source_page_numbers: pageNumbers,
      });
    } else localized.push(doc);
  }
  const correctionRequest: ExtractionRequest = {
    ...request,
    document_ids: [...selected.keys()],
    critical_paths: [...paths.values()],
    instructions: `${request.instructions}\nOne evidence correction pass. Inspect the supplied complete source pages, including headers and line context. Correct only these fields: ${JSON.stringify(issues)}. Keep all other data as provided. Do not mark information absent unless these pages suffice to establish that; otherwise keep unresolved. Return the same data shape and fields entries for the listed paths only. Page captions identify original source page numbers.`,
    data: { original_context: request.data, previous_response: parsed.data },
  };
  let second: Awaited<ReturnType<ExtractionProvider>>;
  try {
    second = await provider(correctionRequest, localized, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (signal.aborted) throw error;
    return {
      output: first.output,
      metadata: {
        first_response: first.output,
        first_provider: first.metadata,
        correction_request: correctionRequest,
        correction_error:
          error instanceof DomainError ? error.code : "PROVIDER_ERROR",
        remaining_issues: issues,
      } as Json,
    };
  }
  const repaired = extractionEnvelope.safeParse(second.output);
  if (!repaired.success)
    return {
      output: first.output,
      metadata: {
        first_response: first.output,
        first_provider: first.metadata,
        correction_request: correctionRequest,
        second_response: second.output,
        second_provider: second.metadata,
        remaining_issues: issues,
      } as Json,
    };
  try {
    validateExtraction(correctionRequest, repaired.data, sources);
    for (const field of repaired.data.fields)
      if (paths.has(JSON.stringify(field.path))) {
        if (
          field.evidence.some((e) => !selected.get(e.artifact_id)?.has(e.page))
        )
          throw new DomainError(
            422,
            "EXTRACTION_EVIDENCE_INVALID",
            "Correction cited a page it was not shown.",
          );
      }
  } catch (error) {
    return {
      output: first.output,
      metadata: {
        first_response: first.output,
        first_provider: first.metadata,
        correction_request: correctionRequest,
        second_response: second.output,
        second_provider: second.metadata,
        correction_error:
          error instanceof DomainError ? error.code : "INVALID_CORRECTION",
        remaining_issues: issues,
      } as Json,
    };
  }
  const candidate = structuredClone(parsed.data),
    changes: Json[] = [];
  for (const field of repaired.data.fields) {
    if (!paths.has(JSON.stringify(field.path))) continue;
    const index = candidate.fields.findIndex(
      (f) => JSON.stringify(f.path) === JSON.stringify(field.path),
    );
    if (index < 0) continue;
    let parent = candidate.data as Record<string, Json>;
    for (const key of field.path.slice(0, -1))
      parent = parent[key] as Record<string, Json>;
    const last = field.path.at(-1)!;
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, last))
      continue;
    changes.push({
      path: field.path,
      before: parent[last],
      after: field.normalized_value,
    });
    parent[last] = field.normalized_value;
    candidate.fields[index] = field;
  }
  let remaining: ExtractionIssue[] = [];
  try {
    validateExtraction(request, candidate, sources);
  } catch (e) {
    if (e instanceof DomainError)
      remaining = (e.details as { issues: ExtractionIssue[] })?.issues || [
        { path: [], reason: e.code },
      ];
    else throw e;
  }
  return {
    output: candidate as ExtractionEnvelope as Json,
    metadata: {
      first_response: first.output,
      first_provider: first.metadata,
      correction_request: correctionRequest,
      second_response: second.output,
      second_provider: second.metadata,
      accepted_changes: remaining.length ? [] : changes,
      remaining_issues: remaining,
    } as Json,
  };
}
