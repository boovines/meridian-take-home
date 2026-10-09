import { expect, it, afterAll, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { heartbeat, cancellationSignal } from "@temporalio/activity";
import path from "node:path";
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120000);
afterAll(async () => {
  await env?.teardown();
});
it("durable scoping retries a failed activity then completes once", async () => {
  let attempts = 0;
  const endings: string[] = [];
  const queue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: queue,
    workflowsPath: path.resolve("src/worker/scoping-workflow.ts"),
    activities: {
      performScoping: async () => {
        if (++attempts === 1) throw new Error("Temporary provider failure");
      },
      endScoping: async (_: string, status: string) => {
        endings.push(status);
      },
    },
  });
  await worker.runUntil(async () => {
    await env.client.workflow.execute("scopeWorkflow", {
      workflowId: randomUUID(),
      taskQueue: queue,
      args: [randomUUID()],
    });
  });
  expect(attempts).toBe(2);
  expect(endings).toEqual([]);
});
it("cancellation records the terminal state even while model work is pending", async () => {
  const started = Promise.withResolvers<void>(),
    endings: string[] = [],
    queue = randomUUID();
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: queue,
    workflowsPath: path.resolve("src/worker/scoping-workflow.ts"),
    maxHeartbeatThrottleInterval: 50,
    activities: {
      performScoping: async () => {
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
          signal.throwIfAborted();
        } finally {
          clearInterval(pulse);
        }
      },
      endScoping: async (_: string, status: string) => {
        endings.push(status);
      },
    },
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("scopeWorkflow", {
      workflowId: randomUUID(),
      taskQueue: queue,
      args: [randomUUID()],
    });
    await started.promise;
    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();
  });
  expect(endings).toEqual(["cancelled"]);
});
