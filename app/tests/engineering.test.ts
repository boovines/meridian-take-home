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
import { GenerationService } from "../src/server/engineering/generation-service";
import { VersionService } from "../src/server/engineering/version-service";
import { fixtureSources } from "./fixtures/engineer";
import {
  assembleProject,
  validateProject,
} from "../src/server/engineering/project";
import { unzipSync } from "fflate";
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
  await expect(jobs.finish(job.id, "succeeded")).rejects.toMatchObject({
    code: "NO_GENERATED_PROJECT",
  });
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

it("resumes generation from durable source after validation failure and downloads the exact immutable project", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  const job = await jobs.startGeneration(w.id, {
    request_key: randomUUID(),
    plan_version_id: plan.id,
    input_version_id: null,
  });
  let calls = 0,
    validations = 0;
  const adapters = {
    model: "fixture",
    generate: async (
      context: NonNullable<
        Awaited<ReturnType<JobService["prepareGeneration"]>>
      >,
    ) => {
      calls++;
      return fixtureSources(context.spec.board, context.steps);
    },
    validate: async () => {
      validations++;
      if (validations === 1) throw new Error("Transient sandbox outage");
      return { verified: true };
    },
  };
  const service = new GenerationService(db, artifacts);
  await expect(
    service.run(job.id, adapters, AbortSignal.timeout(10000)),
  ).rejects.toThrow("Transient sandbox");
  expect((await plans.state(w.id)).versions).toHaveLength(1);
  await service.run(job.id, adapters, AbortSignal.timeout(10000));
  await service.run(job.id, adapters, AbortSignal.timeout(10000));
  expect(calls).toBe(1);
  expect(validations).toBe(2);
  const state = await plans.state(w.id);
  expect(state.jobs[0].status).toBe("succeeded");
  expect(state.versions).toHaveLength(1);
  const versions = new VersionService(db, artifacts),
    versionId = String(state.versions[0].id),
    detail = await versions.inspect(w.id, versionId);
  const response = await versions.download(w.id, versionId),
    zip = unzipSync(new Uint8Array(await response.arrayBuffer()));
  expect(new TextDecoder().decode(zip["run-step.mjs"])).toBe(
    detail.project.files["run-step.mjs"],
  );
  expect(Object.keys(zip).sort()).toEqual(
    Object.keys(detail.project.files).sort(),
  );
  const other = await canvas.create({ name: "Other", desired_outcome: "" });
  await expect(versions.inspect(other.id, versionId)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
});
it("retains completed source when cancellation interrupts its validation without claiming success", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    job = await jobs.startGeneration(w.id, {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    });
  await expect(
    new GenerationService(
      db,
      new ArtifactService(db, new LocalObjectStore(directory)),
    ).run(
      job.id,
      {
        model: "fixture",
        generate: async (c) => fixtureSources(c.spec.board, c.steps),
        validate: async () => {
          await jobs.requestCancel(w.id, job.id);
          return {};
        },
      },
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: "JOB_INACTIVE" });
  const state = await plans.state(w.id);
  expect(state.versions).toHaveLength(1);
  expect(state.jobs[0].status).toBe("cancel_requested");
});
it("rejects incomplete sources and escaping paths, and inserts human behavior independently of the coding agent", async () => {
  const { w, plan } = await approved(),
    context = (await new JobService(db).prepareGeneration(
      (
        await new JobService(db).startGeneration(w.id, {
          request_key: randomUUID(),
          plan_version_id: plan.id,
          input_version_id: null,
        })
      ).id,
    ))!;
  const sources = fixtureSources(context.spec.board, context.steps);
  expect(() =>
    assembleProject(
      context.spec.board,
      context.spec.id,
      context.plan,
      context.steps,
      { ...sources, steps: [] },
      "fixture",
    ),
  ).toThrow("every approved step");
  const project = assembleProject(
    context.spec.board,
    context.spec.id,
    context.plan,
    context.steps,
    sources,
    "fixture",
  );
  const human = context.steps.find((s) => s.selected_method === "human")!;
  expect(project.files[project.node_file_map[human.node_id]]).toContain(
    "human_response",
  );
  expect(() =>
    validateProject({
      ...project,
      files: { ...project.files, "../escape.mjs": "anything" },
    }),
  ).toThrow();
  expect(() =>
    validateProject({
      ...project,
      files: { ...project.files, "run-step.mjs": "" },
    }),
  ).toThrow();
});

it("releases expired generation slots during inspection even when the worker is offline", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    job = await jobs.startGeneration(w.id, {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    });
  await db.query(
    "UPDATE workflow_jobs SET deadline_at=now()-interval '1 minute' WHERE id=$1",
    [job.id],
  );
  expect((await plans.state(w.id)).jobs[0].status).toBe("failed");
  expect(await jobs.prepareGeneration(job.id)).toBeNull();
  expect(
    (
      await jobs.startGeneration(w.id, {
        request_key: randomUUID(),
        plan_version_id: plan.id,
        input_version_id: null,
      })
    ).status,
  ).toBe("queued");
});

it("rejects late source publication when cancellation arrives during code synthesis", async () => {
  const { w, plan } = await approved(),
    jobs = new JobService(db),
    job = await jobs.startGeneration(w.id, {
      request_key: randomUUID(),
      plan_version_id: plan.id,
      input_version_id: null,
    });
  await expect(
    new GenerationService(
      db,
      new ArtifactService(db, new LocalObjectStore(directory)),
    ).run(
      job.id,
      {
        model: "fixture",
        generate: async (context) => {
          await jobs.requestCancel(w.id, job.id);
          return fixtureSources(context.spec.board, context.steps);
        },
        validate: async () => ({}),
      },
      AbortSignal.timeout(10000),
    ),
  ).rejects.toMatchObject({ code: "JOB_INACTIVE" });
  expect((await plans.state(w.id)).versions).toHaveLength(0);
});
