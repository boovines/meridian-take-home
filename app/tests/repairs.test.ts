import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { SuiteService } from "../src/server/evaluations/suite-service";
import {
  EvaluationService,
  resultsByEvaluation,
} from "../src/server/evaluations/evaluation-service";
import { ExecutionAuditService } from "../src/server/runtime/audit-service";
import { repairAuditBudget, RepairAuditReader } from "../src/server/repairs/audit";
import { RepairService } from "../src/server/repairs/service";
import { repairDocumentBudget, RepairDocumentReader } from "../src/server/repairs/documents";
import { RepairGenerationService, type RepairGenerator } from "../src/server/repairs/generation-service";
import { JobService } from "../src/server/engineering/job-service";
import { VersionService } from "../src/server/engineering/version-service";
import { EvaluationExecutionService } from "../src/server/evaluations/execution-service";
import { RunService } from "../src/server/runtime/run-service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { StepService } from "../src/server/runtime/step-service";
import { RuntimeEngine } from "../src/domain/runtime-engine";
import { changedStepSources, inputInventory, repairPrompt } from "../src/server/repairs/evidence";
import { completeRepairSources } from "../src/server/repairs/patch";
import { PlanService } from "../src/server/engineering/plan-service";
import { assembleProject } from "../src/server/engineering/project";
import { caseInput } from "../src/domain/evaluation";
import type { Json } from "../src/domain/runtime";
import { runtimeFixture } from "./fixtures/runtime";
import { fixtureSources } from "./fixtures/engineer";
let db: Database,
  artifacts: ArtifactService,
  suites: SuiteService,
  evals: EvaluationService,
  repairs: RepairService,
  generation: RepairGenerationService,
  directory: string;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated local/CI persistence.");
  db = await createDatabase(url);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-repair-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  suites = new SuiteService(db);
  evals = new EvaluationService(db);
  repairs = new RepairService(db);
  generation = new RepairGenerationService(db, artifacts);
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const generator = {
  model: "fixture",
  generate: async (
    c: Awaited<ReturnType<RepairService["generationContext"]>>,
  ) => ({
    diagnosis: {
      summary: "Correct the output while preserving shipment identity.",
      affected_node_ids: c.spec.board.nodes.filter(n => n.type === "outcome").map(n => n.id),
      changes: ["Count goods once per good."],
    },
    project: fixtureSources(c.spec.board, c.steps.filter(s => c.spec.board.nodes.some(n => n.id === s.node_id && n.type === "outcome"))),
  }),
};
async function record(jobId: string, evaluationId: string, actual: Json, withAudit = false) {
  const ready = (await evals.prepare(jobId, evaluationId))!;
  for (const result of ready.results) {
    await evals.beginCase(result.id);
    if (withAudit) {
      const token = randomUUID();
      await db.query("UPDATE evaluation_case_results SET attempt_token=$2 WHERE id=$1", [result.id, token]);
      await new ExecutionAuditService(db, artifacts).recorder(result.workflow_id, { case_result_id: result.id }, token)("model_response", actual);
    }
    await evals.recordCase(result.id, { actual });
  }
  await evals.finish(jobId, undefined, false, evaluationId);
}
async function prepared(withWorkflowCase = false, withDocument: boolean | Buffer = false, withAudit = false) {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  if (withDocument) {
    const document = await artifacts.create(f.w.id, "source_document", Buffer.isBuffer(withDocument) ? "source.pdf" : "source.txt", Buffer.isBuffer(withDocument) ? "application/pdf" : "text/plain", Buffer.isBuffer(withDocument) ? withDocument : Buffer.from("Independent source evidence"));
    f.bundle = await new BundleService(db).create(f.w.id, {
      source_kind: "fixture", shipment_reference: "SYNTHETIC-001",
      manifest: {
        input: { shipment: "SYNTHETIC-001", documents: [{ artifact_id: document.id, name: document.display_name, media_type: document.media_type, byte_size: document.byte_size }] },
        artifacts: [{ artifact_id: document.id, name: document.display_name, message_id: null }], message_ids: [],
      },
    });
  }
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Locked counting expectations",
    parent_suite_version_id: null,
  });
  const c = await suites.addCase(
    f.w.id,
    suite.id,
    caseInput.parse({
      case_key: "two-fields",
      name: "Two missing fields on one good",
      kind: "step",
      node_id: f.nodes[1].id,
      input_data: {
        input: { shipment: "SYNTHETIC-001", missing_fields: ["HTS", "NDC"] },
        steps: {},
      },
      assertions: [
        {
          key: "shipment",
          label: "Shipment identity",
          path: ["shipment"],
          expected: "SYNTHETIC-001",
        },
        {
          key: "goods",
          label: "Failed goods",
          path: ["failed_goods"],
          expected: 1,
        },
      ],
    }),
  );
  await suites.verifyCase(f.w.id, suite.id, c.id, {
    expected_revision: c.revision,
  });
  if (withWorkflowCase) {
    const workflowCase = await suites.addCase(
      f.w.id,
      suite.id,
      caseInput.parse({
        case_key: "captured-input",
        name: "Captured input identity",
        kind: "workflow",
        input_bundle_id: f.bundle.id,
        assertions: [
          {
            key: "shipment",
            label: "Shipment",
            path: ["shipment"],
            expected: "SYNTHETIC-001",
          },
          {
            key: "goods",
            label: "Failed goods",
            path: ["failed_goods"],
            expected: 1,
          },
        ],
      }),
    );
    await suites.verifyCase(f.w.id, suite.id, workflowCase.id, {
      expected_revision: workflowCase.revision,
    });
  }
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const initial = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  });
  await record(initial.job.id, initial.evaluation.id, {
    shipment: "SYNTHETIC-001",
    failed_goods: 2,
  }, withAudit);
  const request = {
    request_key: randomUUID(),
    baseline_evaluation_id: initial.evaluation.id,
  };
  const started = await repairs.start(f.w.id, request);
  expect((await repairs.start(f.w.id, request)).session.id).toBe(
    started.session.id,
  );
  await repairs.prepare(started.job.id);
  return { f, suite, initial, ...started };
}
it("records inspected locked-case source hashes with the published candidate", async () => {
  const { job } = await prepared(true, true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  let inspectedId = "";
  await generation.run(attempt.id, {
    ...generator,
    generate: async (context, baseline, signal, previousSources, readDocument) => {
      inspectedId = String(context.input_inventory[0].documents[0].artifact_id);
      const document = await readDocument(inspectedId);
      expect(document.bytes.toString()).toBe("Independent source evidence");
      await expect(readDocument(randomUUID())).rejects.toMatchObject({ code: "DOCUMENT_ACCESS_DENIED" });
      return generator.generate(context);
    },
  }, AbortSignal.timeout(10000));
  const saved = (await db.query("SELECT metadata FROM artifacts WHERE metadata->>'repair_attempt_id'=$1", [attempt.id])).rows[0];
  const source = (await db.query("SELECT content_hash FROM artifacts WHERE id=$1", [inspectedId])).rows[0];
  expect(saved.metadata).toMatchObject({ inspected_documents: [{ artifact_id: inspectedId, content_hash: source.content_hash }] });
  await repairs.finish(job.id, "cancelled", "Document evidence verified.");
});
it("publishes a focused repair while preserving every untouched step", async () => {
  const { f, job } = await prepared();
  const attempt = await repairs.beginAttempt(job.id, 1);
  const target = f.nodes[1].id;
  const published = await generation.run(attempt.id, {
    ...generator,
    generate: async (context) => {
      const result = await generator.generate(context);
      result.project.steps = result.project.steps.filter(s => s.node_id === target);
      result.project.steps[0].source_lines.push("// Focused correction");
      return result;
    },
  }, AbortSignal.timeout(10000));
  const versions = new VersionService(db, artifacts);
  const baseline = (await versions.load(f.w.id, f.version.id)).project;
  const candidate = (await versions.load(f.w.id, published.candidate_version_id!)).project;
  const untouched = baseline.node_file_map[f.nodes[0].id];
  expect(candidate.files[untouched]).toBe(baseline.files[untouched]);
  expect(candidate.files[candidate.node_file_map[target]]).toContain("// Focused correction");
  expect(candidate.files["graph.json"]).toBe(baseline.files["graph.json"]);
  expect(candidate.files["plan.json"]).toBe(baseline.files["plan.json"]);
  await repairs.finish(job.id, "cancelled", "Focused publication verified.");
});
it("rejects duplicate, unknown, undiagnosed and empty repair patches", async () => {
  const { f, job } = await prepared();
  const attempt = await repairs.beginAttempt(job.id, 1);
  const context = await repairs.generationContext(attempt.id);
  const { project: baseline } = await new VersionService(db, artifacts).load(f.w.id, f.version.id);
  const valid = await generator.generate(context);
  const variants = [
    { ...valid, project: { ...valid.project, steps: [...valid.project.steps, ...valid.project.steps] } },
    { ...valid, project: { ...valid.project, steps: [{ ...valid.project.steps[0], node_id: randomUUID() }] } },
    { ...valid, diagnosis: { ...valid.diagnosis, affected_node_ids: [] } },
    { ...valid, project: { ...valid.project, steps: [] } },
  ];
  for (const patch of variants) expect(() => completeRepairSources(baseline, context.steps, patch))
    .toThrow(/within the approved plan and diagnosed scope/);
  await repairs.finish(job.id, "cancelled", "Patch validation verified.");
});
it("preserves human gates and includes repaired human handlers in later evidence", async () => {
  const f = await runtimeFixture(db, artifacts);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const { project: baseline } = await new VersionService(db, artifacts).load(f.w.id, f.version.id);
  const { steps } = await new PlanService(db).state(f.w.id);
  const human = f.nodes[1].id;
  const outcome = f.nodes[2].id;
  const repair = {
    diagnosis: { summary: "Correct outcome only.", affected_node_ids: [outcome], changes: ["Outcome correction"] },
    project: fixtureSources(f.board, steps.filter(s => s.node_id === outcome)),
  };
  const candidate = assembleProject(f.board, baseline.frozen_spec_id, f.plan, steps,
    completeRepairSources(baseline, steps, repair), "fixture");
  const handler = `human/${human}.mjs`;
  expect(candidate.files[handler]).toBe(baseline.files[handler]);
  expect(candidate.files[candidate.node_file_map[human]]).toBe(baseline.files[baseline.node_file_map[human]]);
  const modified = structuredClone(candidate);
  modified.files[handler] += "\n// Handle a corrected response";
  expect(changedStepSources(modified, candidate)).toEqual([
    { node_id: human, path: handler, source: modified.files[handler] },
  ]);
});
it("supplies only locked-suite input inventory and keeps numeric filenames outside truncated traces", async () => {
  const { f, job } = await prepared(true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  const context = await repairs.generationContext(attempt.id);
  expect(context.input_inventory).toEqual([
    {
      input_bundle_id: f.bundle.id,
      shipment_reference: "SYNTHETIC-001",
      documents: [],
    },
  ]);
  const documentId = randomUUID();
  const inventory = inputInventory([
    {
      id: f.bundle.id,
      shipment_reference: "SYNTHETIC-001",
      manifest: {
        artifacts: [{ artifact_id: documentId }],
        input: {
          messages: [{ text: "private email body" }],
          documents: [
            {
              artifact_id: documentId,
              name: "180-465.pdf",
              media_type: "application/pdf",
              byte_size: 123,
              contents: "private document contents",
              download_url: "private URL",
            },
          ],
        },
      },
    },
  ]);
  const { project } = await new VersionService(db, artifacts).load(
    f.w.id,
    f.version.id,
  );
  const prompt = repairPrompt(
    {
      ...context,
      input_inventory: inventory,
      traces: [{ output_data: "large trace ".repeat(10000) }],
    },
    project,
  );
  expect(JSON.parse(prompt).input_inventory).toEqual(inventory);
  expect(prompt).toContain("180-465.pdf");
  expect(prompt).not.toMatch(
    /private email body|private document contents|private URL/,
  );
  expect(JSON.parse(prompt).step_traces[0].output_data.truncated).toBe(true);
  await repairs.finish(job.id, "cancelled", "Diagnostic context verified.");
});
it("carries a rejected candidate's compiler diagnostic into the next repair without adopting its source", async () => {
  const { f, job, initial } = await prepared();
  const first = await repairs.beginAttempt(job.id, 1);
  await generation.run(first.id, generator, AbortSignal.timeout(10000));
  const evaluation = await repairs.createEvaluation(first.id);
  await evals.prepare(job.id, evaluation.id);
  const message =
    "Syntax validation failed.\nsteps/outcome.mjs:18\nSyntaxError: Unexpected identifier";
  await evals.finish(
    job.id,
    { code: "PROJECT_BUILD_FAILED", message, category: "implementation" },
    false,
    evaluation.id,
  );
  const decision = await repairs.decide(first.id);
  expect(decision.attempt.status).toBe("rejected");
  expect(decision.session.baseline_evaluation_id).toBe(initial.evaluation.id);
  const next = await repairs.beginAttempt(job.id, 2);
  const context = await repairs.generationContext(next.id);
  expect(context.previous_attempts[0].candidate_results[0]).toMatchObject({
    outcome: "not_run",
    failure_code: "PROJECT_BUILD_FAILED",
    failure_message: message,
  });
  const { project } = await new VersionService(db, artifacts).load(
    f.w.id,
    f.version.id,
  );
  const prompt = JSON.parse(repairPrompt(context, project));
  expect(prompt.previous_attempts[0].candidate_results[0].failure_message).toBe(
    message,
  );
  expect(prompt.baseline_evaluation.id).toBe(initial.evaluation.id);
  expect(prompt.locked_cases[0].assertions).toEqual(context.cases[0].assertions);
  await repairs.finish(job.id, "cancelled", "Compiler evidence verified.");
});
async function candidate(jobId: string, number: number, actual: Json) {
  let attempt = await repairs.beginAttempt(jobId, number);
  attempt = await generation.run(
    attempt.id,
    generator,
    AbortSignal.timeout(10000),
  );
  const evaluation = await repairs.createEvaluation(attempt.id);
  await record(jobId, evaluation.id, actual);
  expect(
    (await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [jobId]))
      .rows[0].status,
  ).toBe("running");
  return { attempt, evaluation };
}
it("rejects regression by assertion identity, keeps rejected code, and repairs from the retained baseline", async () => {
  const { f, job, initial } = await prepared();
  const first = await candidate(job.id, 1, {
    shipment: "WRONG",
    failed_goods: 1,
  });
  const rejected = await repairs.decide(first.attempt.id);
  expect(rejected.attempt.status).toBe("rejected");
  expect(rejected.session.baseline_version_id).toBe(f.version.id);
  const second = await candidate(job.id, 2, {
    shipment: "SYNTHETIC-001",
    failed_goods: 1,
  });
  expect(second.attempt.baseline_evaluation_id).toBe(initial.evaluation.id);
  const context = await repairs.generationContext(second.attempt.id);
  expect(context.evaluation.id).toBe(initial.evaluation.id);
  expect(context.previous_attempts[0].candidate_results[0]).toMatchObject({
    outcome: "failed",
    check_results: expect.arrayContaining([
      expect.objectContaining({
        key: "shipment",
        passed: false,
        actual: "WRONG",
      }),
    ]),
  });
  const { project } = await new VersionService(db, artifacts).load(
    f.w.id,
    f.version.id,
  );
  const largeContext = {
    ...context,
    traces: Array.from({ length: 40 }, (_, index) => ({
      case_id: context.cases[0].id,
      occurrence_id: String(index),
      total_occurrences: 40,
      output_data: { messages: "captured packet ".repeat(20000) },
    })),
  };
  const prompt = repairPrompt(largeContext, project);
  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(400000);
  const evidence = JSON.parse(prompt);
  expect(evidence.locked_cases).toEqual(
    JSON.parse(JSON.stringify(context.cases)),
  );
  expect(evidence.previous_attempts[0]).toMatchObject(
    JSON.parse(JSON.stringify(context.previous_attempts[0])),
  );
  expect(evidence.step_traces[0].output_data.truncated).toBe(true);
  expect(evidence.trace_coverage).toMatchObject({ included: 40, total: 40 });
  expect(largeContext.traces[0].output_data.messages.length).toBe(320000);
  expect(() =>
    repairPrompt(
      {
        ...context,
        cases: context.cases.map((c) => ({
          ...c,
          assertions: c.assertions.map((a) => ({
            ...a,
            expected: "fixed expectation ".repeat(40000),
          })),
        })),
      },
      project,
    ),
  ).toThrow(/Required repair context exceeds/);
  const parent = (
    await db.query(
      "SELECT parent_version_id FROM implementation_versions WHERE id=$1",
      [second.attempt.candidate_version_id],
    )
  ).rows[0];
  expect(parent.parent_version_id).toBe(f.version.id);
  const accepted = await repairs.decide(second.attempt.id);
  expect(accepted.session).toMatchObject({
    status: "passed",
    baseline_version_id: second.attempt.candidate_version_id,
  });
  expect((await repairs.state(f.w.id)).attempts.map((a) => a.status)).toEqual([
    "rejected",
    "accepted",
  ]);
  expect((await repairs.decide(second.attempt.id)).session.status).toBe(
    "passed",
  );
  await expect(
    db.query("UPDATE repair_attempts SET status='accepted' WHERE id=$1", [
      first.attempt.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
});
it.each(["regressing", "still-failing"])(
  "supplies rejected candidate source and %s case traces without adopting it",
  async (scenario) => {
    const { f, job } = await prepared(true);
    const first = await repairs.beginAttempt(job.id, 1);
    const changedNode = f.nodes[1].id;
    const published = await generation.run(
      first.id,
      {
        ...generator,
        generate: async (context) => {
          const result = await generator.generate(context);
          result.project.steps
            .find((step) => step.node_id === changedNode)!
            .source_lines.push(
              "// rejected extraction prompt: use only fields explicitly labeled REG",
            );
          return result;
        },
      },
      AbortSignal.timeout(10000),
    );
    const evaluation = await repairs.createEvaluation(first.id);
    const ready = (await evals.prepare(job.id, evaluation.id))!;
    const versions = new VersionService(db, artifacts);
    const execution = new EvaluationExecutionService(db, versions, artifacts);
    const runs = new RunService(db),
      steps = new StepService(db, versions, artifacts);
    const actual = {
      shipment: scenario === "regressing" ? "WRONG" : "SYNTHETIC-001",
      failed_goods: scenario === "regressing" ? 1 : 2,
      extracted: { reg: null, newly_observed_detail: "candidate-only evidence" },
    };
    const adapters = {
      invoke: async (
        _project: unknown,
        nodeId: string,
        input: Record<string, Json>,
      ) => ({
        kind: "complete",
        // Keep the candidate rejected by the independent step case while the
        // workflow case can remain incorrect without losing a previously passing check.
        output: (input.input as Record<string, Json>).missing_fields
          ? { ...actual, shipment: "WRONG" }
          : actual,
        matching_connection_ids: f.board.connections
          .filter((edge) => edge.source_node_id === nodeId)
          .map((edge) => edge.id),
      }),
      reason: async () => ({}),
    };
    for (const result of ready.results) {
      const task = await evals.beginCase(result.id);
      if (task.skip) throw new Error("Expected an unevaluated case");
      if (task.kind === "step") {
        await execution.step(result.id, adapters, AbortSignal.timeout(10000));
        continue;
      }
      const context = (await runs.prepareCase(task.run_id))!;
      const engine = new RuntimeEngine(task.run_id, context.definition, {
        now: () => Date.now(),
        scriptedHuman: true,
        changed() {},
        project: (progress) => runs.project(task.run_id, progress),
        step: (data, resume) =>
          steps.execute(data, adapters, AbortSignal.timeout(10000), resume),
        human: async () => {
          throw new Error("No human step in this fixture");
        },
      });
      await runs.finishCase(task.run_id, await engine.run());
      await execution.workflow(result.id);
    }
    await evals.finish(job.id, undefined, false, evaluation.id);
    expect((await repairs.decide(first.id)).attempt.status).toBe("rejected");
    const second = await repairs.beginAttempt(job.id, 2);
    const { project: retained } = await versions.load(f.w.id, f.version.id);
    const { project: rejected } = await versions.load(
      f.w.id,
      published.candidate_version_id!,
    );
    let observed = false;
    await generation.run(
      second.id,
      {
        ...generator,
        generate: async (context, baseline, _signal, sources, _readDocument, readAudit) => {
          observed = true;
          expect(baseline).toEqual(retained);
          expect(sources).toEqual([
            {
              attempt_number: 1,
              candidate_version_id: published.candidate_version_id,
              changed_steps: [
                {
                  node_id: changedNode,
                  path: rejected.node_file_map[changedNode],
                  source: rejected.files[rejected.node_file_map[changedNode]],
                },
              ],
            },
          ]);
          const prior = context.previous_attempts[0];
          const audit = prior.candidate_audit_events.find(event => event.node_id === changedNode && event.step_execution_id && event.kind === 'initial_output');
          expect(audit).toBeDefined();
          expect(await readAudit(String(audit!.id), ['output'])).toMatchObject({value: actual, truncated: false});
          await expect(readAudit(randomUUID(), [])).rejects.toMatchObject({code: 'AUDIT_ACCESS_DENIED'});
          expect(prior.candidate_traces).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                node_id: changedNode,
                output_data: actual,
              }),
            ]),
          );
          expect(context.traces).toEqual([]);
          const enlarged = {
            ...context,
            previous_attempts: context.previous_attempts.map((attempt) => ({
              ...attempt,
              candidate_traces: attempt.candidate_traces.map((trace) => ({
                ...trace,
                output_data: {
                  ...actual,
                  bulky_evidence: "packet ".repeat(100000),
                },
              })),
            })),
          };
          const prompt = repairPrompt(enlarged, baseline, sources);
          const evidence = JSON.parse(prompt);
          expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(400000);
          expect(evidence.baseline_project).toEqual(retained);
          expect(evidence.previous_candidate_sources).toEqual(sources);
          expect(
            evidence.previous_attempts[0].candidate_traces[0].output_data
              .truncated,
          ).toBe(true);
          expect(evidence.previous_attempts[0].trace_coverage).toMatchObject({
            included: 2,
            total: 2,
          });
          expect(evidence.previous_attempts[0].candidate_results).toEqual(
            prior.candidate_results,
          );
          expect(evidence.locked_cases).toEqual(
            JSON.parse(JSON.stringify(context.cases)),
          );
          expect(() =>
            repairPrompt(context, baseline, [
              {
                ...sources[0],
                changed_steps: [
                  {
                    ...sources[0].changed_steps[0],
                    source: "exact source ".repeat(40000),
                  },
                ],
              },
            ]),
          ).toThrow(/Required repair context exceeds/);
          return generator.generate(context);
        },
      },
      AbortSignal.timeout(10000),
    );
    expect(observed).toBe(true);
    expect((await repairs.state(f.w.id)).sessions[0].baseline_version_id).toBe(
      f.version.id,
    );
    const secondEvaluation = await repairs.createEvaluation(second.id);
    await record(job.id, secondEvaluation.id, { ...actual, shipment: "WRONG" });
    expect((await repairs.decide(second.id)).attempt.status).toBe("rejected");
    const third = await repairs.beginAttempt(job.id, 3);
    await generation.run(
      third.id,
      {
        ...generator,
        generate: async (context, baseline, _signal, sources) => {
          expect(context.previous_attempts).toHaveLength(2);
          expect(sources).toHaveLength(1);
          expect(sources[0].attempt_number).toBe(2);
          expect(baseline).toEqual(retained);
          expect(repairPrompt(context, baseline, sources)).toContain(
            "most recent earlier candidate only",
          );
          return generator.generate(context);
        },
      },
      AbortSignal.timeout(10000),
    );
    await repairs.finish(
      job.id,
      "cancelled",
      "Candidate evidence handoff verified.",
    );
  },
);

