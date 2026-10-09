import { checkRecoveryBuild } from "../src/server/repairs/recovery-build";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { caseInput } from "../src/domain/evaluation";
import type { Json } from "../src/domain/runtime";
import { RecoveryBudget } from "../src/server/repairs/recovery-budget";
import { withInferenceBudget } from "../src/server/integrations/inference-budget";
import { meteredOpenAIFetch } from "../src/server/integrations/openai-client";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { runtimeFixture } from "./fixtures/runtime";
import { RunRecoveryService } from "../src/server/repairs/run-recovery-service";
import { RepairService } from "../src/server/repairs/service";
import { RepairGenerationService } from "../src/server/repairs/generation-service";
import { fixtureSources } from "./fixtures/engineer";
import { recoveryEligibility } from "../src/domain/run-recovery";
import { JobService } from "../src/server/engineering/job-service";
import { VersionService } from "../src/server/engineering/version-service";
import { StepService } from "../src/server/runtime/step-service";
import { RuntimeEngine } from "../src/domain/runtime-engine";
import { runById } from "../src/server/runtime/store";
let db: Database, artifacts: ArtifactService, directory: string;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated persistence.");
  db = await createDatabase(url);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-recovery-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function failed() {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, {
    status: "failed",
    error: {
      category: "implementation",
      code: "EXTRACTION_EVIDENCE_INVALID",
      message:
        "A field path points to an object instead of the normalized scalar.",
    },
  });
  const repairs = new RepairService(db),
    recovery = new RunRecoveryService(db);
  const { job, session } = await recovery.start(f.w.id, f.run.id, {
    request_key: randomUUID(),
  });
  await repairs.prepare(job.id);
  return { ...f, repairJob: job, session, repairs, recovery };
}
async function candidate(f: Awaited<ReturnType<typeof failed>>, number = 1) {
  const attempt = await f.repairs.beginAttempt(f.repairJob.id, number);
  await new RepairGenerationService(db, artifacts).run(
    attempt.id,
    {
      model: "fixture",
      generate: async (c) => ({
        diagnosis: {
          summary:
            "Preserve the extracted scalar and point evidence at its value.",
          affected_node_ids: c.steps.map((s) => s.node_id),
          changes: ["Correct the evidence path without bypassing validation."],
        },
        project: (() => {
          const source = fixtureSources(c.spec.board, c.steps);
          source.steps.forEach((s) =>
            s.source_lines.push(`// Candidate ${number}`),
          );
          return source;
        })(),
      }),
    },
    AbortSignal.timeout(10000),
  );
  const runId = await f.recovery.createRerun(attempt.id);
  return { attempt, runId };
}
it("automatically creates exactly one recovery operation and pins its original input", async () => {
  const f = await failed();
  const again = await f.recovery.start(f.w.id, f.run.id, {
    request_key: randomUUID(),
  });
  expect(again.session.id).toBe(f.session.id);
  expect(again.session.input_bundle_id).toBe(f.bundle.id);
  expect(again.session.suite_version_id).toBeNull();
  await f.runs.finish(f.job.id, {
    status: "failed",
    error: {
      category: "implementation",
      code: "OTHER",
      message: "duplicate completion",
    },
  });
  expect(
    (
      await db.query("SELECT id FROM repair_sessions WHERE source_run_id=$1", [
        f.run.id,
      ])
    ).rows,
  ).toHaveLength(1);
  await expect(
    f.runs.start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      input_bundle_id: String(f.bundle.id),
      rerun_of_id: null,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_ACTIVE" });
  await f.repairs.finish(f.repairJob.id, "cancelled", "Test complete");
});
it("does not repair business failures, missing input, operational errors, or internal runs", () => {
  expect(
    recoveryEligibility({
      kind: "manual",
      status: "completed",
      failure_category: null,
    }).eligible,
  ).toBe(false);
  for (const failure_category of [
    "input",
    "infrastructure",
    "unknown",
  ] as const)
    expect(
      recoveryEligibility({
        kind: "manual",
        status: "failed",
        failure_category,
      }).eligible,
    ).toBe(false);
  expect(
    recoveryEligibility({
      kind: "recovery",
      status: "failed",
      failure_category: "implementation",
    }).eligible,
  ).toBe(false);
});
it("publishes an unverified manual default after an actual rerun without inventing a suite", async () => {
  const f = await failed(),
    { attempt, runId } = await candidate(f);
  await completeRerun(f, runId);
  expect((await runById(db, runId)).status).toBe("completed");
  expect(await f.recovery.regressionEvaluation(attempt.id)).toBeNull();
  expect(await f.recovery.decide(attempt.id)).toEqual({ done: true });
  const state = await f.repairs.state(f.w.id, f.session.id);
  expect(state.sessions[0].status).toBe("recovered");
  expect(state.sessions[0].stop_reason).toContain(
    "business results not yet verified",
  );
  expect(
    (
      await db.query(
        "SELECT implementation_version_id FROM workflow_run_defaults WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows[0].implementation_version_id,
  ).toBe(state.attempts[0].candidate_version_id);
  expect(
    (
      await db.query(
        "SELECT id FROM evaluation_suite_versions WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query("SELECT id FROM repair_sessions WHERE workflow_id=$1", [
        f.w.id,
      ])
    ).rows,
  ).toHaveLength(1);
});
it("retains failed reruns without recursively recovering and rejects writes after cancellation", async () => {
  const f = await failed(),
    { attempt, runId } = await candidate(f);
  await f.runs.prepareCase(runId);
  await f.runs.finishCase(runId, {
    status: "failed",
    error: {
      category: "implementation",
      code: "STILL_INVALID",
      message: "The contract still fails.",
    },
  });
  expect(await f.recovery.decide(attempt.id)).toEqual({ done: false });
  expect(
    (
      await db.query("SELECT id FROM repair_sessions WHERE workflow_id=$1", [
        f.w.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect((await f.repairs.state(f.w.id)).attempts[0].status).toBe("rejected");
  const runState = await f.runs.state(f.w.id);
  expect(runState.manual_default).toBeNull();
  expect(runState.initial_manual_version_id).toBe(f.version.id);
  await new JobService(db).requestCancel(f.w.id, f.repairJob.id);
  await expect(f.repairs.beginAttempt(f.repairJob.id, 2)).rejects.toMatchObject(
    { code: "REPAIR_INACTIVE" },
  );
  await f.repairs.finish(f.repairJob.id, "cancelled", "Canceled");
  expect((await f.repairs.state(f.w.id)).sessions[0].status).toBe("cancelled");
});

it("keeps spend holds across worker instances and serializes competing reservations", async () => {
  const f = await failed();
  const first = new RecoveryBudget(db, f.session.id);
  const held = await first.reserve("openai", 3, { request_sha256: "fixture" });
  const restarted = new RecoveryBudget(db, f.session.id);
  await expect(restarted.reserve("openai", 3, {})).rejects.toMatchObject({
    code: "INFERENCE_BUDGET_LIMIT",
  });
  await held.settle(1, { input_tokens: 10 });
  const concurrent = await Promise.allSettled([
    first.reserve("openai", 3, {}),
    restarted.reserve("openai", 3, {}),
  ]);
  expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(concurrent.filter((r) => r.status === "rejected")).toHaveLength(1);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Canceled");
  await expect(first.reserve("openai", 0.1, {})).rejects.toMatchObject({
    code: "RECOVERY_INACTIVE",
  });
  // Completion of already-billed work can still settle its hold after cancellation.
  const winner = concurrent.find((r) => r.status === "fulfilled")!;
  if (winner.status === "fulfilled") await winner.value.settle(0.2);
});
it("applies the scoped spend ceiling to model fetches before making the paid request", async () => {
  const f = await failed();
  const budget = new RecoveryBudget(db, f.session.id);
  await budget.reserve("openai", 4.95, {});
  let paid = 0;
  const fetcher = meteredOpenAIFetch(async (input) => {
    if (String(input).includes("input_tokens"))
      return Response.json({ input_tokens: 1000 });
    paid++;
    return Response.json({
      id: "unused",
      usage: { input_tokens: 1000, output_tokens: 10000 },
    });
  });
  await expect(
    withInferenceBudget(budget, () =>
      fetcher("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5.4",
          max_output_tokens: 10000,
          input: "fixture",
        }),
      }),
    ),
  ).rejects.toMatchObject({ code: "INFERENCE_BUDGET_LIMIT" });
  expect(paid).toBe(0);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Test complete");
});
it("cancels an unfinished recovery rerun durably and blocks a late completion", async () => {
  const f = await failed(),
    { runId } = await candidate(f);
  await f.runs.prepareCase(runId);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Canceled");
  expect((await runById(db, runId)).status).toBe("cancelled");
  await f.runs.finishCase(runId, {
    status: "failed",
    error: { category: "implementation", code: "LATE", message: "Late worker" },
  });
  expect((await runById(db, runId)).status).toBe("cancelled");
});

async function completeRerun(
  f: Awaited<ReturnType<typeof failed>>,
  runId: string,
) {
  await checkRecoveryBuild(
    db,
    runId,
    async () => ({ engine: "fixture" }),
    AbortSignal.timeout(10000),
    new VersionService(db, artifacts),
  );
  const context = (await f.runs.prepareCase(runId))!;
  const steps = new StepService(
    db,
    new VersionService(db, artifacts),
    artifacts,
  );
  const engine = new RuntimeEngine(runId, context.definition, {
    now: () => Date.now(),
    changed() {},
    step: (data, resume) =>
      steps.execute(
        data,
        {
          invoke: async (_project, nodeId) => ({
            kind: "complete",
            output: {
              business_failed: true,
              reason: "Required certificate absent",
            },
            matching_connection_ids: f.board.connections
              .filter((e) => e.source_node_id === nodeId)
              .map((e) => e.id),
          }),
          reason: async () => ({}),
        },
        AbortSignal.timeout(10000),
        resume,
      ),
    human: async () => {},
    project: (p) => f.runs.project(runId, p),
  });
  await f.runs.finishCase(runId, await engine.run());
}
async function recordEvaluation(
  jobId: string,
  evaluationId: string,
  actual: Json,
) {
  const evals = new EvaluationService(db);
  const ready = (await evals.prepare(jobId, evaluationId))!;
  for (const result of ready.results) {
    await evals.beginCase(result.id);
    await evals.recordCase(result.id, { actual });
  }
  await evals.finish(jobId, undefined, false, evaluationId);
}
async function withSuite() {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const suites = new SuiteService(db),
    evals = new EvaluationService(db);
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Independent counting rules",
    parent_suite_version_id: null,
  });
  const item = await suites.addCase(
    f.w.id,
    suite.id,
    caseInput.parse({
      case_key: "quantity",
      name: "Count each item once",
      kind: "step",
      node_id: f.nodes[1].id,
      input_data: { input: { items: [{ id: "a" }] }, steps: {} },
      assertions: [
        { key: "count", label: "One item", path: ["count"], expected: 1 },
        {
          key: "complete",
          label: "Processed",
          path: ["complete"],
          expected: true,
        },
      ],
    }),
  );
  await suites.verifyCase(f.w.id, suite.id, item.id, {
    expected_revision: item.revision,
  });
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const baseline = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  });
  await recordEvaluation(baseline.job.id, baseline.evaluation.id, {
    count: 1,
    complete: false,
  });
  const started = await f.runs.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(f.bundle.id),
    rerun_of_id: null,
  });
  await f.runs.prepare(started.job.id);
  await f.runs.finish(started.job.id, {
    status: "failed",
    error: {
      category: "implementation",
      code: "CONTRACT_INVALID",
      message: "Output contract failed.",
    },
  });
  const recovery = new RunRecoveryService(db),
    repairs = new RepairService(db);
  const { job, session } = await recovery.start(f.w.id, started.run.id, {
    request_key: randomUUID(),
  });
  await repairs.prepare(job.id);
  return {
    ...f,
    run: started.run,
    job: started.job,
    recovery,
    repairs,
    repairJob: job,
    session,
    suite,
    baseline,
  };
}
it("accepts recovery with an existing failed assertion only after one full comparable regression run", async () => {
  const f = await withSuite();
  expect(f.session.baseline_evaluation_id).toBe(f.baseline.evaluation.id);
  expect(await f.recovery.baselineEvaluation(f.repairJob.id)).toBeNull();
  const { attempt, runId } = await candidate(f);
  await completeRerun(f, runId);
  await expect(f.recovery.decide(attempt.id)).rejects.toMatchObject({
    code: "REGRESSION_REQUIRED",
  });
  const regression = await f.recovery.regressionEvaluation(attempt.id);
  await recordEvaluation(f.repairJob.id, regression!, {
    count: 1,
    complete: false,
  });
  expect(await f.recovery.decide(attempt.id)).toEqual({ done: true });
  const state = await f.recovery.state(f.w.id, runId);
  expect(state?.session.status).toBe("recovered");
  expect(state?.session.stop_reason).toContain("not yet verified");
  expect(
    (
      await db.query("SELECT id FROM evaluation_runs WHERE job_id=$1", [
        f.repairJob.id,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.query(
        "SELECT attempt_id FROM repair_confirmations WHERE attempt_id=$1",
        [attempt.id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("rejects regressions and gives the next attempt the retained baseline and exact failed assertions", async () => {
  const f = await withSuite(),
    { attempt, runId } = await candidate(f);
  await completeRerun(f, runId);
  const regression = await f.recovery.regressionEvaluation(attempt.id);
  await recordEvaluation(f.repairJob.id, regression!, {
    count: 2,
    complete: true,
  });
  expect(await f.recovery.decide(attempt.id)).toEqual({ done: false });
  const next = await f.repairs.beginAttempt(f.repairJob.id, 2);
  expect(next.baseline_version_id).toBe(f.version.id);
  const context = await f.repairs.generationContext(next.id);
  expect(context.previous_attempts[0].candidate_results).toHaveLength(1);
  expect(
    JSON.stringify(context.previous_attempts[0].candidate_results),
  ).toContain('"passed":false');
  expect(
    (
      await db.query(
        "SELECT * FROM workflow_run_defaults WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Test complete");
});

it("diagnoses a real extraction-contract rejection from persisted model audit and reruns with evidence validation intact", async () => {
  const f = await runtimeFixture(
    db,
    artifacts,
    ["trigger", "information", "outcome"],
    {
      name: "Supplier registration review",
      desired_outcome:
        "Preserve the registration value and its supporting source",
      instructions: {
        information: "Read the registration field and cite its source.",
      },
      methods: { information: "agent" },
    },
  );
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const { BundleService } = await import(
    "../src/server/runtime/bundle-service"
  );
  const doc = await artifacts.create(
    f.w.id,
    "source_document",
    "registration.txt",
    "text/plain",
    Buffer.from("Registration: REG-204"),
  );
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: "fixture",
    shipment_reference: "REGISTRATION-FIXTURE",
    manifest: {
      input: {
        documents: [
          {
            artifact_id: doc.id,
            name: doc.display_name,
            media_type: doc.media_type,
            byte_size: doc.byte_size,
          },
        ],
      },
      artifacts: [
        { artifact_id: doc.id, name: doc.display_name, message_id: null },
      ],
      message_ids: [],
    },
  });
  const started = await f.runs.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(bundle.id),
    rerun_of_id: null,
  });
  const context = (await f.runs.prepare(started.job.id))!;
  const service = new StepService(
    db,
    new VersionService(db, artifacts),
    artifacts,
  );
  // Known fixture adapters simulate generated-step calls; all host contracts,
  // document loading, audit persistence and runtime routing execute for real.
  const adapter = (corrected: boolean) => ({
    invoke: async (
      _project: unknown,
      nodeId: string,
      c: Record<string, Json>,
    ) =>
      nodeId === f.nodes[1].id && !Object.hasOwn(c, "tool_result")
        ? {
            kind: "extract",
            instructions: "Read registration and cite its normalized value.",
            data: {},
            document_ids: [doc.id],
            output_schema: { type: "object" },
            critical_paths: [
              ["registration", ...(corrected ? ["normalized"] : [])],
            ],
          }
        : {
            kind: "complete",
            output: c.tool_result ?? c.input,
            matching_connection_ids: f.board.connections
              .filter((e) => e.source_node_id === nodeId)
              .map((e) => e.id),
          },
    reason: async () => ({}),
    extract: async () => ({
        data: {
          registration: {
            status: "found",
            raw: "REG-204",
            normalized: "REG-204",
          },
        },
        fields: [
          {
            path: ["registration", ...(corrected ? ["normalized"] : [])],
            status: "found",
            raw_value: "REG-204",
            normalized_value: "REG-204",
            explanation: null,
            evidence: [
              { artifact_id: doc.id, page: 1, text: "Registration: REG-204" },
            ],
          },
        ],
    }),
  });
  async function execute(
    runId: string,
    definition: typeof context.definition,
    corrected: boolean,
  ) {
    const engine = new RuntimeEngine(runId, definition, {
      now: () => Date.now(),
      changed() {},
      project: (p) => f.runs.project(runId, p),
      human: async () => {},
      step: (data, resume) =>
        service.execute(
          data,
          adapter(corrected),
          AbortSignal.timeout(10000),
          resume,
        ),
    });
    return engine.run();
  }
  await f.runs.finish(
    started.job.id,
    await execute(started.run.id, context.definition, false),
  );
  expect((await runById(db, started.run.id)).failure_code).toBe(
    "EXTRACTION_EVIDENCE_INVALID",
  );
  const recovery = new RunRecoveryService(db),
    repairs = new RepairService(db);
  const { job, session } = await recovery.start(f.w.id, started.run.id, {
    request_key: randomUUID(),
  });
  await repairs.prepare(job.id);
  const attempt = await repairs.beginAttempt(job.id, 1);
  const evidence = await repairs.generationContext(attempt.id);
  expect(evidence.audit_events.some((e) => e.kind === "model_response")).toBe(
    true,
  );
  expect(evidence.audit_events.some((e) => e.kind === "failure")).toBe(true);
  await new RepairGenerationService(db, artifacts).run(
    attempt.id,
    {
      model: "fixture",
      generate: async (
        c,
        _baseline,
        _signal,
        _previous,
        _readDocument,
        readAudit,
      ) => {
        const failure = c.audit_events.find((e) => e.kind === "failure")!;
        const inspected = await readAudit(String(failure.id), []);
        expect(JSON.stringify(inspected)).toContain(
          "EXTRACTION_EVIDENCE_INVALID",
        );
        const project = fixtureSources(c.spec.board, c.steps);
        project.steps.forEach((s) =>
          s.source_lines.push(
            "// Point registration evidence at its normalized scalar.",
          ),
        );
        return {
          diagnosis: {
            summary:
              "Registration evidence points to the enclosing object; it must reference its normalized scalar.",
            affected_node_ids: c.steps.map((s) => s.node_id),
            changes: [
              "Use the normalized scalar path while retaining raw text and citations.",
            ],
          },
          project,
        };
      },
    },
    AbortSignal.timeout(10000),
  );
  const rerunId = await recovery.createRerun(attempt.id);
  await checkRecoveryBuild(
    db,
    rerunId,
    async () => ({ engine: "fixture" }),
    AbortSignal.timeout(10000),
    new VersionService(db, artifacts),
  );
  const rerun = (await f.runs.prepareCase(rerunId))!;
  await f.runs.finishCase(
    rerunId,
    await execute(rerunId, rerun.definition, true),
  );
  expect(await runById(db, rerunId)).toMatchObject({ status: "completed", failure_message: null });
  expect(await recovery.decide(attempt.id)).toEqual({ done: true });
  expect((await recovery.state(f.w.id, rerunId))?.session.status).toBe(
    "recovered",
  );
  expect(session.input_bundle_id).toBe(bundle.id);
  // Original rejection and supporting source remain intact after acceptance.
  expect((await runById(db, started.run.id)).status).toBe("failed");
});

it("stops at three unsuccessful repairs without promoting any candidate", async () => {
  const f = await failed();
  for (let number = 1; number <= 3; number++) {
    const { attempt, runId } = await candidate(f, number);
    await f.runs.prepareCase(runId);
    await f.runs.finishCase(runId, {
      status: "failed",
      error: {
        category: "implementation",
        code: "CONTRACT_INVALID",
        message: "Contract remains invalid.",
      },
    });
    expect(await f.recovery.decide(attempt.id)).toEqual({ done: number === 3 });
  }
  const state = await f.recovery.state(f.w.id, f.run.id);
  expect(state?.session.status).toBe("needs_attention");
  expect(state?.attempts).toHaveLength(3);
  await expect(f.repairs.beginAttempt(f.repairJob.id, 4)).rejects.toMatchObject(
    { code: "REPAIR_INACTIVE" },
  );
  expect(
    (
      await db.query(
        "SELECT * FROM workflow_run_defaults WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("excludes persisted human waiting from recovery time without resetting attempts", async () => {
  const f = await failed(),
    { runId } = await candidate(f);
  await f.runs.prepareCase(runId);
  const before = (
    await db.query("SELECT deadline_at FROM workflow_jobs WHERE id=$1", [
      f.repairJob.id,
    ])
  ).rows[0].deadline_at;
  await f.runs.project(runId, {
    sequence: 1,
    status: "waiting_for_human",
    scheduled_step_attempts: 1,
    active_elapsed_ms: 100,
    active_since: null,
  });
  await db.query(
    "UPDATE repair_sessions SET paused_at=now()-interval '10 minutes' WHERE id=$1",
    [f.session.id],
  );
  await f.runs.project(runId, {
    sequence: 2,
    status: "running",
    scheduled_step_attempts: 1,
    active_elapsed_ms: 100,
    active_since: new Date().toISOString(),
  });
  const after = (
    await db.query("SELECT deadline_at FROM workflow_jobs WHERE id=$1", [
      f.repairJob.id,
    ])
  ).rows[0].deadline_at;
  expect(
    new Date(String(after)).getTime() - new Date(String(before)).getTime(),
  ).toBeGreaterThanOrEqual(599000);
  expect(
    (
      await db.query("SELECT paused_at FROM repair_sessions WHERE id=$1", [
        f.session.id,
      ])
    ).rows[0].paused_at,
  ).toBeNull();
  expect((await f.repairs.state(f.w.id)).attempts).toHaveLength(1);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Test complete");
});
it("retains a syntax failure and its diagnostic without executing the broken candidate", async () => {
  const { DomainError } = await import("../src/domain/errors");
  const f = await failed(),
    { attempt, runId } = await candidate(f);
  const build = await checkRecoveryBuild(
    db,
    runId,
    async () => {
      throw new DomainError(422, "PROJECT_BUILD_FAILED", "Invalid syntax", {
        diagnostic: "Unexpected token in steps/extract.mjs",
      });
    },
    AbortSignal.timeout(10000),
    new VersionService(db, artifacts),
  );
  expect(build.ok).toBe(false);
  if (build.ok) throw new Error("Expected failed build");
  expect(build.error.message).toContain("Unexpected token");
  await f.runs.finishCase(runId, { status: "failed", error: build.error });
  expect(await f.recovery.decide(attempt.id)).toEqual({ done: false });
  expect(
    (await db.query("SELECT id FROM step_executions WHERE run_id=$1", [runId]))
      .rows,
  ).toHaveLength(0);
  await f.repairs.finish(f.repairJob.id, "cancelled", "Test complete");
});

it("reports missing saved source as an operational blocker without exposing storage paths", async () => {
  const f = await failed();
  const unavailable = new ArtifactService(db, {
    backend: "local",
    write: async () => {},
    read: async () => {
      throw new Error("ENOENT /private/location/payload");
    },
  });
  await expect(
    unavailable.read(f.w.id, f.version.artifact_id),
  ).rejects.toMatchObject({
    code: "ARTIFACT_UNAVAILABLE",
    message:
      "The saved file is unavailable. Check the configured artifact storage location and access before retrying.",
  });
  await f.repairs.finish(
    f.repairJob.id,
    "needs_attention",
    "Storage requires configuration",
  );
});
