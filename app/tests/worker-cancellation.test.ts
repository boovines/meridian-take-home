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
import { RUNTIME_HEARTBEAT_POLICY } from "../src/domain/runtime-policy";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundle;

it.each(["answer", "cancel"])(
  "persists an open recovery question across a worker restart and handles %s",
  async (action) => {
    const taskQueue = `question-restart-${randomUUID()}`;
    const attemptId = randomUUID();
    const waiting = Promise.withResolvers<void>();
    let question = "open";
    const generated: string[] = [];
    const ended: string[] = [];
    const activities = {
      prepareRepair: async () => ({ origin: "run", attempt_limit: 3 }),
      remainingRecoveryTime: async () => question === "open" ? null : 600000,
      recoveryBaseline: async () => null,
      beginRepairAttempt: async () => attemptId,
      generateRepairCandidate: async (id: string) => {
        generated.push(id);
        return generated.length === 1
          ? { ready: false, waiting: true }
          : { ready: false, reason: "Source requires engineer attention." };
      },
      recoveryQuestionState: async () => {
        waiting.resolve();
        return question;
      },
      endRepair: async (_id: string, status: string) => {
        ended.push(status);
      },
    };
    const options = { connection: env.nativeConnection, taskQueue, workflowBundle, activities };
    const first = await Worker.create(options);
    const running = first.run();
    const handle = await env.client.workflow.start("repairImplementation", {
      taskQueue, workflowId: randomUUID(), args: [randomUUID()],
    });
    try {
      await waiting.promise;
    } finally {
      first.shutdown();
      await running;
    }
    expect(generated).toEqual([attemptId]);
    expect((await handle.describe()).status.name).toBe("RUNNING");
    if (action === "answer") question = "answered";
    else await handle.cancel();
    const second = await Worker.create(options);
    await second.runUntil(async () => {
      await handle.result();
    });
    expect(generated).toEqual(action === "answer" ? [attemptId, attemptId] : [attemptId]);
    expect(ended).toEqual([action === "answer" ? "needs_attention" : "cancelled"]);
    const history = await handle.fetchHistory();
    expect(history.events?.filter((e) => e.workflowTaskFailedEventAttributes)).toHaveLength(0);
  },
  20000,
);

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
  ["evaluateSuite", "evaluateStepCase"],
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
      maxHeartbeatThrottleInterval: RUNTIME_HEARTBEAT_POLICY.max_throttle_ms,
      activities: {
        checkEvaluationBuild: async () => ({ ok: true }),
        beginEvaluationCase: async () => ({ kind: "step" }),
        prepareEvaluation: async () => ({
          deadline_at: new Date(Date.now() + 600000).toISOString(),
          evaluation_id: randomUUID(),
          result_ids: [randomUUID()],
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
        delay(10000).then(() => {
          throw new Error("Cancellation failed to finish within ten seconds.");
        }),
      ]);
      const history = await handle.fetchHistory();
      if (activityName !== "generateRepairCandidate") {
        const scheduled = history.events?.map(e => e.activityTaskScheduledEventAttributes)
          .find(e => e?.activityType?.name === activityName);
        expect(scheduled).toBeDefined();
        expect(String(scheduled?.heartbeatTimeout?.seconds)).toBe("60");
        expect(String(scheduled?.startToCloseTimeout?.seconds)).toBe("180");
        expect(String(scheduled?.scheduleToCloseTimeout?.seconds)).toBe("420");
        expect(scheduled?.retryPolicy?.maximumAttempts).toBe(2);
      }
      expect(
        history.events?.filter((e) => e.workflowTaskFailedEventAttributes),
      ).toHaveLength(0);
    });
    expect(ended).toEqual(["cancelled"]);
  },
  20000,
);

it("survives a brief heartbeat-delivery gap without repeating the business invocation", async () => {
  const taskQueue = `heartbeat-gap-${randomUUID()}`;
  const trigger = {
    ...nodeInput.parse({ type: "trigger", title: "Start" }),
    id: randomUUID(),
  };
  const outcome = {
    ...nodeInput.parse({ type: "outcome", title: "Done" }),
    id: randomUUID(),
  };
  const edge = {
    id: randomUUID(),
    source_node_id: trigger.id,
    target_node_id: outcome.id,
  };
  const calls: string[] = [];
  const ended: string[] = [];
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowBundle,
    maxHeartbeatThrottleInterval: RUNTIME_HEARTBEAT_POLICY.max_throttle_ms,
    activities: {
      prepareExecution: async () => ({
        run: { id: randomUUID() },
        definition: {
          board: { nodes: [trigger, outcome], connections: [edge] },
          methods: { [trigger.id]: "code", [outcome.id]: "code" },
          limits: { step_attempts: 100, active_ms: 900000 },
        },
      }),
      projectExecution: async () => {},
      executeOccurrence: async (data: { node_id: string }) => {
        calls.push(data.node_id);
        heartbeat();
        if (data.node_id === trigger.id) {
          // Model a delivery gap using a local activity timer; no cloud or paid call.
          await delay(30000, undefined, { signal: cancellationSignal() });
          heartbeat();
        }
        return {
          kind: "complete",
          step_id: randomUUID(),
          connection_ids: data.node_id === trigger.id ? [edge.id] : [],
        };
      },
      endExecution: async (_id: string, result: { status: string }) => {
        ended.push(result.status);
      },
    },
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("executeWorkflow", {
      workflowId: randomUUID(),
      taskQueue,
      args: [randomUUID()],
    });
    await handle.result();
  });
  expect(ended).toEqual(["completed"]);
  expect(calls).toEqual([trigger.id, outcome.id]);
}, 75000);