it("stops at three full-suite attempts and permits a deliberate new session from the retained evaluation", async () => {
  const { f, job } = await prepared();
  for (let n = 1; n <= 3; n++) {
    const c = await candidate(job.id, n, {
      shipment: "SYNTHETIC-001",
      failed_goods: 2,
    });
    const decision = await repairs.decide(c.attempt.id);
    expect(decision.session.status).toBe(
      n === 3 ? "needs_attention" : "running",
    );
  }
  await expect(repairs.beginAttempt(job.id, 4)).rejects.toMatchObject({
    code: "REPAIR_INACTIVE",
  });
  const state = await repairs.state(f.w.id);
  const restarted = await repairs.start(f.w.id, {
    request_key: randomUUID(),
    baseline_evaluation_id: state.sessions[0].baseline_evaluation_id,
  });
  expect(restarted.session.id).not.toBe(state.sessions[0].id);
  expect(state.attempts).toHaveLength(3);
});
it("fences superseded generation and makes published candidate retries idempotent", async () => {
  const { f, job } = await prepared();
  const attempt = await repairs.beginAttempt(job.id, 1);
  const releases: Array<() => void> = [];
  const slow = {
    ...generator,
    generate: async (c: Parameters<typeof generator.generate>[0]) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return generator.generate(c);
    },
  };
  const first = generation.run(attempt.id, slow, AbortSignal.timeout(10000));
  while (releases.length < 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const second = generation.run(attempt.id, slow, AbortSignal.timeout(10000));
  while (releases.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const rejected = expect(first).rejects.toMatchObject({
    code: "STALE_REPAIR_RESULT",
  });
  releases[0]();
  await rejected;
  releases[1]();
  const published = await second;
  expect(published.candidate_version_id).toBeTruthy();
  let regenerated = false;
  const replay = await generation.run(
    attempt.id,
    {
      ...generator,
      generate: async (c) => {
        regenerated = true;
        return generator.generate(c);
      },
    },
    AbortSignal.timeout(10000),
  );
  expect(replay.candidate_version_id).toBe(published.candidate_version_id);
  expect(regenerated).toBe(false);
  expect(
    (
      await db.query(
        "SELECT id FROM implementation_versions WHERE created_by_job_id=$1",
        [job.id],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await repairs.state(f.w.id)).sessions[0].baseline_version_id).toBe(
    f.version.id,
  );
});
it("cancellation closes child evaluations and late candidates cannot change the baseline", async () => {
  const { f, job } = await prepared();
  const attempt = await repairs.beginAttempt(job.id, 1);
  await generation.run(attempt.id, generator, AbortSignal.timeout(10000));
  const evaluation = await repairs.createEvaluation(attempt.id);
  await evals.prepare(job.id, evaluation.id);
  await new JobService(db).requestCancel(f.w.id, job.id);
  await repairs.finish(job.id, "cancelled", "Cancelled by engineer.");
  const state = await evals.state(f.w.id, evaluation.id);
  expect(state.runs[0].status).toBe("cancelled");
  expect(state.results.every((r) => r.outcome === "not_run")).toBe(true);
  expect((await repairs.state(f.w.id)).sessions[0]).toMatchObject({
    status: "cancelled",
    baseline_version_id: f.version.id,
  });
  await expect(
    generation.run(attempt.id, generator, AbortSignal.timeout(10000)),
  ).rejects.toMatchObject({ code: "REPAIR_INACTIVE" });
});
it("suite revisions cancel repair and require a new baseline evaluation; operational failures do not trigger code repair", async () => {
  const { f, job, suite, initial } = await prepared();
  await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Corrected suite",
    parent_suite_version_id: suite.id,
  });
  expect(
    (await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [job.id]))
      .rows[0].status,
  ).toBe("cancel_requested");
  await repairs.finish(job.id, "cancelled", "Suite changed.");
  await expect(
    repairs.start(f.w.id, {
      request_key: randomUUID(),
      baseline_evaluation_id: initial.evaluation.id,
    }),
  ).rejects.toMatchObject({ code: "SUITE_CHANGED" });
  const e = await evals.start(f.w.id, {
    request_key: randomUUID(),
    suite_version_id: suite.id,
    implementation_version_id: f.version.id,
  });
  await evals.prepare(e.job.id);
  await evals.finish(e.job.id, {
    category: "infrastructure",
    code: "UNAVAILABLE",
    message: "Sandbox unavailable",
  });
  await expect(
    repairs.start(f.w.id, {
      request_key: randomUUID(),
      baseline_evaluation_id: e.evaluation.id,
    }),
  ).rejects.toMatchObject({ code: "BASELINE_NOT_REPAIRABLE" });
  expect(
    (await resultsByEvaluation(db, initial.evaluation.id))[0].check_results[1]
      .passed,
  ).toBe(false);
});

