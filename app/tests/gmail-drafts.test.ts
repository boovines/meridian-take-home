import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { BundleService } from "../src/server/runtime/bundle-service";
import { GmailDraftService } from "../src/server/gmail-drafts/service";
import { ComposioGmail } from "../src/server/integrations/composio-gmail";
import { SuiteService } from "../src/server/evaluations/suite-service";
import { EvaluationService } from "../src/server/evaluations/evaluation-service";
import { caseInput } from "../src/domain/evaluation";
import { runtimeFixture } from "./fixtures/runtime";
let db: Database, artifacts: ArtifactService, directory: string;
beforeAll(async () => {
  db = await createDatabase(process.env.TEST_DATABASE_URL);
  await migrate(db);
  directory = await mkdtemp(path.join(os.tmpdir(), "meridian-drafts-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(directory));
});
afterAll(async () => {
  await db?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(
  options: {
    kind?: string;
    source?: "gmail" | "fixture";
    output?: unknown;
  } = {},
) {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: options.source ?? "gmail",
    shipment_reference: null,
    manifest: {
      input: {
        messages: [
          {
            id: "abcdef0123456789",
            subject: "Fwd: order",
            text: "Order 2 pens.",
          },
        ],
        documents: [],
      },
      artifacts: [],
      message_ids: ["abcdef0123456789"],
    },
  });
  const started = await f.runs.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(bundle.id),
    rerun_of_id: null,
  });
  await f.runs.prepare(started.job.id);
  const stepId = randomUUID();
  await db.query(
    `INSERT INTO step_executions(id,workflow_id,run_id,node_id,occurrence_number,node_visit_number,scheduling_key,status,input_step_refs,output_data,finished_at) VALUES($1,$2,$3,$4,1,1,'result','completed','{}',$5,now())`,
    [
      stepId,
      f.w.id,
      started.run.id,
      f.nodes[1].id,
      options.output ?? {
        preview: { subject: "Fwd: order", body: "purchase order" },
      },
    ],
  );
  // Set kind before finalization; finished evidence stays immutable.

  await db.query(
    "UPDATE workflow_runs SET status='completed',finished_at=now(),result_step_id=$2 WHERE id=$1",
    [started.run.id, stepId],
  );
  const writer = {
      account: "fixture-account",
      create: vi.fn<
        (
          input: { subject: string; body: string; recipient: string },
          signal: AbortSignal,
        ) => Promise<string>
      >(async () => "draft-123"),
    },
    service = new GmailDraftService(db, writer);
  return { ...f, run: started.run, writer, service };
}
it("requires workflow opt-in and creates an unsent blank-recipient draft only once under concurrency", async () => {
  const f = await fixture();
  await expect(
    f.service.create(f.w.id, f.run.id, { recipient: "" }),
  ).rejects.toMatchObject({ code: "DRAFTS_DISABLED" });
  await f.service.configure(f.w.id, true);
  await Promise.all([
    f.service.create(f.w.id, f.run.id, { recipient: "" }),
    f.service.create(f.w.id, f.run.id, { recipient: "" }),
  ]);
  expect(f.writer.create).toHaveBeenCalledTimes(1);
  expect(f.writer.create.mock.calls[0][0]).toMatchObject({
    subject: "Fwd: order",
    body: "purchase order",
    recipient: "",
  });
  expect((await f.service.state(f.w.id, f.run.id)).draft).toMatchObject({
    state: "created",
    draft_id: "draft-123",
  });
  await f.service.create(f.w.id, f.run.id, { recipient: "" });
  expect(f.writer.create).toHaveBeenCalledTimes(1);
  await expect(
    f.service.create(f.w.id, f.run.id, { recipient: "other@example.com" }),
  ).rejects.toMatchObject({ code: "DRAFT_ALREADY_REQUESTED" });
});
it("preserves specified recipient and leaves other workflows disabled", async () => {
  const f = await fixture(),
    other = await fixture();
  await f.service.configure(f.w.id, true);
  await f.service.create(f.w.id, f.run.id, { recipient: "buyer@example.com" });
  expect(f.writer.create.mock.calls[0][0]).toMatchObject({
    recipient: "buyer@example.com",
  });
  expect((await other.service.state(other.w.id, other.run.id)).enabled).toBe(
    false,
  );
});
it("never retries an uncertain provider write", async () => {
  const f = await fixture();
  await f.service.configure(f.w.id, true);
  f.writer.create.mockRejectedValueOnce(new Error("response lost"));
  await expect(
    f.service.create(f.w.id, f.run.id, { recipient: "" }),
  ).rejects.toMatchObject({ code: "DRAFT_UNCERTAIN" });
  expect(
    await f.service.create(f.w.id, f.run.id, { recipient: "" }),
  ).toMatchObject({ state: "uncertain" });
  expect(f.writer.create).toHaveBeenCalledTimes(1);
});
it("blocks fixture bundles and non-preview outputs", async () => {
  for (const opts of [
    { source: "fixture" as const },
    { output: { result_text: "No purchase order found." } },
  ]) {
    const f = await fixture(opts);
    await f.service.configure(f.w.id, true);
    await expect(
      f.service.create(f.w.id, f.run.id, { recipient: "" }),
    ).rejects.toMatchObject({ code: "DRAFT_NOT_ELIGIBLE" });
    expect(f.writer.create).not.toHaveBeenCalled();
  }
});
it("blocks cross-workflow requests and invalid recipients", async () => {
  const f = await fixture(),
    other = await fixture();
  await f.service.configure(f.w.id, true);
  await expect(
    f.service.create(other.w.id, f.run.id, { recipient: "" }),
  ).rejects.toBeDefined();
  await expect(
    f.service.create(f.w.id, f.run.id, {
      recipient: "a@example.com\r\nBcc: attacker@example.com",
    }),
  ).rejects.toBeDefined();
  expect(f.writer.create).not.toHaveBeenCalled();
});
it("uses only the Composio draft tool and parses its wrapped result", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ user_id: "fixture", status: "ACTIVE" }),
    )
    .mockResolvedValueOnce(
      Response.json({
        successful: true,
        data: { id: "r-123", message: { id: "message-123" } },
      }),
    );
  const gmail = new ComposioGmail(
    { key: "fixture", account: "fixture" },
    request,
  );
  expect(
    await gmail.createDraft(
      { subject: "Fwd: order", body: "purchase order", recipient: "" },
      AbortSignal.timeout(1000),
    ),
  ).toBe("r-123");
  expect(String(request.mock.calls[1][0])).toContain(
    "GMAIL_CREATE_EMAIL_DRAFT",
  );
  expect(JSON.parse(String(request.mock.calls[1][1]?.body)).arguments).toEqual({
    user_id: "me",
    subject: "Fwd: order",
    body: "purchase order",
    is_html: false,
  });
});

