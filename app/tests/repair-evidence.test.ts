import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { Project } from "../src/domain/project";
import type { RepairContext } from "../src/server/repairs/generation-service";
import { repairPrompt } from "../src/server/repairs/evidence";

it("fits repeated audit and passing-value evidence without losing locked inputs, source, failures or audit identities", () => {
  const wid = randomUUID(),
    node = randomUUID(),
    suite = randomUUID();
  const cases = Array.from({ length: 24 }, (_, n) => ({
    id: randomUUID(),
    workflow_id: wid,
    suite_version_id: suite,
    name: `Case ${n}`,
    kind: "step",
    node_id: node,
    input_data: { input: "Fixed input context. ".repeat(160) },
    assertions: [
      {
        key: "records",
        label: "Contains the required record",
        path: ["records"],
        operator: "contains_record",
        expected: { approved: true },
      },
    ],
  }));
  const results = cases.map((c, n) => ({
    id: randomUUID(),
    case_id: c.id,
    status: "finished",
    outcome: n ? "passed" : "failed",
    check_results: [
      {
        key: "records",
        label: "Contains the required record",
        passed: n > 0,
        missing: false,
        actual: n
          ? Array.from({ length: 40 }, () => ({
              approved: true,
              description: "Supporting record. ".repeat(3),
            }))
          : [{ approved: false }],
      },
    ],
  }));
  const audits = Array.from({ length: 50 }, (_, n) => {
    const occurrence = randomUUID(),
      token = randomUUID();
    return [
      "initial_output",
      "model_request",
      "model_response",
      "final_output",
    ].map((kind, sequence) => ({
      id: randomUUID(),
      workflow_id: wid,
      case_id: cases[n % 24].id,
      node_id: node,
      step_execution_id: occurrence,
      case_result_id: null,
      attempt_token: token,
      sequence,
      kind,
      artifact_id: randomUUID(),
      total_events: 200,
      created_at: "2026-10-08T00:00:00Z",
      summary: { elapsed_ms: 1234 },
    }));
  }).flat();
  const context = {
    spec: { board: { workflow: { id: wid }, nodes: [], connections: [] } },
    steps: [],
    evaluation: { id: randomUUID() },
    cases,
    results,
    traces: [],
    input_inventory: [],
    audit_events: audits,
    previous_attempts: [1, 2].map((attempt_number) => ({
      attempt_number,
      candidate_results: results,
      candidate_traces: [],
      candidate_audit_events: audits,
    })),
  } as unknown as RepairContext;
  const source =
    "export async function run(context) { return {kind:'complete',output:context.input,matching_connection_ids:[]}; }";
  const project = {
    format: "meridian-project-v1",
    workflow_id: wid,
    frozen_spec_id: randomUUID(),
    plan_version_id: randomUUID(),
    entrypoint: "run-step.mjs",
    node_file_map: { [node]: `steps/${node}.mjs` },
    files: { [`steps/${node}.mjs`]: source },
    generator: { model: "fixture", summary: "fixture" },
  } as Project;
  const before = JSON.stringify(context);
  const text = repairPrompt(context, project);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400000);
  const prompt = JSON.parse(text);
  expect(prompt.locked_cases).toEqual(cases);
  expect(prompt.baseline_project).toEqual(project);
  expect(prompt.baseline_results[0].check_results[0].actual).toEqual([
    { approved: false },
  ]);
  expect(prompt.baseline_results[1].check_results[0]).toMatchObject({
    key: "records",
    passed: true,
    actual_omitted: true,
  });
  expect(prompt.baseline_results[1].check_results[0]).not.toHaveProperty(
    "actual",
  );
  for (const catalogue of [
    prompt.execution_audit_events,
    ...prompt.previous_attempts.map((a: { candidate_audit_events: unknown }) => a.candidate_audit_events),
  ]) {
    expect(catalogue.included).toBe(200);
    expect(catalogue.total).toBe(200);
    expect(
      catalogue.invocations
        .flatMap((g: { events: { id: string }[] }) => g.events.map(e => e.id))
        .sort(),
    ).toEqual(audits.map((e) => e.id).sort());
    expect(catalogue.invocations).toHaveLength(50);
    expect(catalogue.invocations[0]).toMatchObject({
      case_id: audits[0].case_id,
      node_id: node,
      step_execution_id: audits[0].step_execution_id,
      attempt_token: audits[0].attempt_token,
    });
  }
  expect(JSON.stringify(context)).toBe(before);
});

