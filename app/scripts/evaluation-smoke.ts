import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import { Connection, Client } from "@temporalio/client";
import { getDatabase, configuredDatabaseUrl } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { runtimeFixture } from "../tests/fixtures/runtime";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { caseInput } from "../src/domain/evaluation";
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
  const f = await runtimeFixture(db, new ArtifactService(db));
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const suites = new SuiteService(db),
    evals = new EvaluationService(db);
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Synthetic packet checks",
    parent_suite_version_id: null,
  });
  for (const [key, name, expected, human] of [
    ["complete", "Complete packet", "SYNTHETIC-001", true],
    ["mismatch", "Incorrect shipment identity", "WRONG", true],
    ["missing-response", "Missing approval fixture", "SYNTHETIC-001", false],
  ] as const) {
    const c = await suites.addCase(
      f.w.id,
      suite.id,
      caseInput.parse({
        case_key: key,
        name,
        kind: "workflow",
        input_bundle_id: f.bundle.id,
        human_responses: human
          ? [
              {
                node_id: f.nodes[1].id,
                node_visit_number: 1,
                response: {
                  type: "approval",
                  approved: true,
                  text: "Synthetic approval",
                },
              },
            ]
          : [],
        assertions: [
          {
            key: "shipment",
            label: "Shipment identity",
            path: ["shipment"],
            expected,
          },
        ],
      }),
    );
    await suites.verifyCase(f.w.id, suite.id, c.id, {
      expected_revision: c.revision,
    });
  }
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const { job, evaluation } = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  });
  console.log(
    JSON.stringify({
      workflow_id: f.w.id,
      evaluation_id: evaluation.id,
      job_id: job.id,
    }),
  );
  const handle = await client.workflow.start("evaluateSuite", {
    workflowId: `job-${job.id}`,
    taskQueue: config.taskQueue,
    args: [job.id],
    workflowIdReusePolicy: "REJECT_DUPLICATE",
  });
  await handle.result();
  const state = await evals.state(f.w.id, evaluation.id);
  const outcomes = state.results.map((r) => r.outcome).sort();
  console.log(
    JSON.stringify({
      status: state.runs[0].status,
      verdict: state.runs[0].verdict,
      outcomes,
      codes: state.results.map((r) => r.failure_code),
    }),
  );
  if (
    state.runs[0].status !== "completed" ||
    state.runs[0].verdict !== "inconclusive" ||
    JSON.stringify(outcomes) !== JSON.stringify(["error", "failed", "passed"])
  )
    process.exitCode = 1;
} finally {
  await connection.close();
  await db.close();
}