it.each([false, true])(
  "run recovery executes its captured input and %s existing regression suite exactly once",
  async (hasSuite) => {
    const taskQueue = `recovery-${randomUUID()}`,
      runId = randomUUID(),
      evaluationId = randomUUID();
    const trigger = {
      ...nodeInput.parse({ type: "trigger", title: "Start" }),
      id: randomUUID(),
    };
    const outcome = {
      ...nodeInput.parse({ type: "outcome", title: "Report" }),
      id: randomUUID(),
    };
    const edge = {
      id: randomUUID(),
      source_node_id: trigger.id,
      target_node_id: outcome.id,
      condition: null,
      is_default: false,
    };
    const calls: string[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowBundle,
      activities: {
        prepareRepair: async () => ({
          origin: "run",
          attempt_limit: 3,
          deadline_at: new Date(Date.now() + 600000).toISOString(),
        }),
        remainingRecoveryTime: async () => 600000,
        recoveryBaseline: async () => null,
        beginRepairAttempt: async () => {
          calls.push("attempt");
          return randomUUID();
        },
        generateRepairCandidate: async () => {
          calls.push("generate");
          return hasSuite && calls.filter((c) => c === "generate").length === 1
            ? { ready: false, waiting: true }
            : { ready: true };
        },
        recoveryQuestionState: async () => "answered",
        createRecoveryRerun: async () => runId,
        prepareCaseExecution: async () => ({
          run: { id: runId },
          definition: {
            board: { nodes: [trigger, outcome], connections: [edge] },
            methods: { [trigger.id]: "code", [outcome.id]: "code" },
            limits: { step_attempts: 100, active_ms: 900000 },
          },
        }),
        checkRecoveryCandidate: async () => {
          calls.push("build");
          return { ok: true };
        },
        executeOccurrence: async (data: { node_id: string }) => ({
          kind: "complete",
          step_id: randomUUID(),
          connection_ids: data.node_id === trigger.id ? [edge.id] : [],
        }),
        projectExecution: async () => {},
        endCaseExecution: async (_id: string, result: { status: string }) => {
          calls.push(`run:${result.status}`);
        },
        createRecoveryRegression: async () => {
          calls.push("regression");
          return hasSuite ? evaluationId : null;
        },
        prepareEvaluation: async () => ({
          evaluation_id: evaluationId,
          deadline_at: new Date(Date.now() + 600000).toISOString(),
          result_ids: [],
        }),
        checkEvaluationBuild: async () => ({ ok: true }),
        endEvaluation: async () => {
          calls.push("evaluation");
        },
        decideRecovery: async () => ({ done: true }),
        endRepair: async () => {
          calls.push("unexpected-stop");
        },
        createRepairEvaluation: async () => {
          throw new Error(
            "Run recovery must not launch repeated confirmation.",
          );
        },
      },
    });
    await worker.runUntil(async () => {
      await env.client.workflow.execute("repairImplementation", {
        taskQueue,
        workflowId: randomUUID(),
        args: [randomUUID()],
      });
    });
    expect(calls).toEqual([
      "attempt",
      "generate",
      ...(hasSuite ? ["generate"] : []),
      "build",
      "run:completed",
      "regression",
      ...(hasSuite ? ["evaluation"] : []),
    ]);
  },
  20000,
);

it("captures heartbeat settings and rejects missing or changed measurement policies", async () => {
  const { evaluationConfiguration, assertEvaluationConfiguration } = await import("../src/server/evaluations/configuration");
  const current = evaluationConfiguration() as Record<string, unknown>;
  expect(current.activity_heartbeat).toEqual(RUNTIME_HEARTBEAT_POLICY);
  const legacy = { ...current }; delete legacy.activity_heartbeat;
  for (const settings of [legacy, { ...current, activity_heartbeat: { ...RUNTIME_HEARTBEAT_POLICY, timeout_ms: 20000 } }]) {
    expect(() => assertEvaluationConfiguration(settings as Parameters<typeof assertEvaluationConfiguration>[0]))
      .toThrow("Execution settings changed");
  }
  expect(() => assertEvaluationConfiguration(current as Parameters<typeof assertEvaluationConfiguration>[0])).not.toThrow();
});
