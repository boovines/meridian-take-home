import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import { getDatabase, configuredDatabaseUrl } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { runtimeFixture } from "../tests/fixtures/runtime";
import { RunService } from "../src/server/runtime/run-service";
import { HumanService } from "../src/server/runtime/human-service";
import { runById } from "../src/server/runtime/store";
import { temporalConfig } from "../src/server/integrations/temporal-config";
nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--live") || !configuredDatabaseUrl())
  throw new Error(
    "Run from app/ with --live and configured Supabase/Temporal/Sandbox access.",
  );
const db = await getDatabase(),
  config = temporalConfig(),
  connection = await Connection.connect(config.connection);
const client = new Client({ connection, namespace: config.namespace });
try {
  const resume = process.argv.indexOf("--resume");
  const run =
    resume >= 0
      ? await runById(db, process.argv[resume + 1])
      : (await runtimeFixture(db, new ArtifactService(db))).run;
  if (resume < 0)
    await client.workflow.start("executeWorkflow", {
      workflowId: `job-${run.job_id}`,
      taskQueue: config.taskQueue,
      args: [run.job_id],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  const service = new RunService(db);
  let state = await service.state(run.workflow_id, run.id);
  for (
    let i = 0;
    i < 90 &&
    ![
      "waiting_for_human",
      "completed",
      "failed",
      "needs_attention",
      "cancelled",
    ].includes(state.runs[0].status);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 2000));
    state = await service.state(run.workflow_id, run.id);
  }
  console.log(
    JSON.stringify({
      stage: "observed",
      workflow_id: run.workflow_id,
      run_id: run.id,
      status: state.runs[0].status,
      steps: state.steps.map((s) => ({
        status: s.status,
        node_visit_number: s.node_visit_number,
      })),
    }),
  );
  if (process.argv.includes("--leave-waiting")) {
    if (state.runs[0].status !== "waiting_for_human") process.exitCode = 1;
  } else {
    const request = state.human_requests.find((h) => h.status === "pending");
    if (request) {
      await new HumanService(db).answer(run.workflow_id, String(request.id), {
        request_key: randomUUID(),
        response: {
          type: "approval",
          approved: true,
          text: "Synthetic packet approved for the runtime integration check.",
        },
      });
      // Worker outbox delivers the durable response; the script does not shortcut it.
    }
    await client.workflow.getHandle(`job-${run.job_id}`).result();
    state = await service.state(run.workflow_id, run.id);
    console.log(
      JSON.stringify({
        stage: "finished",
        status: state.runs[0].status,
        completed_steps: state.steps.filter((s) => s.status === "completed")
          .length,
        human_responses: state.human_requests.filter(
          (h) => h.status === "answered",
        ).length,
        outputs: state.steps.map((s) => s.output_data),
      }),
    );
    if (state.runs[0].status !== "completed" || state.steps.length !== 3)
      process.exitCode = 1;
  }
} finally {
  await connection.close();
  await db.close();
}
