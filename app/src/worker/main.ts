import nextEnv from "@next/env";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { temporalConfig } from "../server/integrations/temporal-config";
import { startOutbox } from "./dispatch-outbox";
import * as activities from "./activities";
import { getDatabase } from "../server/database";
import {
  RUNTIME_HEARTBEAT_POLICY,
  WORKER_ACTIVITY_CONCURRENCY,
} from "../domain/runtime-policy";
nextEnv.loadEnvConfig(process.cwd());
const db = await getDatabase();
const config = temporalConfig();
let connection: NativeConnection | undefined;
try {
  connection = await NativeConnection.connect(config.connection);
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
    maxConcurrentActivityTaskExecutions: WORKER_ACTIVITY_CONCURRENCY,
    maxHeartbeatThrottleInterval: RUNTIME_HEARTBEAT_POLICY.max_throttle_ms,
  });
  console.log("Meridian worker ready.");
  const stopOutbox = startOutbox(db);
  try {
    await worker.run();
  } finally {
    stopOutbox();
  }
} finally {
  await connection?.close();
  await db.close();
}
