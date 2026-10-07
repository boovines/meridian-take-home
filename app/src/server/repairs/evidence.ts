import { DomainError } from "../../domain/canvas";
import type { Project } from "../../domain/project";
import type { RepairContext } from "./generation-service";

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
export function repairPrompt(context: RepairContext, baseline: Project) {
  let outputLimit = Math.min(
    6000,
    Math.floor(80000 / Math.max(1, context.traces.length)),
  );
  while (outputLimit >= 64) {
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
      step_traces: context.traces.map(({ output_data, ...trace }) => ({
        ...trace,
        output_data: preview(output_data, outputLimit),
      })),
      trace_coverage: {
        included: context.traces.length,
        total: Number(
          context.traces[0]?.total_occurrences ?? context.traces.length,
        ),
        order: "Failures first, then chronological; at most 300 occurrences.",
      },
      previous_attempts: context.previous_attempts,
      evidence_note:
        "Raw final outputs are omitted because exact assertion results and step traces are supplied. Large trace outputs use explicitly marked JSON previews, which may end mid-value. A truncated preview is not missing business evidence. Full outputs remain stored for inspection; do not infer unseen values or fabricate a fix when necessary evidence is unavailable.",
    });
    if (Buffer.byteLength(prompt) <= 200000) return prompt;
    outputLimit = Math.floor(outputLimit / 2);
  }
  throw new DomainError(
    413,
    "CONTEXT_TOO_LARGE",
    "Required repair context exceeds the demo limit even with bounded output previews. Inspect the failed steps with an engineer.",
  );
}
