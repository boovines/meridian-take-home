import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import { getDatabase, configuredDatabaseUrl } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { nodeInput, connectionInput } from "../src/domain/canvas";
import { temporalConfig } from "../src/server/integrations/temporal-config";
nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--live"))
  throw new Error(
    "Pass --live to create a synthetic workflow and consume a bounded model request.",
  );
if (!configuredDatabaseUrl() || !process.env.OPENAI_API_KEY)
  throw new Error(
    "Live verification requires the configured Supabase database and OpenAI key. Run from app/.",
  );
const db = await getDatabase(),
  canvas = new CanvasService(db),
  reviews = new ReviewService(db);
const config = temporalConfig(),
  connection = await Connection.connect(config.connection);
try {
  const w = await canvas.create({
    name: `Live review verification ${new Date().toISOString()}`,
    desired_outcome:
      "Preview a report identifying missing invoice fields. Do not send email. This is a synthetic integration check.",
  });
  const a = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "trigger",
      x:80,y:60,
      title: "Select a packet",
      instructions:
        "Input is a selected existing email containing one readable invoice attachment.",
    }),
  );
  const b = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "task",
      x:80,y:250,
      title: "Check invoice",
      instructions:
        "Check that each good has HTS, ANDA, FDA, REG, and NDC values. List the missing field names per good; one good missing two fields is one failed good. Any failed good makes its invoice fail.",
    }),
  );
  const c = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "outcome",
      x:80,y:440,
      title: "Preview report",
      instructions:
        "Show the invoice number, failed goods, and missing field names. If unreadable, show needs attention. Do not send the report.",
    }),
  );
  for (const [from, to] of [
    [a, b],
    [b, c],
  ])
    await canvas.addConnection(
      w.id,
      connectionInput.parse({ source_node_id: from.id, target_node_id: to.id }),
    );
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  const client = new Client({ connection, namespace: config.namespace });
  const handle = await client.workflow.start("reviewDraft", {
    workflowId: `review-${run.id}`,
    taskQueue: config.taskQueue,
    args: [run.id],
    workflowExecutionTimeout: "5 minutes",
    workflowIdReusePolicy: "REJECT_DUPLICATE",
  });
  await handle.result();
  const result = await reviews.state(w.id);
  console.log(
    JSON.stringify({
      workflowId: w.id,
      reviewId: run.id,
      status: result.runs[0].status,
      findings: result.threads.filter((t) => t.kind === "finding").length,
      model: result.runs[0].model,
    }),
  );
  if (result.runs[0].status !== "completed") process.exitCode = 1;
} finally {
  await connection.close();
  await db.close();
}
