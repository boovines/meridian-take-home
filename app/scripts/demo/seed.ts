import nextEnv from "@next/env";
import { getDatabase } from "../../src/server/database";
import { CanvasService } from "../../src/server/canvas/service";
import { nodeInput, connectionInput } from "../../src/domain/canvas";
import { receivingExample } from "./import-receiving";

nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--create"))
  throw new Error(
    "Use npm run demo:seed -- --create [--incomplete] to create a new example draft in the configured database. No emails, reviews, generation, or runs are started.",
  );
const db = await getDatabase();
try {
  const canvas = new CanvasService(db);
  const workflow = await canvas.create({
    name: receivingExample.name,
    desired_outcome: receivingExample.desired_outcome,
  });
  const ids: Record<string, string> = {};
  for (const step of receivingExample.steps) {
    const node = await canvas.addNode(
      workflow.id,
      nodeInput.parse({
        type: step.type,
        title: step.title,
        instructions: process.argv.includes("--incomplete")
          ? step.initial
          : step.instructions,
        x: step.x,
        y: step.y,
        split_mode: step.key === "packet" ? "parallel" : null,
        join_for_split_id: step.key === "validate" ? ids.packet : null,
      }),
    );
    ids[step.key] = node.id;
  }
  for (const [source, target] of [
    ["packet", "invoices"],
    ["packet", "certificates"],
    ["invoices", "validate"],
    ["certificates", "validate"],
    ["validate", "report"],
  ])
    await canvas.addConnection(
      workflow.id,
      connectionInput.parse({
        source_node_id: ids[source],
        target_node_id: ids[target],
      }),
    );
  console.log(`Created draft: /workflows/${workflow.id}`);
  console.log("Review and resolve findings before freezing in the app.");
} finally {
  await db.close();
}
