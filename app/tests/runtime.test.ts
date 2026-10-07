import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { ArtifactService } from "../src/server/artifacts/service";
import { VersionService } from "../src/server/engineering/version-service";
import { JobService } from "../src/server/engineering/job-service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { StepService } from "../src/server/runtime/step-service";
import { HumanService } from "../src/server/runtime/human-service";
import { runtimeFixture } from "./fixtures/runtime";
import { RuntimeEngine } from "../src/domain/runtime-engine";
import type { ScheduleStep, HumanRequest } from "../src/domain/runtime";
import { ExecutionAuditService } from "../src/server/runtime/audit-service";
import { DomainError } from "../src/domain/errors";
let db: Database,
  artifacts: ArtifactService,
  directory: string,
  steps: StepService;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated local/CI persistence.");
  db = await createDatabase(url);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-runtime-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
  steps = new StepService(db, new VersionService(db, artifacts), artifacts);
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
const signal = () => AbortSignal.timeout(15000);
const noReason = async () => {
  throw new Error("Unexpected reasoning.");
};
function schedule(
  f: Awaited<ReturnType<typeof runtimeFixture>>,
  index: number,
  occurrence = index + 1,
): ScheduleStep {
  return {
    run_id: f.run.id,
    node_id: f.nodes[index].id,
    occurrence_number: occurrence,
    node_visit_number: 1,
    scheduling_key: `step-${occurrence}`,
    branch_ref: null,
    input_step_refs: {},
  };
}
it("executes a frozen plan, blocks on each human visit, and records immutable history", async () => {
  const f = await runtimeFixture(db, artifacts),
    humans = new HumanService(db);
  let invoked = 0;
  const invoke = vi.fn(async (_p, _node, context) => {
    invoked++;
    return {
      kind: "complete",
      output: { received: context.human_response ?? null },
      matching_connection_ids: f.board.connections
        .filter((e) => e.source_node_id === _node)
        .map((e) => e.id),
    };
  });
  const engine = new RuntimeEngine(f.run.id, f.definition, {
    now: () => Date.now(),
    changed() {},
    project: (p) => f.runs.project(f.run.id, p),
    step: (data, resume) =>
      steps.execute(data, { invoke, reason: noReason }, signal(), resume),
    human: async (id) => {
      expect(invoked).toBe(1); // mandatory approval occurs before candidate code
      expect((await f.runs.state(f.w.id)).runs[0].status).toBe(
        "waiting_for_human",
      );
      const answer = {
        request_key: randomUUID(),
        response: {
          type: "approval" as const,
          approved: true,
          text: "Verified packet",
        },
      };
      await humans.answer(f.w.id, id, answer);
      await humans.answer(f.w.id, id, answer);
      await expect(
        humans.answer(f.w.id, id, {
          ...answer,
          response: { ...answer.response, approved: false },
        }),
      ).rejects.toMatchObject({ code: "ALREADY_ANSWERED" });
    },
  });
  const result = await engine.run();
  expect(result.status).toBe("completed");
  await f.runs.finish(f.job.id, result);
  const state = await f.runs.state(f.w.id, f.run.id);
  expect(state.steps).toHaveLength(3);
  expect(state.runs[0].status).toBe("completed");
  expect(invoked).toBe(3);
  expect(invoke.mock.calls[1][2].human_response).toMatchObject({
    approved: true,
  });
  await expect(
    db.query("UPDATE step_executions SET output_data='{}' WHERE run_id=$1", [
      f.run.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.query(
      "UPDATE workflow_runs SET status='running',finished_at=NULL WHERE id=$1",
      [f.run.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.query("UPDATE input_bundles SET manifest='{}' WHERE id=$1", [
      f.bundle.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  // A repeated schedule delivery returns the stored output while run is active (separate test below).
  const retry = await f.runs.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(f.bundle.id),
    rerun_of_id: f.run.id,
  });
  expect(retry.run.id).not.toBe(f.run.id);
  expect((await f.runs.state(f.w.id, retry.run.id)).human_requests).toEqual([]);
});
it("deduplicates deliveries, rejects changed scheduling keys, and fences late results after cancellation", async () => {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]),
    data = schedule(f, 0);
  const invoke = vi.fn(async () => ({
    kind: "complete",
    output: { ok: true },
    matching_connection_ids: [f.board.connections[0].id],
  }));
  const first = await steps.execute(
    data,
    { invoke, reason: noReason },
    signal(),
  );
  expect(
    await steps.execute(data, { invoke, reason: noReason }, signal()),
  ).toEqual(first);
  expect(invoke).toHaveBeenCalledTimes(1);
  await expect(
    steps.execute(
      { ...data, node_id: f.nodes[1].id },
      { invoke, reason: noReason },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "SCHEDULE_REUSED" });
  let release!: (x: unknown) => void;
  const pending = new Promise((r) => {
    release = r;
  });
  let began!: () => void;
  const started = new Promise<void>((r) => {
    began = r;
  });
  const work = steps.execute(
    schedule(f, 1),
    {
      invoke: async () => {
        began();
        return pending;
      },
      reason: noReason,
    },
    signal(),
  );
  await started;
  await new JobService(db).requestCancel(f.w.id, f.job.id);
  release({
    kind: "complete",
    output: { shouldNotPublish: true },
    matching_connection_ids: [],
  });
  await expect(work).rejects.toMatchObject({ code: "STALE_STEP_RESULT" });
  await f.runs.finish(f.job.id, { status: "cancelled" });
  expect((await f.runs.state(f.w.id)).steps[1].status).toBe("cancelled");
});
it("does not allow Code modules to request models or Human modules to bypass a response", async () => {
  const f = await runtimeFixture(db, artifacts),
    data = schedule(f, 0);
  const reason = vi.fn(async () => ({}));
  const failed = await steps.execute(
    data,
    {
      invoke: async () => ({
        kind: "reason",
        instructions: "Bypass method",
        data: {},
      }),
      reason,
    },
    signal(),
  );
  expect(failed).toMatchObject({
    kind: "error",
    error: { code: "METHOD_VIOLATION" },
  });
  expect(reason).not.toHaveBeenCalled();
  const invoke = vi.fn(async () => ({
    kind: "complete",
    output: {},
    matching_connection_ids: [],
  }));
  const human = await steps.execute(
    schedule(f, 1),
    { invoke, reason },
    signal(),
  );
  expect(human.kind).toBe("human");
  expect(invoke).not.toHaveBeenCalled();
});
it("rejects foreign artifacts, foreign completed-step inputs, and stale runtime projections", async () => {
  const a = await runtimeFixture(db, artifacts, ["trigger", "outcome"]),
    b = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await expect(
    new BundleService(db).create(a.w.id, {
      source_kind: "fixture",
      shipment_reference: null,
      manifest: {
        input: {},
        message_ids: [],
        artifacts: [
          { artifact_id: randomUUID(), message_id: null, name: "missing.pdf" },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARTIFACT" });
  const result = await steps.execute(
    schedule(b, 0),
    {
      invoke: async () => ({
        kind: "complete",
        output: {},
        matching_connection_ids: [b.board.connections[0].id],
      }),
      reason: noReason,
    },
    signal(),
  );
  await expect(
    steps.execute(
      {
        ...schedule(a, 0),
        input_step_refs: { [b.nodes[0].id]: result.step_id },
      },
      { invoke: async () => ({}), reason: noReason },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "INVALID_STEP_INPUT" });
  await a.runs.project(a.run.id, {
    sequence: 3,
    status: "waiting_for_human",
    scheduled_step_attempts: 1,
    active_elapsed_ms: 50,
    active_since: null,
  });
  await a.runs.project(a.run.id, {
    sequence: 2,
    status: "running",
    scheduled_step_attempts: 0,
    active_elapsed_ms: 20,
    active_since: new Date().toISOString(),
  });
  expect((await a.runs.state(a.w.id)).runs[0]).toMatchObject({
    status: "waiting_for_human",
    active_elapsed_ms: 50,
  });
});
it("enforces the active-operation slot and request identity, and a loop requires a new approval", async () => {
  const f = await runtimeFixture(db, artifacts),
    data = schedule(f, 1),
    adapters = {
      invoke: async () => ({
        kind: "complete",
        output: { approved: true },
        matching_connection_ids: [f.board.connections[1].id],
      }),
      reason: noReason,
    };
  await expect(
    f.runs.start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      input_bundle_id: String(f.bundle.id),
      rerun_of_id: null,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_ACTIVE" });
  const first = await steps.execute(data, adapters, signal());
  expect(first.kind).toBe("human");
  if (first.kind !== "human") throw new Error();
  await new HumanService(db).answer(f.w.id, first.request_id, {
    request_key: randomUUID(),
    response: { type: "approval", approved: true, text: "" },
  });
  await steps.execute(data, adapters, signal(), true);
  const second = await steps.execute(
    {
      ...data,
      occurrence_number: 3,
      node_visit_number: 2,
      scheduling_key: "step-3",
    },
    adapters,
    signal(),
  );
  expect(second.kind).toBe("human");
  if (second.kind !== "human") throw new Error();
  expect(second.request_id).not.toBe(first.request_id);
  const pending = (await new HumanService(db).response(
    second.request_id,
  )) as HumanRequest;
  expect(pending.response).toBeNull();
});

it("persists a model response before postprocessing fails, preserving owner and immutable evidence", async () => {
  const f = await runtimeFixture(
    db,
    artifacts,
    ["trigger", "information", "outcome"],
    {
      name: "Delivery scheduling",
      desired_outcome: "Schedule a delivery",
      instructions: {},
      methods: { information: "agent" },
    },
  );
  let count = 0;
  const result = await steps.execute(
    schedule(f, 1),
    {
      model: { provider: "fixture", name: "delivery-parser" },
      invoke: async () => {
        if (count++ === 0)
          return {
            kind: "reason",
            instructions: "Read delivery date",
            data: { note: "Friday" },
            document_ids: [],
          };
        throw new DomainError(422, "STEP_CRASH", "Consumer failed");
      },
      reason: async () => ({ date: "2026-10-09" }),
    },
    signal(),
  );
  expect(result.kind).toBe("error");
  const audits = new ExecutionAuditService(db, artifacts);
  const events = await audits.list(f.w.id, {
    step_execution_id: result.step_id,
  });
  expect(events.map((e) => e.kind)).toEqual([
    "initial_output",
    "model_request",
    "model_response",
    "failure",
  ]);
  expect((await audits.read(f.w.id, events[2].id)).payload).toEqual({
    date: "2026-10-09",
  });
  expect(events[1].summary.model).toBe("delivery-parser");
  await expect(audits.read(randomUUID(), events[2].id)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    db.query("UPDATE execution_audit_events SET kind='failure' WHERE id=$1", [
      events[2].id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    audits.recorder(
      f.w.id,
      { step_execution_id: result.step_id },
      events[0].attempt_token,
    )("failure", { late: true }),
  ).rejects.toMatchObject({ code: "AUDIT_UNAVAILABLE" });
  expect(
    await audits.list(f.w.id, { step_execution_id: result.step_id }),
  ).toHaveLength(4);
});

it("retains a requested interaction after cancellation and rejects its late model response", async () => {
  const f = await runtimeFixture(
    db,
    artifacts,
    ["trigger", "information", "outcome"],
    {
      name: "Delivery scheduling",
      desired_outcome: "Schedule a delivery",
      instructions: {},
      methods: { information: "agent" },
    },
  );
  let began!: () => void, release!: (v: Record<string, string>) => void;
  const started = new Promise<void>((r) => {
      began = r;
    }),
    pending = new Promise<Record<string, string>>((r) => {
      release = r;
    });
  const work = steps.execute(
    schedule(f, 1),
    {
      invoke: async () => ({
        kind: "reason",
        instructions: "Read date",
        data: {},
        document_ids: [],
      }),
      reason: async () => {
        began();
        return pending;
      },
    },
    signal(),
  );
  await started;
  const step = (await f.runs.state(f.w.id)).steps[0];
  const audits = new ExecutionAuditService(db, artifacts);
  expect(
    (await audits.list(f.w.id, { step_execution_id: String(step.id) })).map(
      (e) => e.kind,
    ),
  ).toEqual(["initial_output", "model_request"]);
  await new JobService(db).requestCancel(f.w.id, f.job.id);
  release({ date: "2026-10-09" });
  await expect(work).rejects.toMatchObject({ code: "STALE_STEP_RESULT" });
  expect(
    (await audits.list(f.w.id, { step_execution_id: String(step.id) })).map(
      (e) => e.kind,
    ),
  ).toEqual(["initial_output", "model_request"]);
});
