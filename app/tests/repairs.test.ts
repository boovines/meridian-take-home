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
import { RepairService } from "../src/server/repairs/service";
import { RepairGenerationService } from "../src/server/repairs/generation-service";
import { JobService } from "../src/server/engineering/job-service";
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
      affected_node_ids: [c.steps.at(-1)!.node_id],
      changes: ["Count goods once per good."],
    },
    project: fixtureSources(c.spec.board, c.steps),
  }),
};
async function record(jobId: string, evaluationId: string, actual: Json) {
  const ready = (await evals.prepare(jobId, evaluationId))!;
  for (const result of ready.results) {
    await evals.beginCase(result.id);
    await evals.recordCase(result.id, { actual });
  }
  await evals.finish(jobId, undefined, false, evaluationId);
}
async function prepared() {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
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
  });
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
      expect.objectContaining({ key: "shipment", passed: false, actual: "WRONG" }),
    ]),
  });
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