it("keeps a late changed field visible even when both repeated trace previews are truncated", () => {
  const node = randomUUID(), caseId = randomUUID();
  const previous = { records: Array.from({ length: 30 }, (_, index) => ({
    label: "Unchanged supporting detail. ".repeat(40), identifier: `ITEM${index}1234`,
  })) };
  const current = structuredClone(previous);
  current.records[29].identifier = "ITEM2912340";
  const trace = (output_data: unknown, occurrence_id: string) => ({
    case_id: caseId, node_id: node, node_visit_number: 1, status: "completed", occurrence_id, output_data,
  });
  const context = {
    spec: { board: {} }, steps: [], cases: [], results: [], input_inventory: [], audit_events: [], previous_attempts: [],
    traces: [trace(current, "current-occurrence")],
    baseline_repetitions: [{ id: "prior-evaluation", traces: [trace(previous,"prior-occurrence")], audit_events: [] }],
  } as unknown as RepairContext;
  const before = JSON.stringify(context);
  const prompt = JSON.parse(repairPrompt(context, { files: {} } as Project));
  expect(prompt.step_traces[0].output_data.truncated).toBe(true);
  expect(prompt.baseline_repetitions[0].traces[0].output_data.truncated).toBe(true);
  expect(prompt.baseline_repetitions[0].output_differences.changes).toEqual([{
    case_id: caseId, node_id: node, node_visit_number: 1,
    earlier_occurrence_id: "prior-occurrence", current_occurrence_id: "current-occurrence",
    path: ["records",29,"identifier"],
    earlier: { present:true, value:"ITEM291234" }, current: { present:true, value:"ITEM2912340" },
  }]);
  expect(JSON.stringify(context)).toBe(before);
});

it("keeps exact field diagnostics and batch ownership in the repair catalogue",()=>{
  const diagnostic={batch_index:1,evidence_issues:[{path:["records","0","reference"],reason:"Missing field evidence."}],evidence_issues_omitted:2};
  const context={spec:{board:{}},steps:[],cases:[],results:[],input_inventory:[],previous_attempts:[],traces:[],audit_events:[{id:"failure",kind:"failure",sequence:5,case_id:"case",node_id:"node",attempt_token:"attempt",summary:{...diagnostic,elapsed_ms:10}}]} as unknown as RepairContext;
  const prompt=JSON.parse(repairPrompt(context,{files:{}} as Project));
  expect(prompt.execution_audit_events.invocations[0].events[0]).toEqual({id:"failure",kind:"failure",sequence:5,diagnostic:{...diagnostic,elapsed_ms:10}});
});

it("compacts successful provider metadata across attempts while preserving every audit reference and failure trace", () => {
  const provider = {
    version: 1, reservation_id: randomUUID(), input_tokens: 15000, output_tokens: 4000,
    reserved_usd: 0.3, actual_usd: 0.09, http_status: 200, response_status: "completed",
    response_output_types: ["reasoning", "message"], response_content_types: ["output_text"],
    preflight_attempts: 3, preflight_failures: ["attempt_timeout", "attempt_timeout"],
    stages: ["preflight", "reservation", "response", "reconciliation"].map(stage => ({ stage, elapsed_ms: 30000, outcome: "completed" })),
  };
  const audits = Array.from({ length: 300 }, (_, n) => ({
    id: randomUUID(), kind: n ? "model_response" : "failure", sequence: n,
    case_id: `case-${n % 11}`, node_id: "extract", step_execution_id: `step-${Math.floor(n / 3)}`,
    attempt_token: "attempt", total_events: 300,
    summary: { batch_index: n % 3, provider_trace: n ? { ...provider, response_status: n % 2 ? undefined : "completed" } : { ...provider, sdk_error_types: ["AI_JSONParseError"] },
      ...(n ? {} : { failure_code: "MODEL_UNAVAILABLE", failure_category: "infrastructure" }) },
  }));
  const cases = [{ id: "case", input_data: { fixed: "input" }, assertions: [{ key: "count", expected: 7 }] }];
  const results = [{ id: "result", case_id: "case", outcome: "failed", check_results: [{key: "count", passed: false, missing: false, actual: 2}] }];
  const context = { spec: {board: {}}, steps: [], cases, results, traces: [], input_inventory: [], audit_events: audits,
    previous_attempts: [1,2].map(attempt_number => ({attempt_number, candidate_traces: [], candidate_audit_events: audits, candidate_results: results})),
  } as unknown as RepairContext;
  const baseline = {files: {"step.mjs": "// retained baseline source\n".repeat(2500)}} as unknown as Project;
  const before = JSON.stringify(context);
  const prompt = JSON.parse(repairPrompt(context, baseline));
  expect(Buffer.byteLength(JSON.stringify(prompt))).toBeLessThanOrEqual(400000);
  expect(prompt.locked_cases).toEqual(cases);
  expect(prompt.baseline_project).toEqual(baseline);
  expect(prompt.baseline_results[0].check_results[0].actual).toBe(2);
  for (const catalogue of [prompt.execution_audit_events, ...prompt.previous_attempts.map((p: {candidate_audit_events: unknown}) => p.candidate_audit_events)]) {
    const events = catalogue.invocations.flatMap((g: {events: {id: string; diagnostic: Record<string, unknown>}[]}) => g.events);
    expect(events.map((e: {id: string}) => e.id).sort()).toEqual(audits.map(e => e.id).sort());
    expect(events[0].diagnostic.provider_trace).toEqual(audits[0].summary.provider_trace);
    expect(events[0].diagnostic.failure_code).toBe("MODEL_UNAVAILABLE");
    expect(events[1].diagnostic).toMatchObject({batch_index: 1, provider_trace_omitted: true});
    expect(events[1].diagnostic).not.toHaveProperty("provider_trace");
  }
  expect(JSON.stringify(context)).toBe(before);
});
