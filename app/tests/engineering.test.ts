import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { PlanService } from "../src/server/engineering/plan-service";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { nodeInput, connectionInput } from "../src/domain/canvas";
let db: Database, canvas: CanvasService, plans: PlanService, directory: string;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated local/CI persistence.");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  plans = new PlanService(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-artifacts-"));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function frozen() {
  const w = await canvas.create({
    name: "Plan verification",
    desired_outcome: "Approve and produce a report.",
  });
  const nodes = [];
  for (const type of ["trigger", "human_approval", "outcome"] as const)
    nodes.push(
      await canvas.addNode(w.id, nodeInput.parse({ type, title: type })),
    );
  for (let i = 0; i < 2; i++)
    await canvas.addConnection(
      w.id,
      connectionInput.parse({
        source_node_id: nodes[i].id,
        target_node_id: nodes[i + 1].id,
      }),
    );
  const reviews = new ReviewService(db),
    run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.publish(run.id, { findings: [] });
  const board = await canvas.load(w.id);
  await new FreezeService(db).freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  return { w, nodes };
}
it("requires frozen customer scope and prevents removing mandatory human methods", async () => {
  const draft = await canvas.create({ name: "Not ready", desired_outcome: "" });
  await expect(
    plans.create(draft.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    }),
  ).rejects.toMatchObject({ code: "FREEZE_REQUIRED" });
  const { w, nodes } = await frozen(),
    plan = await plans.create(w.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    });
  const human = (await plans.state(w.id)).steps.find(
    (s) => s.node_id === nodes[1].id,
  )!;
  expect(human.selected_method).toBe("human");
  await expect(
    plans.editStep(w.id, plan.id, human.node_id, {
      expected_revision: human.revision,
      selected_method: "code",
    }),
  ).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
  await expect(
    db.query(
      "UPDATE implementation_plan_steps SET selected_method='agent' WHERE id=$1",
      [human.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
it("keeps approvals explicit, preserves immutable old plans, and resets approvals on revision", async () => {
  const { w } = await frozen(),
    plan = await plans.create(w.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    });
  await expect(
    plans.approve(w.id, plan.id, { expected_revision: plan.revision }),
  ).rejects.toMatchObject({ code: "APPROVALS_REQUIRED" });
  let state = await plans.state(w.id);
  for (const s of state.steps)
    await plans.editStep(w.id, plan.id, s.node_id, {
      expected_revision: s.revision,
      approved: true,
    });
  state = await plans.state(w.id);
  await expect(
    plans.approve(w.id, plan.id, { expected_revision: plan.revision }),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
  await plans.approve(w.id, plan.id, {
    expected_revision: state.plans[0].revision,
  });
  await expect(
    db.query(
      "UPDATE implementation_plan_steps SET selected_method='human' WHERE id=$1",
      [state.steps[0].id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const revision = await plans.create(w.id, {
    request_key: randomUUID(),
    parent_plan_version_id: plan.id,
  });
  const next = await plans.state(w.id);
  expect(revision.version_number).toBe(2);
  expect(
    next.steps
      .filter((s) => s.plan_version_id === revision.id)
      .every((s) => s.approved_at === null),
  ).toBe(true);
  expect(next.plans.find((p) => p.id === plan.id)!.state).toBe("approved");
});
it("rejects stale step saves and clears approval when the selected method changes", async () => {
  const { w } = await frozen(),
    plan = await plans.create(w.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    });
  const step = (await plans.state(w.id)).steps.find(
    (s) => s.selected_method === "code",
  )!;
  const approved = await plans.editStep(w.id, plan.id, step.node_id, {
    expected_revision: step.revision,
    approved: true,
  });
  await expect(
    plans.editStep(w.id, plan.id, step.node_id, {
      expected_revision: step.revision,
      selected_method: "agent",
    }),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
  const changed = await plans.editStep(w.id, plan.id, step.node_id, {
    expected_revision: approved.revision,
    selected_method: "agent",
    approved: true,
  });
  expect(changed.approved_at).toBeNull();
});
it("keeps AI recommendations advisory and rejects late recommendations after a plan edit", async () => {
  const { w } = await frozen(),
    plan = await plans.create(w.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    });
  const state = await plans.state(w.id),
    suggestions = {
      steps: state.steps.map((s) => ({
        node_id: s.node_id,
        method: s.selected_method,
        reason: "Based on the frozen requirements.",
      })),
    };
  const proposed = await plans.recommendations(
    w.id,
    plan.id,
    plan.revision,
    suggestions,
  );
  expect(proposed.every((s) => s.approved_at === null)).toBe(true);
  await expect(
    plans.recommendations(w.id, plan.id, plan.revision, suggestions),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
});
it("seals artifact bytes, rejects cross-workflow reads and detects later content tampering", async () => {
  const a = await canvas.create({ name: "Artifacts", desired_outcome: "" }),
    b = await canvas.create({ name: "Other workflow", desired_outcome: "" });
  const artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  const saved = await artifacts.create(
    a.id,
    "generated_project",
    "project.json",
    "application/json",
    Buffer.from('{"source":"example"}'),
  );
  expect((await artifacts.read(a.id, saved.id)).bytes.toString()).toContain(
    "example",
  );
  await expect(artifacts.read(b.id, saved.id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    db.query("UPDATE artifacts SET state='pending' WHERE id=$1", [saved.id]),
  ).rejects.toMatchObject({ code: "23514" });
  await writeFile(path.join(directory, saved.storage_key), "modified");
  await expect(artifacts.read(a.id, saved.id)).rejects.toMatchObject({
    code: "ARTIFACT_CHANGED",
  });
});

import { JobService } from "../src/server/engineering/job-service";
async function approved() {
  const { w } = await frozen(),
    plan = await plans.create(w.id, {
      request_key: randomUUID(),
      parent_plan_version_id: null,
    });
  for (const s of (await plans.state(w.id)).steps)
    await plans.editStep(w.id, plan.id, s.node_id, {
      expected_revision: s.revision,
      approved: true,
    });
  const state = await plans.state(w.id);
  await plans.approve(w.id, plan.id, {
    expected_revision: state.plans[0].revision,
  });
  return { w, plan };
}
it("pins job inputs, deduplicates requests, and keeps the active slot until cancellation is acknowledged", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    request = {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    };
  const job = await jobs.startGeneration(w.id, request);
  expect((await jobs.startGeneration(w.id, request)).id).toBe(job.id);
  await expect(
    jobs.startGeneration(w.id, { ...request, input_version_id: randomUUID() }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  await expect(
    jobs.startGeneration(w.id, { ...request, request_key: randomUUID() }),
  ).rejects.toMatchObject({ code: "OPERATION_ACTIVE" });
  await jobs.prepareGeneration(job.id);
  await expect(jobs.finish(job.id,"succeeded")).rejects.toMatchObject({code:"NO_GENERATED_PROJECT"});
  await jobs.requestCancel(w.id, job.id);
  await expect(jobs.progress(job.id, "generated", {})).rejects.toMatchObject({
    code: "JOB_INACTIVE",
  });
  await expect(
    jobs.startGeneration(w.id, { ...request, request_key: randomUUID() }),
  ).rejects.toMatchObject({ code: "OPERATION_ACTIVE" });
  await jobs.finish(job.id, "cancelled");
  expect(
    (
      await jobs.startGeneration(w.id, {
        ...request,
        request_key: randomUUID(),
      })
    ).status,
  ).toBe("queued");
});
it("publishes a complete version once, retains its approved plan and forbids late publication after cancellation", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    job = await jobs.startGeneration(w.id, {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    });
  const context = (await jobs.prepareGeneration(job.id))!;
  const store = new ArtifactService(db, new LocalObjectStore(directory)),
    artifact = await store.create(
      w.id,
      "generated_project",
      "source.json",
      "application/json",
      Buffer.from("{}"),
    );
  const data = {
    artifactId: artifact.id,
    entrypoint: "workflow.mjs",
    nodeFileMap: Object.fromEntries(
      context.steps.map((s) => [s.node_id, `steps/${s.node_id}.mjs`]),
    ),
    generationKey: "initial",
  };
  const version = await jobs.publishVersion(job.id, data);
  expect((await jobs.publishVersion(job.id, data)).id).toBe(version.id);
  expect(version.plan_version_id).toBe(plan.id);
  await expect(
    db.query(
      "UPDATE implementation_versions SET entrypoint='changed' WHERE id=$1",
      [version.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await jobs.requestCancel(w.id, job.id);
  await expect(
    jobs.publishVersion(job.id, { ...data, generationKey: "late" }),
  ).rejects.toMatchObject({ code: "JOB_INACTIVE" });
});