it("reuses complete candidate bytes when an activity stops between artifact creation and publication", async () => {
  const { job } = await prepared();
  const attempt = await repairs.beginAttempt(job.id, 1);
  let calls = 0;
  const adapter = {
    ...generator,
    generate: async (c: Parameters<typeof generator.generate>[0]) => {
      calls++;
      return generator.generate(c);
    },
  };
  const publication = vi
    .spyOn(RepairService.prototype, "publishCandidate")
    .mockRejectedValueOnce(new Error("Simulated publication interruption"));
  try {
    await expect(
      generation.run(attempt.id, adapter, AbortSignal.timeout(10000)),
    ).rejects.toThrow("Simulated publication interruption");
  } finally {
    publication.mockRestore();
  }
  const recovered = await generation.run(
    attempt.id,
    adapter,
    AbortSignal.timeout(10000),
  );
  expect(recovered.candidate_version_id).toBeTruthy();
  expect(calls).toBe(1);
});


it.each([1, 3])("shares the three-read allowance across generation retries after %i reads", async (initialReads) => {
  const { job } = await prepared(true, true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  let invocation = 0;
  const adapter: RepairGenerator = {
    ...generator,
    generate: async (context, _baseline, _signal, _previous, readDocument) => {
      const id = String(context.input_inventory[0].documents[0].artifact_id);
      if (++invocation === 1) {
        for (let i = 0; i < initialReads; i++) await readDocument(id);
        throw new Error("Transient failure after inspection");
      }
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => readDocument(id)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3 - initialReads);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "REPAIR_DOCUMENT_LIMIT" });
      }
      return generator.generate(context);
    },
  };
  await expect(generation.run(attempt.id, adapter, AbortSignal.timeout(10000))).rejects.toThrow("Transient failure");
  // A new service simulates a retry on another worker, without shared memory.
  const recovered = await new RepairGenerationService(db, artifacts).run(attempt.id, adapter, AbortSignal.timeout(10000));
  expect(recovered.candidate_version_id).toBeTruthy();
  const row = (await db.query("SELECT invocation_count,document_read_count,document_byte_count FROM repair_attempts WHERE id=$1", [attempt.id])).rows[0];
  expect(row).toMatchObject({ invocation_count: 2, document_read_count: 3, document_byte_count: 3 * Buffer.byteLength("Independent source evidence") });
});

