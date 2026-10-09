import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { ArtifactService } from "../src/server/artifacts/service";
import { LocalObjectStore } from "../src/server/artifacts/storage";
import { BundleService } from "../src/server/runtime/bundle-service";
import { runtimeFixture } from "./fixtures/runtime";
import { fixtureSources } from "./fixtures/engineer";
import { RepairService } from "../src/server/repairs/service";
import {
  RepairGenerationService,
  type RepairGenerator,
} from "../src/server/repairs/generation-service";
import { ClarificationService } from "../src/server/repairs/clarification-service";
import { RunRecoveryService } from "../src/server/repairs/run-recovery-service";
import { JobService } from "../src/server/engineering/job-service";
let db: Database, artifacts: ArtifactService, dir: string;
beforeAll(async () => {
  db = await createDatabase();
  await migrate(db);
  dir = await mkdtemp(path.join(os.tmpdir(), "clarification-"));
  artifacts = new ArtifactService(db, new LocalObjectStore(dir));
});
afterAll(async () => {
  await db?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function prepared() {
  const f = await runtimeFixture(db, artifacts, ["trigger", "outcome"]);
  await f.runs.finish(f.job.id, { status: "cancelled" });
  const doc = await artifacts.create(
    f.w.id,
    "source_document",
    "source.txt",
    "text/plain",
    Buffer.from("REG is the registration number. Value: 112233"),
  );
  const bundle = await new BundleService(db).create(f.w.id, {
    source_kind: "fixture",
    shipment_reference: "DEMO",
    manifest: {
      input: {
        documents: [
          {
            artifact_id: doc.id,
            name: doc.display_name,
            media_type: doc.media_type,
            byte_size: doc.byte_size,
          },
        ],
      },
      artifacts: [
        { artifact_id: doc.id, name: doc.display_name, message_id: null },
      ],
      message_ids: [],
    },
  });
  const source = await f.runs.start(f.w.id, {
    request_key: randomUUID(),
    implementation_version_id: f.version.id,
    input_bundle_id: String(bundle.id),
    rerun_of_id: null,
  });
  await f.runs.prepare(source.job.id);
  await f.runs.finish(source.job.id, {
    status: "failed",
    error: {
      category: "implementation",
      code: "FIELD_INVALID",
      message: "Registration field not interpreted.",
    },
  });
  const recovery = new RunRecoveryService(db),
    repairs = new RepairService(db),
    questions = new ClarificationService(db),
    generation = new RepairGenerationService(db, artifacts);
  const { job, session } = await recovery.start(f.w.id, source.run.id, {
    request_key: randomUUID(),
  });
  await repairs.prepare(job.id);
  const attempt = await repairs.beginAttempt(job.id, 1);
  return {
    ...f,
    doc,
    bundle,
    source,
    recovery,
    repairs,
    questions,
    generation,
    job,
    session,
    attempt,
  };
}
const ask: RepairGenerator = {
  model: "fixture",
  generate: async (c) => ({
    diagnosis: {
      summary: "Clarify the registration label.",
      affected_node_ids: [c.steps[0].node_id],
      changes: [],
    },
    project: {
      status: "needs_attention",
      explanation: "Engineer clarification needed.",
      steps: [],
    },
    clarification: {
      question: "Does REG refer to registration number?",
      why_needed:
        "The existing rule requires registration but the label is abbreviated.",
      node_ids: [c.steps[0].node_id],
      source_artifact_ids: [
        String(c.input_inventory[0].documents[0].artifact_id),
      ],
      audit_event_ids: [],
    },
  }),
};
function patch(inspect: boolean): RepairGenerator {
  return {
    model: "fixture",
    generate: async (c, _b, _s, _p, read) => {
      if (inspect)
        await read(String(c.input_inventory[0].documents[0].artifact_id));
      const project = fixtureSources(c.spec.board, c.steps);
      project.steps.forEach((s) =>
        s.source_lines.push("// Clarified label parsing."),
      );
      return {
        clarification_assessment: {
          disposition: "clarifies_existing_rules",
          reason:
            "Only an abbreviation in the existing registration requirement is clarified.",
        },
        diagnosis: {
          summary: "Read the abbreviated registration label.",
          affected_node_ids: c.steps.map((s) => s.node_id),
          changes: ["Interpret the documented abbreviation."],
        },
        project,
      };
    },
  };
}
it("persists question/answer, idempotently resumes without resetting limits, and freezes each invocation context", async () => {
  const f = await prepared();
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  const q = (await f.questions.questionForAttempt(f.attempt.id))!;
  expect(
    (await f.recovery.state(f.w.id, f.source.run.id))!.questions,
  ).toHaveLength(1);
  expect(
    (await db.query("SELECT status FROM workflow_jobs WHERE id=$1", [f.job.id]))
      .rows[0].status,
  ).toBe("waiting_for_human");
  const before = (
    await db.query("SELECT invocation_count FROM repair_attempts WHERE id=$1", [
      f.attempt.id,
    ])
  ).rows[0];
  // Re-delivery while waiting never buys another generation.
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  expect(
    (
      await db.query(
        "SELECT invocation_count FROM repair_attempts WHERE id=$1",
        [f.attempt.id],
      )
    ).rows[0],
  ).toEqual(before);
  const oldDeadline = new Date(
    String(
      (
        await db.query("SELECT deadline_at FROM workflow_jobs WHERE id=$1", [
          f.job.id,
        ])
      ).rows[0].deadline_at,
    ),
  ).getTime();
  await db.query(
    "UPDATE repair_sessions SET paused_at=now()-interval '10 minutes' WHERE id=$1",
    [f.session.id],
  );
  const input = {
    request_key: randomUUID(),
    answer: "REG means registration number; inspect the source label.",
    reuse: false,
  };
  await f.questions.answer(f.w.id, q.id, input);
  const resumedDeadline = (
    await db.query("SELECT deadline_at FROM workflow_jobs WHERE id=$1", [
      f.job.id,
    ])
  ).rows[0].deadline_at;
  expect(
    new Date(String(resumedDeadline)).getTime() - oldDeadline,
  ).toBeGreaterThanOrEqual(600000);
  await f.questions.answer(f.w.id, q.id, input);
  expect(
    (
      await db.query("SELECT deadline_at FROM workflow_jobs WHERE id=$1", [
        f.job.id,
      ])
    ).rows[0].deadline_at,
  ).toEqual(resumedDeadline);
  await expect(
    f.questions.answer(f.w.id, q.id, { ...input, answer: "Different" }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  await f.generation.run(f.attempt.id, patch(true), AbortSignal.timeout(10000));
  const contexts = (
    await db.query(
      "SELECT clarifications FROM repair_clarification_contexts WHERE attempt_id=$1 ORDER BY invocation_number",
      [f.attempt.id],
    )
  ).rows;
  expect(contexts[0].clarifications).toEqual([]);
  expect(contexts[1].clarifications).toMatchObject([
    { question_id: q.id, scope: "captured_input", answer: input.answer },
  ]);
  expect(
    (
      await db.query(
        "SELECT id FROM workflow_clarifications WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
  expect(
    (
      await db.query(
        "SELECT invocation_count FROM repair_attempts WHERE id=$1",
        [f.attempt.id],
      )
    ).rows[0].invocation_count,
  ).toBe(2);
  await expect(
    db.query(
      "UPDATE repair_clarification_contexts SET clarifications='[]' WHERE attempt_id=$1",
      [f.attempt.id],
    ),
  ).rejects.toThrow(/immutable/);
  await f.repairs.finish(f.job.id, "cancelled", "Fixture complete");
});
it("rejects a patch based only on an engineer answer without inspecting documentary evidence again", async () => {
  const f = await prepared();
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  const q = (await f.questions.questionForAttempt(f.attempt.id))!;
  await f.questions.answer(f.w.id, q.id, {
    request_key: randomUUID(),
    answer: "The number is 112233.",
    reuse: false,
  });
  await expect(
    f.generation.run(f.attempt.id, patch(false), AbortSignal.timeout(10000)),
  ).rejects.toMatchObject({ code: "CLARIFICATION_EVIDENCE_REQUIRED" });
  expect(
    (
      await db.query(
        "SELECT candidate_version_id FROM repair_attempts WHERE id=$1",
        [f.attempt.id],
      )
    ).rows[0].candidate_version_id,
  ).toBeNull();
  await f.repairs.finish(f.job.id, "needs_attention", "Evidence required");
});
it("requires opt-in for workflow reuse and keeps the approved process immutable", async () => {
  const f = await prepared();
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  const q = (await f.questions.questionForAttempt(f.attempt.id))!;
  const before = (
    await db.query("SELECT graph FROM frozen_specs WHERE workflow_id=$1", [
      f.w.id,
    ])
  ).rows[0];
  await f.questions.answer(f.w.id, q.id, {
    request_key: randomUUID(),
    answer: "REG is the registration label.",
    reuse: true,
  });
  expect(
    (
      await db.query(
        "SELECT question_id FROM workflow_clarifications WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toEqual([{ question_id: q.id }]);
  await f.generation.run(f.attempt.id, patch(true), AbortSignal.timeout(10000));
  const c = (
    await db.query(
      "SELECT clarifications FROM repair_clarification_contexts WHERE attempt_id=$1 ORDER BY invocation_number DESC LIMIT 1",
      [f.attempt.id],
    )
  ).rows[0].clarifications;
  expect(c).toMatchObject([{ scope: "workflow" }]);
  expect(
    (
      await db.query("SELECT graph FROM frozen_specs WHERE workflow_id=$1", [
        f.w.id,
      ])
    ).rows[0],
  ).toEqual(before);
  await f.repairs.finish(f.job.id, "cancelled", "Fixture complete");
});
it("cancels an open question and rejects a late answer across service restarts", async () => {
  const f = await prepared();
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  const q = (await f.questions.questionForAttempt(f.attempt.id))!;
  await new JobService(db).requestCancel(f.w.id, f.job.id);
  await expect(
    new ClarificationService(db).answer(f.w.id, q.id, {
      request_key: randomUUID(),
      answer: "Late",
      reuse: false,
    }),
  ).rejects.toMatchObject({ code: "QUESTION_INACTIVE" });
  await f.repairs.finish(f.job.id, "cancelled", "Canceled while waiting");
  expect((await f.questions.questionForAttempt(f.attempt.id))?.status).toBe(
    "cancelled",
  );
  expect(
    (
      await db.query(
        "SELECT id FROM workflow_clarifications WHERE workflow_id=$1",
        [f.w.id],
      )
    ).rows,
  ).toHaveLength(0);
});
it("stops when the proposed answer changes the process rather than clarifying it", async () => {
  const f = await prepared();
  await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
  const q = (await f.questions.questionForAttempt(f.attempt.id))!;
  await f.questions.answer(f.w.id, q.id, {
    request_key: randomUUID(),
    answer: "Skip the required registration check entirely.",
    reuse: false,
  });
  const adapter: RepairGenerator = {
    model: "fixture",
    generate: async (...args) => ({
      ...(await patch(true).generate(...args)),
      clarification_assessment: {
        disposition: "requires_process_change",
        reason:
          "Removing a required field check contradicts the frozen process.",
      },
    }),
  };
  await expect(
    f.generation.run(f.attempt.id, adapter, AbortSignal.timeout(10000)),
  ).rejects.toMatchObject({ code: "PROCESS_CHANGE_REQUIRED" });
  expect(
    (
      await db.query(
        "SELECT candidate_version_id FROM repair_attempts WHERE id=$1",
        [f.attempt.id],
      )
    ).rows[0].candidate_version_id,
  ).toBeNull();
  await f.repairs.finish(
    f.job.id,
    "needs_attention",
    "Process change required",
  );
});
it("keeps input-specific answers out of another captured input and includes explicitly reused ones", async () => {
  for (const reuse of [false, true]) {
    const f = await prepared();
    await f.generation.run(f.attempt.id, ask, AbortSignal.timeout(10000));
    const q = (await f.questions.questionForAttempt(f.attempt.id))!;
    await f.questions.answer(f.w.id, q.id, {
      request_key: randomUUID(),
      answer: "REG means registration.",
      reuse,
    });
    await f.repairs.finish(f.job.id, "cancelled", "New independent input");
    const bundle = await new BundleService(db).create(f.w.id, {
      source_kind: "fixture",
      shipment_reference: "OTHER",
      manifest: { input: {}, artifacts: [], message_ids: [] },
    });
    const run = await f.runs.start(f.w.id, {
      request_key: randomUUID(),
      implementation_version_id: f.version.id,
      input_bundle_id: String(bundle.id),
      rerun_of_id: null,
    });
    await f.runs.prepare(run.job.id);
    await f.runs.finish(run.job.id, {
      status: "failed",
      error: {
        category: "implementation",
        code: "OUTPUT_INVALID",
        message: "Different input.",
      },
    });
    const { job } = await f.recovery.start(f.w.id, run.run.id, {
      request_key: randomUUID(),
    });
    await f.repairs.prepare(job.id);
    const attempt = await f.repairs.beginAttempt(job.id, 1);
    await f.repairs.claimGeneration(attempt.id);
    const context = await f.repairs.generationContext(attempt.id);
    expect(
      "clarification_context" in context &&
        context.clarification_context?.clarifications,
    ).toHaveLength(reuse ? 1 : 0);
    await f.repairs.finish(job.id, "cancelled", "Fixture complete");
  }
});
