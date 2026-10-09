import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { VersionService } from "../src/server/engineering/version-service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { HumanService } from "../src/server/runtime/human-service";
import { StepService } from "../src/server/runtime/step-service";
import { GroupedExecutionService } from "../src/server/grouped-execution/service";
import { GroupedBudget } from "../src/server/grouped-execution/budget";
import { RuntimeEngine } from "../src/domain/runtime-engine";
import { runtimeFixture } from "./fixtures/runtime";
let db: Database, artifacts: ArtifactService, directory: string;
beforeAll(async () => {
  db = await createDatabase();
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-grouped-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(humanTrigger = false) {
  const f = await runtimeFixture(
    db,
    artifacts,
    ["trigger", "outcome"],
    humanTrigger
      ? {
          name: "Expert grouped requests",
          desired_outcome: "Group requests using an expert decision.",
          instructions: {
            trigger: "Ask the expert how to group these requests.",
          },
          methods: { trigger: "human" },
        }
      : undefined,
  );
  await f.runs.finish(f.job.id, { status: "cancelled", error: null });
  const service = new GroupedExecutionService(db);
  const messageId = "abcdef0123456789";
  const parent = await service.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    message_ids: [messageId],
  });
  const a = await artifacts.create(
    f.w.id,
    "source_document",
    "request.txt",
    "text/plain",
    Buffer.from("Request A and request B"),
  );
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: "fixture",
    shipment_reference: null,
    manifest: {
      input: {
        messages: [
          {
            id: messageId,
            source_artifact_id: a.id,
            text: "Request A and request B",
          },
        ],
        documents: [],
      },
      message_ids: [messageId],
      artifacts: [
        { artifact_id: a.id, message_id: messageId, name: "request.txt" },
      ],
    },
  });
  await service.attachCapture(parent.id, String(bundle.id));
  const key = randomUUID(),
    phase = await service.startGrouping(parent.id, key);
  expect((await service.startGrouping(parent.id, key)).run.id).toBe(
    phase.run.id,
  );
  const context = (await f.runs.prepare(phase.job.id))!;
  const result = {
    groups: [
      { key: "A", label: "Request A", context: { request: "A" } },
      { key: "B", label: "Request B", context: { request: "B" } },
    ],
    assignments: [
      {
        source_id: `message:${messageId}`,
        targets: [
          {
            group_key: "A",
            scope: "Request A section",
            reason: "Explicit request reference",
          },
          {
            group_key: "B",
            scope: "Request B section",
            reason: "Explicit request reference",
          },
        ],
        unresolved: null,
        exclusion_reason: null,
      },
    ],
  };
  const steps = new StepService(
    db,
    new VersionService(db, artifacts),
    artifacts,
  );
  const data = {
    run_id: phase.run.id,
    node_id: f.nodes[0].id,
    occurrence_number: 1,
    node_visit_number: 1,
    scheduling_key: "step-1",
    branch_ref: null,
    input_step_refs: {},
  };
  return { ...f, service, parent, phase, context, result, steps, data };
}
const noReason = async () => {
  throw new Error("Code phase must not use model calls");
};
it("executes grouping through the approved primitive and seals independent child scopes without walking the graph", async () => {
  const f = await fixture();
  const invoke = vi.fn(async () => ({
    kind: "complete",
    output: f.result,
    matching_connection_ids: [],
  }));
  const engine = new RuntimeEngine(
    f.phase.run.id,
    f.context.definition,
    {
      now: () => Date.now(),
      changed() {},
      project: (p) => f.runs.project(f.phase.run.id, p),
      step: (data, resume) =>
        f.steps.execute(
          data,
          { invoke, reason: noReason },
          AbortSignal.timeout(15000),
          resume,
        ),
      human: async () => {
        throw new Error("No human step expected");
      },
    },
    f.phase.run.phase_node_id,
  );
  const result = await engine.run();
  expect(result.status).toBe("completed");
  await f.runs.finish(f.phase.job.id, result);
  expect(invoke).toHaveBeenCalledTimes(1);
  const context = invoke.mock.calls[0] as unknown as [
    unknown,
    unknown,
    { execution: { mode: string }; source_inventory: unknown[] },
  ];
  expect(context[2].execution.mode).toBe("grouping");
  expect(context[2].source_inventory).toHaveLength(1);
  await expect(
    db.query("UPDATE grouped_executions SET limits='{}' WHERE job_id=$1", [
      f.parent.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.query(
      "UPDATE grouped_executions SET input_bundle_id=$2 WHERE job_id=$1",
      [f.parent.id, f.bundle.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  const decision = await f.service.publishGrouping(f.parent.id, f.phase.run.id);
  expect(
    (await f.service.publishGrouping(f.parent.id, f.phase.run.id)).id,
  ).toBe(decision.id);
  const children = (
    await db.query(
      "SELECT c.*,b.manifest,j.parent_job_id FROM grouped_children c JOIN input_bundles b ON b.id=c.input_bundle_id JOIN workflow_jobs j ON j.id=c.job_id WHERE c.parent_job_id=$1 ORDER BY c.group_key",
      [f.parent.id],
    )
  ).rows;
  expect(children).toHaveLength(2);
  expect(children[0].input_bundle_id).not.toBe(children[1].input_bundle_id);
  expect(
    children.map(
      (c) =>
        (c.manifest as { input: { execution_group: { key: string } } }).input
          .execution_group.key,
    ),
  ).toEqual(["A", "B"]);
  await expect(
    db.query("UPDATE grouping_decisions SET result='{}' WHERE id=$1", [
      decision.id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    f.runs.start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      input_bundle_id: String(f.bundle.id),
      rerun_of_id: null,
    }),
  ).rejects.toMatchObject({ code: "OPERATION_ACTIVE" });
});
it("treats missing coverage as a repairable implementation failure and prevents unrelated primitive execution", async () => {
  const f = await fixture();
  await expect(
    f.steps.execute(
      { ...f.data, node_id: f.nodes[1].id },
      { invoke: vi.fn(), reason: noReason },
      AbortSignal.timeout(15000),
    ),
  ).rejects.toMatchObject({ code: "INVALID_PHASE_NODE" });
  const result = await f.steps.execute(
    f.data,
    {
      invoke: async () => ({
        kind: "complete",
        output: { groups: [], assignments: [] },
        matching_connection_ids: [],
      }),
      reason: noReason,
    },
    AbortSignal.timeout(15000),
  );
  expect(result).toMatchObject({
    kind: "error",
    error: { category: "implementation", code: "GROUPING_OUTPUT_INVALID" },
  });
  await expect(
    f.service.publishGrouping(f.parent.id, f.phase.run.id),
  ).rejects.toMatchObject({ code: "GROUPING_NOT_COMPLETE" });
});
it("fences late output and new spend when the owning operation is cancelled; retains durable reservations", async () => {
  const f = await fixture();
  const budget = new GroupedBudget(db, f.parent.id);
  const charge = await budget.reserve("fixture", 4, {});
  await expect(
    new GroupedBudget(db, f.parent.id).reserve("fixture", 2, {}),
  ).rejects.toMatchObject({ code: "INFERENCE_BUDGET_LIMIT" });
  await charge.settle(1);
  await new GroupedBudget(db, f.parent.id).reserve("fixture", 3, {});
  const invoke = vi.fn(async () => {
    await db.query(
      "UPDATE workflow_jobs SET status='cancel_requested' WHERE id=$1",
      [f.parent.id],
    );
    return { kind: "complete", output: f.result, matching_connection_ids: [] };
  });
  await expect(
    f.steps.execute(
      f.data,
      { invoke, reason: noReason },
      AbortSignal.timeout(15000),
    ),
  ).rejects.toMatchObject({ code: "PARENT_INACTIVE" });
  await expect(budget.reserve("fixture", 0.01, {})).rejects.toMatchObject({
    code: "PARENT_INACTIVE",
  });
  expect(
    (
      await db.query(
        "SELECT output_data FROM step_executions WHERE run_id=$1",
        [f.phase.run.id],
      )
    ).rows[0].output_data,
  ).toBeNull();
});
it("seals answered clarification into a new phase input and reuses unchanged children", async () => {
  const f = await fixture();
  const first = {
    ...f.result,
    assignments: f.result.assignments.map((a) => ({
      ...a,
      unresolved: {
        scope: "Unlabeled request note",
        question: "Does the unlabeled note belong to request A?",
      },
    })),
  };
  const step = await f.steps.execute(
    f.data,
    {
      invoke: async () => ({
        kind: "complete",
        output: first,
        matching_connection_ids: [],
      }),
      reason: noReason,
    },
    AbortSignal.timeout(15000),
  );
  expect(step.kind).toBe("complete");
  await f.runs.finish(f.phase.job.id, {
    status: "completed",
    error: null,
    result_step_id: step.step_id,
  });
  await f.service.publishGrouping(f.parent.id, f.phase.run.id);
  await expect(
    f.service.startGrouping(f.parent.id, randomUUID()),
  ).rejects.toMatchObject({ code: "CLARIFICATION_PENDING" });
  const q = (
    await db.query("SELECT * FROM grouping_questions WHERE parent_job_id=$1", [
      f.parent.id,
    ])
  ).rows[0];
  const answer = {
    request_key: randomUUID(),
    answer: "The note is informational; it belongs to neither request.",
  };
  await f.service.answerQuestion(f.w.id, String(q.id), answer);
  await f.service.answerQuestion(f.w.id, String(q.id), answer);
  await expect(
    f.service.answerQuestion(f.w.id, String(q.id), {
      ...answer,
      answer: "Different answer",
    }),
  ).rejects.toMatchObject({ code: "ALREADY_ANSWERED" });
  const next = await f.service.startGrouping(f.parent.id, randomUUID());
  expect(
    (await f.service.startGrouping(f.parent.id, randomUUID())).run.id,
  ).toBe(next.run.id);
  expect(next.run.input_bundle_id).not.toBe(f.phase.run.input_bundle_id);
  const bundle = await new BundleService(db).read(
    f.w.id,
    next.run.input_bundle_id,
  );
  expect(bundle.manifest).toMatchObject({
    input: { grouping_clarification: { answers: [{ answer: answer.answer }] } },
  });
  const original = await new BundleService(db).read(
    f.w.id,
    f.phase.run.input_bundle_id,
  );
  expect(original.manifest).not.toHaveProperty("input.grouping_clarification");
  await f.runs.prepare(next.job.id);
  const resolved = await f.steps.execute(
    { ...f.data, run_id: next.run.id },
    {
      invoke: async () => ({
        kind: "complete",
        output: f.result,
        matching_connection_ids: [],
      }),
      reason: noReason,
    },
    AbortSignal.timeout(15000),
  );
  await f.runs.finish(next.job.id, {
    status: "completed",
    error: null,
    result_step_id: resolved.step_id,
  });
  await f.service.publishGrouping(f.parent.id, next.run.id);
  expect(
    (
      await db.query("SELECT id FROM grouped_children WHERE parent_job_id=$1", [
        f.parent.id,
      ])
    ).rows,
  ).toHaveLength(2);
  expect(
    (
      await db.query(
        "SELECT id FROM grouping_decisions WHERE parent_job_id=$1",
        [f.parent.id],
      )
    ).rows,
  ).toHaveLength(2);
});

it("keeps the approved human gate during grouping and excludes human waiting from active time", async () => {
  const f = await fixture(true),
    humans = new HumanService(db);
  let now = Date.now();
  const invoke = vi.fn(async (_project, _node, context) => {
    expect(context.human_response).toMatchObject({
      type: "text",
      text: "Use the explicit request references.",
    });
    return { kind: "complete", output: f.result, matching_connection_ids: [] };
  });
  const engine = new RuntimeEngine(
    f.phase.run.id,
    f.context.definition,
    {
      now: () => now,
      changed() {},
      project: (p) => f.runs.project(f.phase.run.id, p),
      step: (data, resume) =>
        f.steps.execute(
          data,
          { invoke, reason: noReason },
          AbortSignal.timeout(15000),
          resume,
        ),
      human: async (id) => {
        expect(invoke).not.toHaveBeenCalled();
        expect(engine.isWaiting()).toBe(true);
        const allowance = engine.remaining();
        now += 86400000;
        expect(engine.remaining()).toBe(allowance);
        await humans.answer(f.w.id, id, {
          request_key: randomUUID(),
          response: {
            type: "text",
            text: "Use the explicit request references.",
          },
        });
      },
    },
    f.phase.run.phase_node_id,
  );
  expect((await engine.run()).status).toBe("completed");
  expect(invoke).toHaveBeenCalledTimes(1);
});
