import nextEnv from "@next/env";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { temporalConfig } from "../server/integrations/temporal-config";
import { startOutbox } from "./dispatch-outbox";
import * as activities from "./activities";
import { getDatabase } from "../server/database";
nextEnv.loadEnvConfig(process.cwd());
const config = temporalConfig();
const connection = await NativeConnection.connect(config.connection);
try {
  const worker = await Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities,
    maxConcurrentActivityTaskExecutions: 4,
  });
  console.log("Meridian worker ready.");
  const stopOutbox = startOutbox(await getDatabase());
  try {
    await worker.run();
  } finally {
    stopOutbox();
  }
} finally {
  await connection.close();
  await (await getDatabase()).close();
}