it("preserves the byte allowance after a transient generation failure", async () => {
  const bytes = Buffer.alloc(11 * 1024 * 1024);
  bytes.write("%PDF-1.7");
  const { job } = await prepared(true, bytes);
  const attempt = await repairs.beginAttempt(job.id, 1);
  let invocation = 0;
  const adapter: RepairGenerator = {
    ...generator,
    generate: async (context, _baseline, _signal, _previous, readDocument) => {
      const id = String(context.input_inventory[0].documents[0].artifact_id);
      if (++invocation === 1) {
        await readDocument(id);
        throw new Error("Transient failure after inspection");
      }
      await expect(readDocument(id)).rejects.toMatchObject({ code: "DOCUMENT_CONTEXT_TOO_LARGE" });
      return generator.generate(context);
    },
  };
  await expect(generation.run(attempt.id, adapter, AbortSignal.timeout(10000))).rejects.toThrow("Transient failure");
  await new RepairGenerationService(db, artifacts).run(attempt.id, adapter, AbortSignal.timeout(10000));
  const row = (await db.query("SELECT document_read_count,document_byte_count FROM repair_attempts WHERE id=$1", [attempt.id])).rows[0];
  expect(row).toMatchObject({ document_read_count: 2, document_byte_count: bytes.length });
});

