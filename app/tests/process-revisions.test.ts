import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { ProcessRevisionService } from "../src/server/process-revisions/service";
import {
  PlanService,
  specForPlan,
} from "../src/server/engineering/plan-service";
import { JobService } from "../src/server/engineering/job-service";
import { nodeInput, connectionInput } from "../src/domain/canvas";
let db: Database, canvas: CanvasService, revisions: ProcessRevisionService;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use isolated persistence.");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  revisions = new ProcessRevisionService(db);
});
afterAll(async () => {
  await db?.close();
});
async function review(id: string) {
  const service = new ReviewService(db);
  const run = await service.start(id, { request_key: randomUUID() });
  await service.prepare(run.id);
  await service.publish(run.id, { findings: [] });
}
async function setup() {
  const w = await canvas.create({
    name: "Generic approval",
    desired_outcome: "Obtain approval and report the decision.",
  });
  const trigger = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "trigger", title: "Start" }),
  );
  const human = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "human_approval",
      title: "Approval",
      instructions: "Approve the request.",
    }),
  );
  const outcome = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "outcome", title: "Report" }),
  );
  for (const [source, target] of [
    [trigger, human],
    [human, outcome],
  ])
    await canvas.addConnection(
      w.id,
      connectionInput.parse({
        source_node_id: source.id,
        target_node_id: target.id,
      }),
    );
  await review(w.id);
  const spec = await new FreezeService(db).freeze(w.id, {
    expected_content_revision: (await canvas.load(w.id)).workflow
      .content_revision,
    acknowledge_unreviewed: false,
  });
  return { w, trigger, human, outcome, spec };
}
it("preserves the frozen process when sending or rejecting a request, including retry identity", async () => {
  const { w, human, spec } = await setup();
  const before = await canvas.load(w.id);
  const input = {
    source_frozen_spec_id: String(spec.id),
    body: "Clarify who approves.",
    node_ids: [human.id],
    request_key: randomUUID(),
  };
  const thread = await revisions.request(w.id, input);
  expect((await revisions.request(w.id, input)).id).toBe(thread.id);
  await expect(
    revisions.request(w.id, { ...input, body: "Different request" }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
  expect(await canvas.load(w.id)).toEqual(before);
  const rejected = await revisions.resolve(w.id, thread.id, {
    action: "reject",
    reason: "The existing approval instruction is sufficient.",
    expected_revision: thread.revision,
    request_key: randomUUID(),
  });
  expect(rejected.resolution_kind).toBe("rejected");
  expect((await canvas.load(w.id)).workflow.state).toBe("frozen");
  expect(
    (await db.query("SELECT * FROM frozen_specs WHERE id=$1", [spec.id]))
      .rows[0],
  ).toEqual(spec);
  const message = (
    await db.query(
      "SELECT author_kind,body FROM discussion_messages WHERE thread_id=$1 ORDER BY message_number",
      [thread.id],
    )
  ).rows[0];
  expect(message).toMatchObject({ author_kind: "engineer", body: input.body });
});
it("starts only one revision, requires a fresh review and request disposition, and keeps old plans pinned", async () => {
  const { w, human, spec } = await setup();
  const plans = new PlanService(db);
  const oldPlan = await plans.create(w.id, {
    request_key: randomUUID(),
    parent_plan_version_id: null,
  });
  const request = await revisions.request(w.id, {
    source_frozen_spec_id: String(spec.id),
    body: "Ask the operations owner to approve.",
    node_ids: [human.id],
    request_key: randomUUID(),
  });
  const first = await revisions.start(w.id, {
    source_frozen_spec_id: String(spec.id),
  });
  const again = await revisions.start(w.id, {
    source_frozen_spec_id: String(spec.id),
  });
  expect(first.workflow).toEqual(again.workflow);
  expect(first.workflow).toMatchObject({
    state: "draft",
    process_version: 2,
    base_frozen_spec_id: spec.id,
    current_frozen_spec_id: spec.id,
  });
  const freeze = new FreezeService(db);
  expect((await freeze.readiness(w.id)).completed_review_id).toBeNull();
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: first.workflow.content_revision,
      acknowledge_unreviewed: false,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
  // Changing a node's kind in v2 cannot erase v1's mandatory human gate.
  await canvas.editNode(w.id, human.id, {
    type: "task",
    instructions: "Record the operations owner decision.",
    expected_revision: human.revision,
  });
  const oldState = await plans.state(w.id);
  const step = oldState.steps.find((s) => s.node_id === human.id)!;
  await expect(
    plans.editStep(w.id, oldPlan.id, human.id, {
      selected_method: "code",
      expected_revision: step.revision,
    }),
  ).rejects.toMatchObject({ code: "HUMAN_REQUIRED" });
  await expect(
    db.query(
      "UPDATE implementation_plan_steps SET selected_method='code' WHERE plan_version_id=$1 AND node_id=$2",
      [oldPlan.id, human.id],
    ),
  ).rejects.toMatchObject({ code: "23514" });
  expect(
    (await specForPlan(db, w.id, oldPlan.id)).board.nodes.find(
      (n) => n.id === human.id,
    )?.type,
  ).toBe("human_approval");
  await review(w.id);
  expect((await freeze.readiness(w.id)).open_findings).toHaveLength(1);
  await revisions.resolve(w.id, request.id, {
    action: "resolve",
    reason:
      "Updated the block instructions; approval is recorded by the owner.",
    expected_revision: request.revision,
    request_key: randomUUID(),
  });
  const board = await canvas.load(w.id);
  const v2 = await freeze.freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  expect(v2).toMatchObject({
    version_number: 2,
    parent_frozen_spec_id: spec.id,
  });
  const v2State = await plans.state(w.id);
  expect(v2State.spec.id).toBe(v2.id);
  expect(v2State.plans).toHaveLength(1);
  expect(v2State.plans[0].state).toBe("draft");
  expect(v2State.steps.every((s) => s.approved_at === null)).toBe(true);
  expect(v2State.versions).toHaveLength(0);
  expect((await plans.state(w.id, String(spec.id))).plans[0].id).toBe(
    oldPlan.id,
  );
  expect(
    (await db.query("SELECT * FROM frozen_specs WHERE id=$1", [spec.id]))
      .rows[0],
  ).toEqual(spec);
  expect(
    (await revisions.start(w.id, { source_frozen_spec_id: String(spec.id) }))
      .workflow.process_version,
  ).toBe(2);
  expect(
    (
      await db.query(
        "SELECT resulting_frozen_spec_id FROM engineer_change_requests WHERE thread_id=$1",
        [request.id],
      )
    ).rows[0].resulting_frozen_spec_id,
  ).toBe(v2.id);
  await expect(
    db.query("UPDATE frozen_specs SET graph='{}' WHERE id=$1", [spec.id]),
  ).rejects.toMatchObject({ code: "23514" });
});

it("continues v1 generation after v2 freezes, and carries only unchanged method choices without approvals", async () => {
  const { w, trigger, human, outcome, spec } = await setup();
  const plans = new PlanService(db);
  const p = await plans.create(w.id, {
    request_key: randomUUID(),
    parent_plan_version_id: null,
  });
  let state = await plans.state(w.id);
  for (const step of state.steps) {
    const selected =
      step.node_id === human.id
        ? step
        : await plans.editStep(w.id, p.id, step.node_id, {
            selected_method: "agent",
            expected_revision: step.revision,
          });
    await plans.editStep(w.id, p.id, step.node_id, {
      approved: true,
      expected_revision: selected.revision,
    });
  }
  state = await plans.state(w.id);
  await plans.approve(w.id, p.id, {
    expected_revision: state.plans[0].revision,
  });
  const jobs = new JobService(db);
  const job = await jobs.startGeneration(w.id, {
    request_key: randomUUID(),
    plan_version_id: p.id,
    input_version_id: null,
  });
  await revisions.start(w.id, { source_frozen_spec_id: String(spec.id) });
  await canvas.editNode(w.id, trigger.id, {
    x: 40,
    y: 50,
    expected_revision: trigger.revision,
  });
  await canvas.editNode(w.id, human.id, {
    instructions: "Ask the operations owner to approve.",
    expected_revision: human.revision,
  });
  await review(w.id);
  const board = await canvas.load(w.id);
  const v2 = await new FreezeService(db).freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  const current = await plans.state(w.id);
  expect(
    current.steps.find((s) => s.node_id === trigger.id)?.selected_method,
  ).toBe("agent");
  expect(
    current.steps.find((s) => s.node_id === outcome.id)?.selected_method,
  ).toBe("code");
  expect(current.steps.every((s) => s.approved_at === null)).toBe(true);
  const prepared = await jobs.prepareGeneration(job.id);
  expect(prepared?.spec.id).toBe(spec.id);
  expect(
    prepared?.spec.board.nodes.find((n) => n.id === human.id)?.instructions,
  ).toBe("Approve the request.");
  expect(current.spec.id).toBe(v2.id);
});

it("discusses frozen requests without edits, applies only explicitly approved draft proposals, and rejects stale edits", async () => {
  const { ReplyService } = await import("../src/server/reviews/reply-service");
  const { ReplyProposalService } = await import(
    "../src/server/reviews/reply-proposal-service"
  );
  const { w, human, spec } = await setup();
  const request = await revisions.request(w.id, {
    source_frozen_spec_id: String(spec.id),
    body: "Identify the approver.",
    node_ids: [human.id],
    request_key: randomUUID(),
  });
  const reply = new ReplyService(db, async () => ({
    outcome: "updated",
    explanation: "Propose naming the operations owner.",
    updates: [
      {
        node_id: human.id,
        instructions: "Ask the operations owner to approve.",
      },
    ],
  }));
  await reply.reply(w.id, request.id, {
    body: "The operations owner approves.",
    parent_message_id: null,
    expected_revision: request.revision,
    request_key: randomUUID(),
  });
  const reviews = new ReviewService(db);
  let state = await reviews.state(w.id);
  const proposal = state.messages.find(
    (m) => m.event_data?.action === "reply_proposed",
  )!;
  let thread = state.threads.find((t) => t.id === request.id)!;
  const decisions = new ReplyProposalService(db);
  await expect(
    decisions.decide(w.id, request.id, proposal.id, {
      decision: "accept",
      node_id: human.id,
      instructions: "Ask the operations owner to approve.",
      expected_revision: thread.revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  expect(
    (await canvas.load(w.id)).nodes.find((n) => n.id === human.id)
      ?.instructions,
  ).toBe("Approve the request.");
  await revisions.start(w.id, { source_frozen_spec_id: String(spec.id) });
  await decisions.decide(w.id, request.id, proposal.id, {
    decision: "accept",
    node_id: human.id,
    instructions: "Ask the operations owner to approve.",
    expected_revision: thread.revision,
    request_key: randomUUID(),
  });
  expect(
    (await canvas.load(w.id)).nodes.find((n) => n.id === human.id)
      ?.instructions,
  ).toBe("Ask the operations owner to approve.");
  state = await reviews.state(w.id);
  thread = state.threads.find((t) => t.id === request.id)!;
  await new ReplyService(db, async () => ({
    outcome: "updated",
    explanation: "Propose clarification.",
    updates: [
      {
        node_id: human.id,
        instructions: "Ask the operations owner or deputy to approve.",
      },
    ],
  })).reply(w.id, request.id, {
    body: "The deputy can also approve.",
    parent_message_id: null,
    expected_revision: thread.revision,
    request_key: randomUUID(),
  });
  state = await reviews.state(w.id);
  thread = state.threads.find((t) => t.id === request.id)!;
  const latest = state.messages
    .filter((m) => m.event_data?.action === "reply_proposed")
    .at(-1)!;
  const node = (await canvas.load(w.id)).nodes.find((n) => n.id === human.id)!;
  await canvas.editNode(w.id, human.id, {
    instructions: "Only the owner may approve.",
    expected_revision: node.revision,
  });
  await expect(
    decisions.decide(w.id, request.id, latest.id, {
      decision: "accept",
      node_id: human.id,
      instructions: "Ask the operations owner or deputy to approve.",
      expected_revision: thread.revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
  expect(
    (await canvas.load(w.id)).nodes.find((n) => n.id === human.id)
      ?.instructions,
  ).toBe("Only the owner may approve.");
  expect(
    (await db.query("SELECT graph FROM frozen_specs WHERE id=$1", [spec.id]))
      .rows[0].graph,
  ).toEqual(spec.graph);
});
