import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  Worker,
  bundleWorkflowCode,
  type WorkflowBundle,
} from "@temporalio/worker";
import { cancellationSignal, heartbeat } from "@temporalio/activity";
import { nodeInput } from "../src/domain/canvas";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;
beforeAll(async () => {
  // A local ephemeral server exercises actual cancellation scopes and worker tasks.
  // No app database, cloud namespace, model, mailbox or credentials are involved.
  env = await TestWorkflowEnvironment.createLocal();
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.resolve("src/worker/workflows.ts"),
  });
}, 120000);
afterAll(async () => {
  await env?.teardown();
});

it.each([
  ["evaluateSuite", "checkEvaluationBuild"],
  ["repairImplementation", "generateRepairCandidate"],
  ["executeWorkflow", "executeOccurrence"],
])(
  "%s cancels while its activity is still acknowledging cancellation",
  async (workflowType, activityName) => {
    const taskQueue = `cancel-${randomUUID()}`;
    const started = Promise.withResolvers<void>();
    const ended: string[] = [];
    const blocked = async () => {
      const signal = cancellationSignal();
      const pulse = setInterval(() => heartbeat(), 20);
      try {
        heartbeat();
        started.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        // The monitor rejects before this WAIT_CANCELLATION_COMPLETED activity settles.
        await delay(150);
        signal.throwIfAborted();
      } finally {
        clearInterval(pulse);
      }
    };
    const node = {
      ...nodeInput.parse({ type: "trigger", title: "Start" }),
      id: randomUUID(),
    };
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      maxHeartbeatThrottleInterval: 50,
      activities: {
        prepareEvaluation: async () => ({
          deadline_at: new Date(Date.now() + 600000).toISOString(),
          evaluation_id: randomUUID(),
          result_ids: [],
        }),
        prepareRepair: async () => ({
          deadline_at: new Date(Date.now() + 600000).toISOString(),
          attempt_limit: 3,
        }),
        beginRepairAttempt: async () => randomUUID(),
        prepareExecution: async () => ({
          run: { id: randomUUID() },
          definition: {
            board: { nodes: [node], connections: [] },
            methods: { [node.id]: "code" },
            limits: { step_attempts: 100, active_ms: 900000 },
          },
        }),
        projectExecution: async () => {},
        endEvaluation: async (
          _id: string,
          _error: unknown,
          cancelled: boolean,
        ) => {
          ended.push(cancelled ? "cancelled" : "other");
        },
        endRepair: async (_id: string, status: string) => {
          ended.push(status);
        },
        endExecution: async (_id: string, result: { status: string }) => {
          ended.push(result.status);
        },
        [activityName]: blocked,
      },
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(workflowType, {
        workflowId: randomUUID(),
        taskQueue,
        args: [randomUUID()],
      });
      await started.promise;
      await handle.cancel();
      await Promise.race([
        handle.result(),
        delay(5000).then(() => {
          throw new Error("Cancellation failed to finish within five seconds.");
        }),
      ]);
      const history = await handle.fetchHistory();
      expect(
        history.events?.filter((e) => e.workflowTaskFailedEventAttributes),
      ).toHaveLength(0);
    });
    expect(ended).toEqual(["cancelled"]);
  },
  20000,
);