it("fences document reads from a superseded generation invocation", async () => {
  const { f, job } = await prepared(true, true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  const first = await repairs.claimGeneration(attempt.id);
  const context = await repairs.generationContext(attempt.id);
  const id = String(context.input_inventory[0].documents[0].artifact_id);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const read = vi.fn(async () => {
    started();
    await pending;
    return artifacts.read(f.w.id, id);
  });
  const documents = new RepairDocumentReader(f.w.id, new Set([id]), { read }, AbortSignal.timeout(10000), repairDocumentBudget(db, attempt.id, first.token!));
  const inFlight = documents.read(id);
  await reading;
  await repairs.claimGeneration(attempt.id);
  const rejected = expect(inFlight).rejects.toMatchObject({ code: "STALE_REPAIR_RESULT" });
  release();
  await rejected;
  await expect(documents.read(id)).rejects.toMatchObject({ code: "STALE_REPAIR_RESULT" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(documents.inspected).toEqual([]);
  await repairs.finish(job.id, "cancelled", "Fencing verification completed");
});


it.each([1, 3])("shares audit allowance across generation retries after %i inspections", async (initialReads) => {
  const { job } = await prepared(false, false, true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  let invocation = 0;
  const adapter: RepairGenerator = {
    ...generator,
    generate: async (context, _baseline, _signal, _previous, _documents, readAudit) => {
      const id = String(context.audit_events[0].id);
      if (++invocation === 1) {
        for (let i = 0; i < initialReads; i++) await readAudit(id, []);
        throw new Error("Transient failure after audit inspection");
      }
      const results = await Promise.allSettled(Array.from({ length: 3 }, () => readAudit(id, [])));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(3 - initialReads);
      for (const result of results) {
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "AUDIT_READ_LIMIT" });
      }
      return generator.generate(context);
    },
  };
  await expect(generation.run(attempt.id, adapter, AbortSignal.timeout(10000))).rejects.toThrow("Transient failure");
  const recovered = await new RepairGenerationService(db, artifacts).run(attempt.id, adapter, AbortSignal.timeout(10000));
  expect(recovered.candidate_version_id).toBeTruthy();
  const row = (await db.query("SELECT invocation_count,audit_read_count FROM repair_attempts WHERE id=$1", [attempt.id])).rows[0];
  expect(row).toMatchObject({ invocation_count: 2, audit_read_count: 3 });
});

it("blocks audit evidence returned after an invocation is superseded", async () => {
  const { f, job } = await prepared(false, false, true);
  const attempt = await repairs.beginAttempt(job.id, 1);
  const first = await repairs.claimGeneration(attempt.id);
  const context = await repairs.generationContext(attempt.id);
  const id = String(context.audit_events[0].id);
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  const read = vi.fn(async () => {
    started();
    await pending;
    return new ExecutionAuditService(db, artifacts).read(f.w.id, id);
  });
  const reader = new RepairAuditReader(f.w.id, new Set([id]), { read }, AbortSignal.timeout(10000), repairAuditBudget(db, attempt.id, first.token!));
  const inFlight = reader.read(id, []);
  await reading;
  await repairs.claimGeneration(attempt.id);
  const rejected = expect(inFlight).rejects.toMatchObject({ code: "STALE_REPAIR_RESULT" });
  release();
  await rejected;
  await expect(reader.read(id, [])).rejects.toMatchObject({ code: "STALE_REPAIR_RESULT" });
  expect(read).toHaveBeenCalledTimes(1);
  expect(reader.inspected).toEqual([]);
  await repairs.finish(job.id, "cancelled", "Audit fencing verified");
});
