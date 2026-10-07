// Live synthetic check: faulty fixture -> real OpenAI repair -> isolated full-suite evaluation.
import nextEnv from "@next/env";
import { randomUUID } from "node:crypto";
import {
  Connection,
  Client,
  WorkflowExecutionAlreadyStartedError,
} from "@temporalio/client";
import { getDatabase, configuredDatabaseUrl } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { runtimeFixture } from "../tests/fixtures/runtime";
import { fixtureSources } from "../tests/fixtures/engineer";
import { GenerationService } from "../src/server/engineering/generation-service";
import { JobService } from "../src/server/engineering/job-service";
import { PlanService } from "../src/server/engineering/plan-service";
import { BundleService } from "../src/server/runtime/bundle-service";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { RepairService } from "../src/server/repairs/service";
import { caseInput } from "../src/domain/evaluation";
import { temporalConfig } from "../src/server/integrations/temporal-config";
import { validateInSandbox } from "../src/server/integrations/sandbox-project";
nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--live") || !configuredDatabaseUrl())
  throw new Error(
    "Use --live with configured Supabase, Temporal, OpenAI and Vercel Sandbox.",
  );
const db = await getDatabase(),
  config = temporalConfig(),
  connection = await Connection.connect(config.connection);
const client = new Client({ connection, namespace: config.namespace });
async function execute(name: string, id: string) {
  let handle;
  try {
    handle = await client.workflow.start(name, {
      workflowId: `job-${id}`,
      taskQueue: config.taskQueue,
      args: [id],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  } catch (e) {
    if (!(e instanceof WorkflowExecutionAlreadyStartedError)) throw e;
    handle = client.workflow.getHandle(`job-${id}`);
  }
  await handle.result();
}
try {
  const artifacts = new ArtifactService(db);
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"], {
    name: "Synthetic repair verification",
    desired_outcome:
      "Report the number of failed goods while preserving the shipment identifier.",
    instructions: {
      trigger:
        "Accept a captured input containing shipment (string) and goods (array). Each good has a missing_fields array. Pass the original input to the next step.",
      outcome:
        "Return an object containing shipment and failed_goods. Preserve the input shipment identifier. A good with any missing_fields is one failed good, regardless of how many fields it lacks. A good with an empty missing_fields array passes. Count each failed good exactly once. Return failed_goods=0 when all goods pass. Do not change the input. This report is only a preview.",
    },
  });
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const job = await new JobService(db).startGeneration(f.w.id, {
    request_key: randomUUID(),
    plan_version_id: f.plan.id,
    input_version_id: f.version.id,
  });
  await new GenerationService(db, artifacts).run(
    job.id,
    {
      model: "deliberately-faulty-synthetic-fixture",
      generate: async (c) => {
        const sources = fixtureSources(c.spec.board, c.steps);
        sources.steps.find((s) => s.node_id === f.nodes[1].id)!.source_lines = [
          "export async function run(context) {",
          "  const input = context.input;",
          "  return {kind:'complete', output:{shipment:input.shipment, failed_goods:input.goods.reduce((total, good) => total + good.missing_fields.length, 0)}, matching_connection_ids:[]};",
          "}",
        ];
        return sources;
      },
      validate: validateInSandbox,
    },
    AbortSignal.timeout(120000),
  );
  const version = (await new PlanService(db).state(f.w.id)).versions[0];
  const suites = new SuiteService(db),
    evals = new EvaluationService(db),
    repairs = new RepairService(db);
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Verified failed-good counting",
    parent_suite_version_id: null,
  });
  for (const item of [
    {
      key: "two-fields",
      name: "Two fields on one good",
      fields: [["HTS", "NDC"], []],
      expected: 1,
    },
    { key: "complete", name: "Complete goods", fields: [[], []], expected: 0 },
    {
      key: "two-goods",
      name: "Two separate failed goods",
      fields: [["HTS"], ["NDC"]],
      expected: 2,
    },
  ]) {
    const bundle = await new BundleService(db).create(f.w.id, {
      source_kind: "fixture",
      shipment_reference: `SYNTHETIC-${item.key}`,
      manifest: {
        input: {
          shipment: `SYNTHETIC-${item.key}`,
          goods: item.fields.map((missing_fields) => ({ missing_fields })),
        },
        message_ids: [],
        artifacts: [],
      },
    });
    const c = await suites.addCase(
      f.w.id,
      suite.id,
      caseInput.parse({
        case_key: item.key,
        name: item.name,
        kind: "workflow",
        input_bundle_id: bundle.id,
        assertions: [
          {
            key: "shipment",
            label: "Shipment identity",
            path: ["shipment"],
            expected: `SYNTHETIC-${item.key}`,
          },
          {
            key: "goods",
            label: "Failed goods",
            path: ["failed_goods"],
            expected: item.expected,
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
  const baseline = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: String(version.id),
    suite_version_id: suite.id,
  });
  console.log(
    JSON.stringify({
      workflow_id: f.w.id,
      baseline_evaluation_id: baseline.evaluation.id,
    }),
  );
  await execute("evaluateSuite", baseline.job.id);
  const baselineState = await evals.state(f.w.id, baseline.evaluation.id);
  if (baselineState.runs[0].verdict !== "failed")
    throw new Error(
      `Expected a determinate baseline failure, got ${baselineState.runs[0].verdict}`,
    );
  const repair = await repairs.start(f.w.id, {
    request_key: randomUUID(),
    baseline_evaluation_id: baseline.evaluation.id,
  });
  console.log(
    JSON.stringify({
      repair_job_id: repair.job.id,
      session_id: repair.session.id,
    }),
  );
  await execute("repairImplementation", repair.job.id);
  const state = await repairs.state(f.w.id, repair.session.id);
  console.log(
    JSON.stringify({
      status: state.sessions[0].status,
      stop_reason: state.sessions[0].stop_reason,
      attempts: state.attempts.map((a) => ({
        number: a.attempt_number,
        status: a.status,
        evaluation: a.evaluation_run_id,
      })),
      baseline: state.sessions[0].baseline_version_id,
    }),
  );
  if (state.sessions[0].status !== "passed") process.exitCode = 1;
} finally {
  await connection.close();
  await db.close();
}
