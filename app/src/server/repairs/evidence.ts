import { DomainError } from "../../domain/errors";
import type { AssertionResult } from "../../domain/evaluation";
import type { Project } from "../../domain/project";
import type { RepairContext } from "./generation-service";
import { implementationPath } from "./patch";
import { repetitionDifferences } from "./repetition";

export type PreviousSourceEvidence = {
  attempt_number: number;
  candidate_version_id: string;
  changed_steps: { node_id: string; path: string; source: string }[];
};

// Full changed step bodies are diagnostic evidence, not an adopted baseline.
// Host scaffolding is fixed and need not be repeated for each candidate.
export function changedStepSources(candidate: Project, baseline: Project) {
  return Object.entries(candidate.node_file_map)
    .map(([nodeId]) => [nodeId, implementationPath(candidate, nodeId)] as const)
    .filter(
      ([nodeId, path]) =>
        candidate.files[path] !==
        baseline.files[implementationPath(baseline, nodeId)],
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
      artifacts?: { artifact_id: string }[];
    } | null;
    const documents = manifest?.input?.documents;
    const captured = new Set(manifest?.artifacts?.map((a) => a.artifact_id));
    return {
      input_bundle_id: bundle.id,
      shipment_reference: bundle.shipment_reference,
      documents: Array.isArray(documents)
        ? documents
            .filter(
              (d) => d && typeof d === "object" && captured.has(d.artifact_id),
            )
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

// Group repeated ownership/visit metadata once; retain every allowed event ID.
// Bounded extraction diagnostics accompany the catalogue; full payloads and timing stay in the immutable audit store.
function auditCatalogue(rows: Record<string, unknown>[]) {
  const groups = new Map<
    string,
    {
      case_id: unknown;
      node_id: unknown;
      step_execution_id: unknown;
      case_result_id: unknown;
      attempt_token: unknown;
      events: { id: unknown; kind: unknown; sequence: unknown; diagnostic?: unknown }[];
    }
  >();
  for (const row of rows) {
    const key = JSON.stringify([
      row.case_id,
      row.node_id,
      row.step_execution_id,
      row.case_result_id,
      row.attempt_token,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        case_id: row.case_id,
        node_id: row.node_id,
        step_execution_id: row.step_execution_id,
        case_result_id: row.case_result_id,
        attempt_token: row.attempt_token,
        events: [],
      };
      groups.set(key, group);
    }
    const summary = row.summary as {batch_index?: number; evidence_issues?: unknown[]; evidence_issues_omitted?: number; timing?: unknown} | undefined;
    const diagnostic = summary && (summary.batch_index !== undefined || summary.evidence_issues?.length || summary.timing)
      ? {batch_index: summary.batch_index, evidence_issues: summary.evidence_issues, evidence_issues_omitted: summary.evidence_issues_omitted, timing: summary.timing} : undefined;
    group.events.push({ id: row.id, kind: row.kind, sequence: row.sequence, ...(diagnostic ? { diagnostic } : {}) });
  }
  return {
    included: rows.length,
    total: Number(rows[0]?.total_events ?? rows.length),
    invocations: [...groups.values()],
  };
}
function checkEvidence(checks: AssertionResult[], compact: boolean) {
  if (!compact) return checks;
  return checks.map(({ key, passed, missing, actual }) =>
    passed
      ? { key, passed, missing, actual_omitted: true }
      : { key, passed, missing, actual },
  );
}

// This is a diagnostic projection, never an input to grading or baseline acceptance.
// Exact source, requirements, expected assertions and failed actual values stay intact.
// Stored check results are never changed; the large-context fallback omits passing actuals only.
export function repairPrompt(
  context: RepairContext,
  baseline: Project,
  previousSources: PreviousSourceEvidence[] = [],
) {
  const traceCount =
    context.traces.length +
    (context.baseline_repetitions ?? []).reduce(
      (count, run) => count + run.traces.length,
      0,
    ) +
    context.previous_attempts.reduce(
      (count, attempt) => count + attempt.candidate_traces.length,
      0,
    );
  // Reserve a bounded trace pool alongside full source, case definitions and grades.
  // A multi-case suite can exceed 200 KB before any useful outputs are included.
  const initialOutputLimit = Math.min(
    6000,
    Math.floor(160000 / Math.max(1, traceCount)),
  );
  let outputLimit = initialOutputLimit;
  const repetitions = (context.baseline_repetitions ?? []).map((run) => ({
    ...run,
    output_differences: repetitionDifferences(context.traces, run.traces),
  }));
  while (outputLimit >= 64) {
    for (const compactChecks of [false, true]) {
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
        repair_session_id: context.session?.id,
        board: context.spec.board,
        steps: context.steps,
        baseline_project: baseline,
        baseline_evaluation: context.evaluation,
        clarification_context: "clarification_context" in context ? context.clarification_context : undefined,
        source_run: "source_run" in context ? context.source_run : undefined,
        recovery_contract:
          context.session?.origin === "run"
            ? "Repair an execution failure from the immutable source run. No expected business output is supplied for that run. Successful execution is not business verification. Preserve source-evidence validation; never replace document evidence with engineer assertions."
            : undefined,
        baseline_results: context.results.map((result) => ({
          recorded_input_id: result.id,
          case_id: result.case_id,
          status: result.status,
          outcome: result.outcome,
          check_results: checkEvidence(result.check_results, compactChecks),
          failure_code: result.failure_code,
          failure_message: result.failure_message,
          failure_category: result.failure_category,
        })),
        locked_cases: context.cases,
        replay_contract:
          "replay_step(candidate_patch,recorded_input_id) tests a replacement for one approved Code step. Use occurrence_id from step_traces, or recorded_input_id from a baseline isolated step result. It reuses exact captured input and predecessor outputs. Maximum three replays per attempt. These diagnostics never establish a full-suite pass or authorize promotion. Workflow final assertions are not applied to intermediate steps.",
        assertion_contract:
          "An omitted operator or equals uses exact JSON equality. contains_record requires an array containing an object with every expected top-level field exactly equal; extra fields on that record are allowed. excludes_record requires an array with no such record. Both record checks fail on missing or non-array output. Nested values compare exactly, with no normalization or fuzzy matching. text_includes requires the expected nonempty string as a substring after lowercasing and removing whitespace only. array_includes requires one exact deep-equal member of the selected array. Expectations are locked.",
        input_inventory: context.input_inventory,
        step_traces: traces(context.traces),
        execution_audit_events: auditCatalogue(context.audit_events),
        baseline_repetitions: repetitions.map(
          ({ traces: priorTraces, audit_events, ...run }) => ({
            ...run,
            traces: traces(priorTraces),
            audit_events: auditCatalogue(audit_events),
            trace_coverage: coverage(priorTraces),
          }),
        ),
        repetition_contract:
          "At most two earlier completed runs of this exact baseline version, locked suite and execution configuration. Only cases failing in the current baseline are included. Compare earliest differing outputs; a previously passing final result does not make all its extracted fields trusted. Repeated model responses are evidence of variability, not authority to weaken the frozen business requirements. Inspect source pages before deciding whether extraction or its consumer is wrong.",
        execution_audit_contract:
          "Host-recorded invocation events preserve the generated initial output, actual model request with selected document hashes/configuration, raw parsed model response, postprocessing output, and failures. Use inspectExecutionAudit(event_id,path) to read payloads, at most three inspections per attempt; paths are JSON keys or array indexes. No audit for an older run means unavailable history, not that no model was called. Requests without later response events are incomplete. Audit is evidence, never a grading oracle. Catalogues group events by case, node, occurrence/result and attempt token, preserving every event ID, kind and sequence. included and total report coverage; at most 300 events per evaluation are selected. Payloads remain available through inspectExecutionAudit by event ID.",
        trace_coverage: coverage(context.traces),
        previous_attempts: context.previous_attempts.map(
          ({
            candidate_traces,
            candidate_audit_events,
            candidate_results,
            ...attempt
          }) => ({
            ...attempt,
            candidate_traces: traces(candidate_traces),
            candidate_audit_events: auditCatalogue(candidate_audit_events),
            candidate_results: candidate_results.map((result) => ({
              ...result,
              check_results: checkEvidence(result.check_results, compactChecks),
            })),
            trace_coverage: coverage(candidate_traces),
          }),
        ),
        previous_candidate_sources: previousSources,
        candidate_source_scope:
          "Complete changed step source for the most recent earlier candidate only, relative to baseline_project. Older source remains stored for inspection. A session_id different from the current session identifies the most recent completed candidate from an earlier session restarted from this exact baseline evaluation; it is diagnostic history, not an adopted implementation.",
        check_evidence_scope: compactChecks
          ? "Every assertion key, pass/fail and missing flag is included. Passing actual values and duplicated labels are omitted from this diagnostic projection only; actual_omitted marks this explicitly. Use locked_cases for labels and expected values, and the retained audit/trace to inspect exact outputs. A passing contains/text check does not imply the entire actual value equals its expected fragment. Failed actual values remain complete. Stored grades and acceptance use the original results."
          : "Complete check results are included.",
        evidence_note:
          "Raw final outputs are omitted because exact assertion results and step traces are supplied. The included candidate step sources are complete and compared with the retained baseline; omitted step files for that candidate are unchanged. They are diagnostic evidence only: repair baseline_project, do not adopt a rejected project. Inspect candidate traces and source together for remaining failures as well as regressions: a rejected candidate may reveal new evidence even when an assertion still fails. Large trace outputs use explicitly marked JSON previews, which may end mid-value. A truncated preview is not missing business evidence. Full outputs remain stored for inspection; do not infer unseen values or fabricate a fix when necessary evidence is unavailable.",
      });
      if (Buffer.byteLength(prompt) <= 400000) return prompt;
    }
    outputLimit = Math.floor(outputLimit / 2);
  }
  throw new DomainError(
    413,
    "CONTEXT_TOO_LARGE",
    "Required repair context exceeds the demo limit even with bounded output previews. Inspect the failed steps with an engineer.",
  );
}

// Application UUIDs, audit metadata, labels and prior diagnoses are not business
// answers. Both publication and replay use this same evidence projection.
export function repairIntegrityEvidence(context: RepairContext) {
  return {
    cases: context.cases.map(c => ({ input: c.input_data, expected: c.assertions.map(a => a.expected) })),
    shipments: context.input_inventory.map(bundle => bundle.shipment_reference),
    results: context.results.map(r => ({ output: r.actual_output, actual: r.check_results.map(c => c.actual) })),
    traces: context.traces.map(t => t.output_data),
    repetitions: context.baseline_repetitions.flatMap(run => run.traces.map(t => t.output_data)),
    previous: context.previous_attempts.map(a => ({
      traces: a.candidate_traces.map(t => t.output_data),
      actual: a.candidate_results.flatMap(r => r.check_results.map(c => c.actual)),
    })),
  };
}
