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