it("rejects evaluation runs even with a real Gmail bundle", async () => {
  const f = await fixture();
  await f.service.configure(f.w.id, true);
  await db.query(
    "UPDATE workflow_jobs SET status='succeeded',finished_at=now() WHERE id=(SELECT job_id FROM workflow_runs WHERE id=$1)",
    [f.run.id],
  );
  const bundle = (
    await db.query("SELECT input_bundle_id FROM workflow_runs WHERE id=$1", [
      f.run.id,
    ])
  ).rows[0];
  const suites = new SuiteService(db),
    evals = new EvaluationService(db);
  const suite = await suites.create(f.w.id, {
    request_key: randomUUID(),
    name: "Draft isolation",
    parent_suite_version_id: null,
  });
  const c = await suites.addCase(
    f.w.id,
    suite.id,
    caseInput.parse({
      case_key: "real-input",
      name: "Real input evaluation",
      kind: "workflow",
      input_bundle_id: bundle.input_bundle_id,
      assertions: [{ key: "test", label: "test", path: [], expected: {} }],
    }),
  );
  await suites.verifyCase(f.w.id, suite.id, c.id, {
    expected_revision: c.revision,
  });
  await suites.lock(f.w.id, suite.id, {
    expected_revision: (await suites.state(f.w.id)).suites[0].revision,
  });
  const launched = await evals.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    suite_version_id: suite.id,
  });
  const ready = (await evals.prepare(launched.job.id))!;
  const task = await evals.beginCase(ready.results[0].id);
  if (task.skip || task.kind !== "workflow")
    throw new Error("Missing evaluation run");
  const resultId = randomUUID();
  await db.query(
    `INSERT INTO step_executions(id,workflow_id,run_id,node_id,occurrence_number,node_visit_number,scheduling_key,status,input_step_refs,output_data,finished_at) VALUES($1,$2,$3,$4,1,1,'result','completed','{}',$5,now())`,
    [
      resultId,
      f.w.id,
      task.run_id,
      f.nodes[1].id,
      { preview: { subject: "Fwd: order", body: "purchase order" } },
    ],
  );
  await db.query(
    "UPDATE workflow_runs SET status='completed',finished_at=now(),result_step_id=$2 WHERE id=$1",
    [task.run_id, resultId],
  );
  await expect(
    f.service.create(f.w.id, task.run_id, { recipient: "" }),
  ).rejects.toMatchObject({ code: "DRAFT_NOT_ELIGIBLE" });
  expect(f.writer.create).not.toHaveBeenCalled();
});
