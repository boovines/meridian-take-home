import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { VersionService } from "../src/server/engineering/version-service";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { EvaluationExecutionService } from "../src/server/evaluations/execution-service";
import { answerScriptedHuman } from "../src/server/evaluations/scripted-human";
import { HumanService } from "../src/server/runtime/human-service";
import { RunService } from "../src/server/runtime/run-service";
import { StepService } from "../src/server/runtime/step-service";
import { RuntimeEngine } from "../src/domain/runtime-engine";
import { caseInput } from "../src/domain/evaluation";
import { runtimeFixture } from "./fixtures/runtime";
import { BundleService } from "../src/server/runtime/bundle-service";
let db: Database,
  artifacts: ArtifactService,
  versions: VersionService,
  suites: SuiteService,
  evals: EvaluationService,
  execution: EvaluationExecutionService,
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
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-evaluation-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  versions = new VersionService(db, artifacts);
  suites = new SuiteService(db);
  evals = new EvaluationService(db);
  execution = new EvaluationExecutionService(db, versions, artifacts);
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function prepared() {
  const f = await runtimeFixture(db, artifacts);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Verified cases",
    parent_suite_version_id: null,
  });
  const cases = [];
  for (const [key, expected, human] of [
    ["passes", "SYNTHETIC-001", true],
    ["fails", "WRONG", true],
    ["missing-response", "SYNTHETIC-001", false],
  ] as const) {
    let c = await suites.addCase(
      f.w.id,
      suite.id,
      caseInput.parse({
        case_key: key,
        name: key,
        kind: "workflow",
        input_bundle_id: f.bundle.id,
        human_responses: human
          ? [
              {
                node_id: f.nodes[1].id,
                node_visit_number: 1,
                response: {
                  type: "approval",
                  approved: true,
                  text: "Verified",
                },
              },
            ]
          : [],
        assertions: [
          {
            key: "shipment",
            label: "Shipment identity",
            path: ["shipment"],
            expected,
          },
        ],
      }),
    );
    c = await suites.verifyCase(f.w.id, suite.id, c.id, {
      expected_revision: c.revision,
    });
    cases.push(c);
  }
  let step = await suites.addCase(
    f.w.id,
    suite.id,
    caseInput.parse({
      case_key: "isolated",
      name: "Independent step",
      kind: "step",
      node_id: f.nodes[2].id,
      input_data: { input: { shipment: "SYNTHETIC-001" }, steps: {} },
      assertions: [
        {
          key: "shipment",
          label: "Shipment identity",
          path: ["shipment"],
          expected: "SYNTHETIC-001",
        },
      ],
    }),
  );
  step = await suites.verifyCase(f.w.id, suite.id, step.id, {
    expected_revision: step.revision,
  });
  cases.push(step);
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const request = {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  };
  const launched = await evals.start(f.w.id, request);
  expect((await evals.start(f.w.id, request)).job.id).toBe(launched.job.id);
  const ready = (await evals.prepare(launched.job.id))!;
  return { f, suite, cases, ...launched, ...ready };
}
it("records a full suite with independent passes, assertion failures and execution errors", async () => {
  const { f, job, evaluation, results } = await prepared();
  expect(results).toHaveLength(4); // all cases accounted for before any invocation
  const adapters = {
    invoke: async (
      _p: unknown,
      id: string,
      context: Record<string, unknown>,
    ) => ({
      kind: "complete",
      output: context.input,
      matching_connection_ids: f.board.connections
        .filter((e) => e.source_node_id === id)
        .map((e) => e.id),
    }),
    reason: async () => ({}),
  };
  const runs = new RunService(db),
    steps = new StepService(db, versions, artifacts);
  for (const result of results) {
    const task = await evals.beginCase(result.id);
    if (task.skip) throw new Error();
    if (task.kind === "step") {
      await execution.step(result.id, adapters, AbortSignal.timeout(10000));
      continue;
    }
    const context = (await runs.prepareCase(task.run_id))!;
    const engine = new RuntimeEngine(task.run_id, context.definition, {
      now: () => Date.now(),
      scriptedHuman: true,
      changed() {},
      project: (p) => runs.project(task.run_id, p),
      step: (data, resume) =>
        steps.execute(data, adapters, AbortSignal.timeout(10000), resume),
      human: async (id) => {
        await expect(
          new HumanService(db).answer(f.w.id, id, {
            request_key: randomUUID(),
            response: {
              type: "approval",
              approved: true,
              text: "Untrusted live override",
            },
          }),
        ).rejects.toMatchObject({ code: "SCRIPTED_RESPONSE_REQUIRED" });
        const response = await answerScriptedHuman(db, task.run_id, id);
        if (!response.ok)
          throw new Error(`MISSING_HUMAN_FIXTURE: ${response.message}`);
      },
    });
    await runs.finishCase(task.run_id, await engine.run());
    await execution.workflow(result.id);
    expect(
      (await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [job.id]))
        .rows[0].status,
    ).toBe("running");
  }
  await evals.finish(job.id);
  const manual = await new RunService(db).state(f.w.id, undefined, "manual");
  expect(manual.runs).toHaveLength(1);
  expect(manual.runs[0].id).toBe(f.run.id);
  expect((await new RunService(db).state(f.w.id)).runs.length).toBeGreaterThan(
    1,
  );
  const state = await evals.state(f.w.id, evaluation.id);
  expect(state.runs[0]).toMatchObject({
    status: "completed",
    verdict: "inconclusive",
  });
  expect(state.results.map((r) => r.outcome).sort()).toEqual([
    "error",
    "failed",
    "passed",
    "passed",
  ]);
  await expect(
    db.query(
      "UPDATE evaluation_case_results SET outcome='passed' WHERE evaluation_run_id=$1",
      [evaluation.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.query("UPDATE evaluation_runs SET verdict='passed' WHERE id=$1", [
      evaluation.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
});
it("a shared build blocker preserves coverage and marks unrun cases without inventing failures", async () => {
  const { f, job, evaluation } = await prepared();
  await evals.finish(job.id, {
    code: "PROJECT_BUILD_FAILED",
    message: "Syntax invalid",
    category: "implementation",
  });
  const state = await evals.state(f.w.id, evaluation.id);
  expect(state.runs[0]).toMatchObject({
    status: "blocked",
    verdict: "inconclusive",
  });
  expect(state.results).toHaveLength(4);
  expect(
    state.results.every(
      (r) => r.outcome === "not_run" && r.check_results.length === 0,
    ),
  ).toBe(true);
});
it("the database rejects workflow cases executed against different captured inputs", async () => {
  const { f, job, results } = await prepared();
  const changed = await new BundleService(db).create(f.w.id, {
    source_kind: "fixture",
    shipment_reference: null,
    manifest: { input: { changed: true }, message_ids: [], artifacts: [] },
  });
  await expect(
    db.query(
      "INSERT INTO workflow_runs(workflow_id,job_id,implementation_version_id,input_bundle_id,kind,evaluation_case_result_id,limits) VALUES($1,$2,$3,$4,'evaluation',$5,$6)",
      [
        f.w.id,
        job.id,
        f.version.id,
        changed.id,
        results[0].id,
        { step_attempts: 100, active_ms: 900000 },
      ],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});

it("a superseded step invocation cannot publish an older result", async () => {
  const { results } = await prepared();
  let resultId = "";
  for (const result of results) {
    const task = await evals.beginCase(result.id);
    if (!task.skip && task.kind === "step") resultId = result.id;
  }
  const releases: Array<(value: unknown) => void> = [];
  const adapters = {
    invoke: async () =>
      new Promise<unknown>((resolve) => releases.push(resolve)),
    reason: async () => ({}),
  };
  const first = execution.step(resultId, adapters, AbortSignal.timeout(10000));
  while (releases.length < 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const second = execution.step(resultId, adapters, AbortSignal.timeout(10000));
  while (releases.length < 2)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const rejected = expect(first).rejects.toMatchObject({
    code: "STALE_EVALUATION_RESULT",
  });
  releases[0]({
    kind: "complete",
    output: { shipment: "WRONG" },
    matching_connection_ids: [],
  });
  await rejected;
  releases[1]({
    kind: "complete",
    output: { shipment: "SYNTHETIC-001" },
    matching_connection_ids: [],
  });
  await second;
  const row = (
    await db.query("SELECT * FROM evaluation_case_results WHERE id=$1", [
      resultId,
    ])
  ).rows[0];
  expect(row.outcome).toBe("passed");
  expect(row.invocation_count).toBe(2);
});

it("cancelling an evaluation settles queued child runs and fences later case publication", async () => {
  const { f, job, evaluation, results } = await prepared();
  let task = await evals.beginCase(results[0].id);
  if (task.skip || task.kind !== "workflow") {
    for (const result of results) {
      task = await evals.beginCase(result.id);
      if (!task.skip && task.kind === "workflow") break;
    }
  }
  if (task.skip || task.kind !== "workflow")
    throw new Error("Expected a workflow case");
  await evals.finish(job.id, undefined, true);
  expect((await f.runs.state(f.w.id, task.run_id)).runs[0].status).toBe(
    "cancelled",
  );
  const state = await evals.state(f.w.id, evaluation.id);
  expect(state.runs[0]).toMatchObject({
    status: "cancelled",
    verdict: "inconclusive",
  });
  expect(state.results.every((r) => r.outcome === "not_run")).toBe(true);
  const late = await evals.recordCase(results[0].id, {
    actual: { shipment: "SYNTHETIC-001" },
  });
  expect(late.outcome).toBe("not_run");
});

it("isolated Agent cases read only their captured bundle and override mutable fixture input", async () => {
  const f = await runtimeFixture(
    db,
    artifacts,
    ["trigger", "task", "outcome"],
    {
      name: "Evidence",
      desired_outcome: "Extract seller",
      instructions: { task: "Read seller" },
      methods: { task: "agent" },
    },
  );
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const doc = await artifacts.create(
    f.w.id,
    "source_document",
    "seller.txt",
    "text/plain",
    Buffer.from("Seller: Example Ltd"),
  );
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: "fixture",
    shipment_reference: null,
    manifest: {
      input: { seller_source: doc.id },
      message_ids: [],
      artifacts: [
        { artifact_id: doc.id, name: "seller.txt", message_id: null },
      ],
    },
  });
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Source verified",
    parent_suite_version_id: null,
  });
  const c = await suites.addCase(
    f.w.id,
    suite.id,
    caseInput.parse({
      case_key: "extract",
      name: "Extract seller",
      kind: "step",
      node_id: f.nodes[1].id,
      input_bundle_id: bundle.id,
      input_data: {
        input: { untrusted: "must not replace captured input" },
        steps: {},
      },
      assertions: [
        {
          key: "seller",
          label: "Printed seller",
          path: ["seller"],
          expected: "Example Ltd",
        },
      ],
    }),
  );
  await suites.verifyCase(f.w.id, suite.id, c.id, {
    expected_revision: c.revision,
  });
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const started = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  });
  const ready = (await evals.prepare(started.job.id))!;
  await evals.beginCase(ready.results[0].id);
  let contextInput: unknown;
  await execution.step(
    ready.results[0].id,
    {
      invoke: async (_p, _n, context) => {
        contextInput = context.input;
        return context.tool_result
          ? {
              kind: "complete",
              output: context.tool_result,
              matching_connection_ids: f.board.connections
                .filter((e) => e.source_node_id === f.nodes[1].id)
                .map((e) => e.id),
            }
          : {
              kind: "extract",
              instructions: "Extract seller",
              data: {},
              document_ids: [doc.id],
              output_schema: { type: "object" },
              critical_paths: [["seller"]],
            };
      },
      reason: async () => ({}),
      extract: async (_request, documents) => {
        expect(documents[0].bytes.toString()).toBe("Seller: Example Ltd");
        return {
          metadata: { provider: "fixture" },
          output: {
            data: { seller: "Example Ltd" },
            fields: [
              {
                path: ["seller"],
                raw_value: "Example Ltd",
                normalized_value: "Example Ltd",
                status: "found",
                explanation: null,
                evidence: [
                  { artifact_id: doc.id, page: 1, text: "Seller: Example Ltd" },
                ],
              },
            ],
          },
        };
      },
    },
    AbortSignal.timeout(10000),
  );
  expect(contextInput).toEqual({ seller_source: doc.id });
  await evals.finish(started.job.id);
  expect(
    (await evals.state(f.w.id, started.evaluation.id)).results[0].outcome,
  ).toBe("passed");
});
