import { DomainError } from "../../domain/canvas";
import type { Project } from "../../domain/project";
import type { RepairContext } from "./generation-service";

export type PreviousSourceEvidence = {
  attempt_number: number;
  candidate_version_id: string;
  changed_steps: { node_id: string; path: string; source: string }[];
};

// Full changed step bodies are diagnostic evidence, not an adopted baseline.
// Host scaffolding is fixed and need not be repeated for each candidate.
export function changedStepSources(candidate: Project, baseline: Project) {
  return Object.entries(candidate.node_file_map)
    .filter(
      ([nodeId, path]) =>
        candidate.files[path] !==
        baseline.files[baseline.node_file_map[nodeId]],
    )
    .map(([node_id, path]) => ({
      node_id,
      path,
      source: candidate.files[path],
    }));
}

// Keep the complete document catalogue separate from truncated execution outputs.
// Email bodies and document contents do not belong in this metadata projection.
export function inputInventory(bundles: Record<string, unknown>[]) {
  return bundles.map((bundle) => {
    const manifest = bundle.manifest as {
      input?: { documents?: unknown };
    } | null;
    const documents = manifest?.input?.documents;
    return {
      input_bundle_id: bundle.id,
      shipment_reference: bundle.shipment_reference,
      documents: Array.isArray(documents)
        ? documents
            .filter((d) => d && typeof d === "object")
            .map((d) => ({
              artifact_id: d.artifact_id,
              name: d.name,
              media_type: d.media_type,
              byte_size: d.byte_size,
            }))
        : [],
    };
  });
}

function preview(value: unknown, limit: number) {
  const json = JSON.stringify(value ?? null);
  const bytes = Buffer.byteLength(json);
  if (bytes <= limit) return value ?? null;
  return {
    truncated: true,
    original_bytes: bytes,
    json_preview: Buffer.from(json).subarray(0, limit).toString("utf8"),
  };
}

// This is a diagnostic projection, never an input to grading or baseline acceptance.
// Exact source, requirements, expected assertions and check results stay intact.
export function repairPrompt(
  context: RepairContext,
  baseline: Project,
  previousSources: PreviousSourceEvidence[] = [],
) {
  const traceCount =
    context.traces.length +
    context.previous_attempts.reduce(
      (count, attempt) => count + attempt.candidate_traces.length,
      0,
    );
  // Reserve a bounded trace pool alongside full source, case definitions and grades.
  // A multi-case suite can exceed 200 KB before any useful outputs are included.
  let outputLimit = Math.min(6000, Math.floor(160000 / Math.max(1, traceCount)));
  while (outputLimit >= 64) {
    const traces = (rows: Record<string, unknown>[]) =>
      rows.map(({ output_data, ...trace }) => ({
        ...trace,
        output_data: preview(output_data, outputLimit),
      }));
    const coverage = (rows: Record<string, unknown>[]) => ({
      included: rows.length,
      total: Number(rows[0]?.total_occurrences ?? rows.length),
      order:
        "Step execution errors first, then chronological; at most 300 occurrences within the stated selection.",
    });
    const prompt = JSON.stringify({
      board: context.spec.board,
      steps: context.steps,
      baseline_project: baseline,
      baseline_evaluation: context.evaluation,
      baseline_results: context.results.map((result) => ({
        case_id: result.case_id,
        status: result.status,
        outcome: result.outcome,
        check_results: result.check_results,
        failure_code: result.failure_code,
        failure_message: result.failure_message,
        failure_category: result.failure_category,
      })),
      locked_cases: context.cases,
      input_inventory: context.input_inventory,
      step_traces: traces(context.traces),
      trace_coverage: coverage(context.traces),
      previous_attempts: context.previous_attempts.map(
        ({ candidate_traces, ...attempt }) => ({
          ...attempt,
          candidate_traces: traces(candidate_traces),
          trace_coverage: coverage(candidate_traces),
        }),
      ),
      previous_candidate_sources: previousSources,
      candidate_source_scope:
        "Complete changed step source for the most recent earlier candidate only, relative to baseline_project. Older source remains stored for inspection.",
      evidence_note:
        "Raw final outputs are omitted because exact assertion results and step traces are supplied. The included candidate step sources are complete and compared with the retained baseline; omitted step files for that candidate are unchanged. They are diagnostic evidence only: repair baseline_project, do not adopt a rejected project. Inspect candidate traces and source together for remaining failures as well as regressions: a rejected candidate may reveal new evidence even when an assertion still fails. Large trace outputs use explicitly marked JSON previews, which may end mid-value. A truncated preview is not missing business evidence. Full outputs remain stored for inspection; do not infer unseen values or fabricate a fix when necessary evidence is unavailable.",
    });
    if (Buffer.byteLength(prompt) <= 400000) return prompt;
    outputLimit = Math.floor(outputLimit / 2);
  }
  throw new DomainError(
    413,
    "CONTEXT_TOO_LARGE",
    "Required repair context exceeds the demo limit even with bounded output previews. Inspect the failed steps with an engineer.",
  );
}
