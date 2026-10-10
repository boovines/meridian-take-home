import { beforeAll, afterAll, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  Worker,
  bundleWorkflowCode,
  type WorkflowBundle,
} from "@temporalio/worker";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { VersionService } from "../src/server/engineering/version-service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { StepService } from "../src/server/runtime/step-service";
import { HumanService } from "../src/server/runtime/human-service";
import { GroupedExecutionService } from "../src/server/grouped-execution/service";
import { JobService } from "../src/server/engineering/job-service";
import { GroupedCoordinator } from "../src/server/grouped-execution/coordinator";
import { groupedExecutionState } from "../src/server/grouped-execution/state";
import { runtimeFixture } from "./fixtures/runtime";
import type {
  Json,
  RuntimeProjection,
  ScheduleStep,
} from "../src/domain/runtime";
let env: TestWorkflowEnvironment,
  workflowBundle: WorkflowBundle,
  db: Database,
  directory: string,
  artifacts: ArtifactService;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve("src/worker/workflows.ts"),
  });
  db = await createDatabase();
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "grouped-worker-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
}, 120000);
afterAll(async () => {
  await db?.close();
  await env?.teardown();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function eventually<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(100);
  }
  throw new Error("Expected durable grouped state did not arrive.");
}
it.each(["answer", "cancel", "cancel_child"])(
  "keeps completed groups across a real worker restart and %s of a waiting sibling",
  async (action) => {
    const f = await runtimeFixture(db, artifacts);
    await f.runs.finish(f.job.id, { status: "cancelled", error: null });
    const groups = new GroupedExecutionService(db),
      coordinator = new GroupedCoordinator(db),
      humans = new HumanService(db),
      steps = new StepService(db, new VersionService(db, artifacts), artifacts);
    const messageId = "abcdef0123456789";
    const parent = await groups.start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      message_ids: [messageId],
    });
    let captures = 0;
    const activities = {
      fenceGroupedExecution: (id: string) =>
        new JobService(db).requestCancel(f.w.id, id),
      advanceGroupedExecution: (id: string) => coordinator.advance(id),
      captureGroupedEmails: async (id: string) => {
        captures++;
        const source = await artifacts.create(
          f.w.id,
          "source_document",
          "requests.txt",
          "text/plain",
          Buffer.from("Purchase requests A and B"),
        );
        const bundle = await new BundleService(db).create(f.w.id, {
          source_kind: "fixture",
          shipment_reference: null,
          manifest: {
            message_ids: [messageId],
            artifacts: [
              {
                artifact_id: source.id,
                message_id: messageId,
                name: "requests.txt",
              },
            ],
            input: {
              messages: [
                {
                  id: messageId,
                  source_artifact_id: source.id,
                  text: "Purchase requests A and B",
                },
              ],
              documents: [],
            },
          },
        });
        await groups.attachCapture(id, String(bundle.id));
      },
      endOwnedJob: (id: string) =>
        f.runs.finish(id, { status: "cancelled", error: null }),
      endGroupedExecution: (id: string, reason: string, cancelled: boolean) =>
        coordinator.stop(id, reason, cancelled),
      prepareExecution: (id: string) => f.runs.prepare(id),
      projectExecution: (id: string, p: RuntimeProjection) =>
        f.runs.project(id, p),
      endExecution: (id: string, result: Parameters<typeof f.runs.finish>[1]) =>
        f.runs.finish(id, result),
      readHumanResponse: (id: string) => humans.response(id),
      executeOccurrence: (data: ScheduleStep, resume = false) =>
        steps.execute(
          data,
          {
            reason: async () => {
              throw new Error("No model calls in fixture");
            },
            invoke: async (_project, node, context) => {
              const mode = (context.execution as { mode: string }).mode;
              let output: Json;
              if (mode === "grouping")
                output = {
                  groups: ["A", "B"].map((key) => ({
                    key,
                    label: `Purchase ${key}`,
                    context: { reference: key },
                  })),
                  assignments: [
                    {
                      source_id: `message:${messageId}`,
                      targets: ["A", "B"].map((group_key) => ({
                        group_key,
                        scope: `Purchase ${group_key} section`,
                        reason: "Explicit request reference",
                      })),
                      unresolved: null,
                      exclusion_reason: null,
                    },
                  ],
                };
              else if (mode === "aggregate")
                output = {
                  report: "Purchase requests reviewed",
                  groups: (context.input as { groups: Json }).groups,
                };
              else
                output = {
                  request: (
                    context.input as { execution_group: { key: string } }
                  ).execution_group.key,
                  reviewed: true,
                };
              return {
                kind: "complete",
                output,
                matching_connection_ids:
                  mode !== "workflow"
                    ? []
                    : f.board.connections
                        .filter((e) => e.source_node_id === node)
                        .map((e) => e.id),
              };
            },
          },
          AbortSignal.timeout(15000),
          resume,
        ),
    };
    const taskQueue = `grouped-${randomUUID()}`,
      options = {
        connection: env.nativeConnection,
        taskQueue,
        workflowBundle,
        activities,
      };
    const first = await Worker.create(options),
      running = first.run();
    const handle = await env.client.workflow.start("executeGroupedEmails", {
      taskQueue,
      workflowId: `job-${parent.id}`,
      args: [parent.id],
    });
    const pending = () =>
      db
        .query(
          "SELECT h.*,r.job_id FROM human_requests h JOIN workflow_runs r ON r.id=h.run_id JOIN workflow_jobs j ON j.id=r.job_id WHERE j.parent_job_id=$1 AND h.status='pending' ORDER BY h.id",
          [parent.id],
        )
        .then((r) => r.rows);
    let waiting: Awaited<ReturnType<typeof pending>> = [];
    try {
      waiting = await eventually(pending, (rows) => rows.length === 2);
      await humans.answer(f.w.id, String(waiting[0].id), {
        request_key: randomUUID(),
        response: {
          type: "approval",
          approved: true,
          text: "Reviewed purchase request",
        },
      });
      await env.client.workflow
        .getHandle(`job-${waiting[0].job_id}`)
        .signal("humanAnswered", waiting[0].id);
      await eventually(
        () => groupedExecutionState(db, parent.id),
        (s) => s.completed_groups === 1,
      );
    } finally {
      first.shutdown();
      await running;
    }
    expect(captures).toBe(1);
    expect((await handle.describe()).status.name).toBe("RUNNING");
    if (action === "answer") {
      await humans.answer(f.w.id, String(waiting[1].id), {
        request_key: randomUUID(),
        response: {
          type: "approval",
          approved: true,
          text: "Reviewed remaining purchase request",
        },
      });
      await env.client.workflow
        .getHandle(`job-${waiting[1].job_id}`)
        .signal("humanAnswered", waiting[1].id);
    } else if (action === "cancel_child") {
      // No direct Temporal notification: the parent must deliver the persisted intent.
      await new JobService(db).requestCancel(f.w.id, String(waiting[1].job_id));
    } else await handle.cancel();
    const second = await Worker.create(options);
    await second.runUntil(() => handle.result());
    const state = await groupedExecutionState(db, parent.id);
    expect(captures).toBe(1);
    expect(state.completed_groups).toBe(action === "answer" ? 2 : 1);
    expect(state.job.status).toBe(
      action === "answer"
        ? "succeeded"
        : action === "cancel_child"
          ? "failed"
          : "cancelled",
    );
    if (action === "answer")
      expect(state.aggregate?.output).toMatchObject({
        report: "Purchase requests reviewed",
      });
    else
      expect(
        state.children.some((c) => c.execution.run.status === "cancelled"),
      ).toBe(true);
    const history = await handle.fetchHistory();
    expect(
      history.events?.filter((e) => e.workflowTaskFailedEventAttributes),
    ).toHaveLength(0);
  },
  90000,
);
it("retains the actionable capture error after Temporal retries are exhausted", async () => {
  const { ApplicationFailure } = await import("@temporalio/common");
  const f = await runtimeFixture(db, artifacts);
  await f.runs.finish(f.job.id, { status: "cancelled", error: null });
  const service = new GroupedExecutionService(db),
    coordinator = new GroupedCoordinator(db);
  const parent = await service.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    message_ids: ["abcdef0123456789"],
  });
  const reason =
    "Could not capture email abcdef0123456789. Completed downloads are retained. Check Gmail access or try a smaller selection.";
  let attempts = 0;
  const taskQueue = `capture-error-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: {
      advanceGroupedExecution: (id: string) => coordinator.advance(id),
      captureGroupedEmails: async () => {
        attempts++;
        throw ApplicationFailure.create({
          type: "GMAIL_CAPTURE_FAILED",
          message: reason,
        });
      },
      fenceGroupedExecution: (id: string) =>
        new JobService(db).requestCancel(f.w.id, id),
      endGroupedExecution: (id: string, message: string, cancelled: boolean) =>
        coordinator.stop(id, message, cancelled),
    },
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("executeGroupedEmails", {
      taskQueue,
      workflowId: `job-${parent.id}`,
      args: [parent.id],
    });
    await expect(handle.result()).rejects.toThrow();
  });
  expect(attempts).toBe(2);
  const state = await service.read(f.w.id, parent.id);
  expect(state.job).toMatchObject({ status: "failed", error_message: reason });
  expect(state.record.input_bundle_id).toBeNull();
}, 30000);
