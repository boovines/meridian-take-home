import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { runtimeFixture } from "./fixtures/runtime";
import { caseInput } from "../src/domain/evaluation";
let db: Database,
  artifacts: ArtifactService,
  suites: SuiteService,
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
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-evals-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  suites = new SuiteService(db);
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
it("requires verified expectations, rejects stale edits, and preserves locked suite revisions", async () => {
  const f = await runtimeFixture(db, artifacts);
  const s = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Packet checks",
    parent_suite_version_id: null,
  });
  const data = caseInput.parse({
    case_key: "packet",
    name: "Complete packet",
    kind: "workflow",
    input_bundle_id: f.bundle.id,
    assertions: [
      {
        key: "id",
        label: "Shipment identity",
        path: ["shipment"],
        expected: "SYNTHETIC-001",
      },
      {
        key: "source",
        label: "Original record identifier",
        path: ["records"],
        operator: "contains_record",
        expected: { id: "RAW-7", source: "source-a" },
      },
    ],
  });
  let c = await suites.addCase(f.w.id, s.id, data);
  expect((await suites.addCase(f.w.id, s.id, data)).id).toBe(c.id);
  let current = (await suites.state(f.w.id)).suites[0];
  await expect(
    suites.lock(f.w.id, s.id, { expected_revision: current.revision }),
  ).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" });
  c = await suites.verifyCase(f.w.id, s.id, c.id, {
    expected_revision: c.revision,
  });
  await expect(
    suites.editCase(f.w.id, s.id, c.id, {
      expected_revision: c.revision - 1,
      case: data,
    }),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
  c = await suites.editCase(f.w.id, s.id, c.id, {
    expected_revision: c.revision,
    case: { ...data, name: "Reviewed packet" },
  });
  expect(c.verified_at).toBeNull();
  expect(c.assertions).toEqual(data.assertions);
  c = await suites.verifyCase(f.w.id, s.id, c.id, {
    expected_revision: c.revision,
  });
  current = (await suites.state(f.w.id)).suites[0];
  await suites.lock(f.w.id, s.id, { expected_revision: current.revision });
  await expect(
    db.query("UPDATE evaluation_cases SET assertions='[]' WHERE id=$1", [c.id]),
  ).rejects.toMatchObject({ code: "23514" });
  const revision = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Corrected checks",
    parent_suite_version_id: s.id,
  });
  const revised = await suites.state(f.w.id, revision.id);
  expect(revised.cases[0]).toMatchObject({
    case_key: "packet",
    verified_at: null,
    assertions: data.assertions,
  });
  expect(revised.cases[0].id).not.toBe(c.id);
  await expect(
    suites.removeCase(f.w.id, s.id, c.id, { expected_revision: c.revision }),
  ).rejects.toMatchObject({ code: "SUITE_LOCKED" });
  await expect(
    suites.removeCase(f.w.id, revision.id, revised.cases[0].id, {
      expected_revision: 0,
    }),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
  await suites.removeCase(f.w.id, revision.id, revised.cases[0].id, {
    expected_revision: revised.cases[0].revision,
  });
  expect((await suites.state(f.w.id, revision.id)).cases).toHaveLength(0);
  const old = await suites.state(f.w.id, s.id);
  expect(old.cases[0].verified_at).not.toBeNull();
  expect(old.cases[0].assertions).toEqual(data.assertions);
  expect(old.suites.find((x) => x.id === s.id)?.state).toBe("locked");
});
it("rejects foreign bundles and mismatched human fixtures before cases can be verified", async () => {
  const f = await runtimeFixture(db, artifacts),
    s = await suites.create(f.w.id, {
      request_key: randomUUID(),
      name: "Owned input",
      parent_suite_version_id: null,
    });
  const c = caseInput.parse({
    case_key: "wrong",
    name: "Wrong input",
    kind: "workflow",
    input_bundle_id: randomUUID(),
    assertions: [{ key: "a", label: "Expected", path: [], expected: {} }],
  });
  await expect(suites.addCase(f.w.id, s.id, c)).rejects.toMatchObject({
    code: "INVALID_INPUT",
  });
  await expect(
    suites.addCase(f.w.id, s.id, {
      ...c,
      input_bundle_id: String(f.bundle.id),
      human_responses: [
        {
          node_id: f.nodes[1].id,
          node_visit_number: 1,
          response: { type: "text", text: "yes" },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE_FIXTURE" });
});

it("copies historical expectations as unverified and rejects evaluating v1 code against a v2 suite", async () => {
  const { ProcessRevisionService } = await import(
    "../src/server/process-revisions/service"
  );
  const { PlanService } = await import(
    "../src/server/engineering/plan-service"
  );
  const { ReviewService } = await import(
    "../src/server/reviews/review-service"
  );
  const { FreezeService } = await import(
    "../src/server/reviews/freeze-service"
  );
  const { CanvasService } = await import("../src/server/canvas/service");
  const { EvaluationService } = await import(
    "../src/server/evaluations/evaluation-service"
  );
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const old = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Trusted original",
    parent_suite_version_id: null,
  });
  const item = await suites.addCase(
    f.w.id,
    old.id,
    caseInput.parse({
      case_key: "outcome",
      name: "Outcome",
      kind: "step",
      node_id: f.nodes[1].id,
      input_data: { input: {}, steps: {} },
      assertions: [
        {
          key: "result",
          label: "Expected result",
          path: ["success"],
          expected: true,
        },
      ],
    }),
  );
  await suites.verifyCase(f.w.id, old.id, item.id, {
    expected_revision: item.revision,
  });
  await suites.lock(f.w.id, old.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const v1 = (await new PlanService(db).state(f.w.id)).spec;
  await new ProcessRevisionService(db).start(f.w.id, {
    source_frozen_spec_id: v1.id,
  });
  const reviews = new ReviewService(db),
    r = await reviews.start(f.w.id, { request_key: randomUUID() });
  await reviews.prepare(r.id);
  await reviews.publish(r.id, { findings: [] });
  const board = await new CanvasService(db).load(f.w.id);
  const v2 = await new FreezeService(db).freeze(f.w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  const next = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Relevance-reviewed v2",
    parent_suite_version_id: old.id,
    frozen_spec_id: String(v2.id),
  });
  const copied = (await suites.state(f.w.id, next.id)).cases[0];
  expect(copied.verified_at).toBeNull();
  expect(copied.assertions).toEqual(item.assertions);
  await expect(
    suites.lock(f.w.id, next.id, { expected_revision: next.revision }),
  ).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" });
  await suites.verifyCase(f.w.id, next.id, copied.id, {
    expected_revision: copied.revision,
  });
  await suites.lock(f.w.id, next.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  await expect(
    new EvaluationService(db).start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      suite_version_id: next.id,
    }),
  ).rejects.toMatchObject({ code: "INVALID_EVALUATION" });
  expect((await suites.state(f.w.id, old.id)).cases[0].assertions).toEqual(
    item.assertions,
  );
  expect(
    (
      await db.query(
        "SELECT id FROM workflow_jobs WHERE workflow_id=$1 AND status='queued'",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
});
