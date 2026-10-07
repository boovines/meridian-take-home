import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { FindingService } from "../src/server/reviews/finding-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { nodeInput, connectionInput } from "../src/domain/canvas";
import {
  findingAction,
  noteInput,
  type ReviewerOutput,
} from "../src/domain/review";
let db: Database,
  canvas: CanvasService,
  reviews: ReviewService,
  findings: FindingService,
  freeze: FreezeService;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Tests require an isolated local/CI database.");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  reviews = new ReviewService(db);
  findings = new FindingService(db);
  freeze = new FreezeService(db);
});
afterAll(async () => {
  await db?.close();
});
async function setup(goal = "Produce a validated shipment report") {
  const w = await canvas.create({ name: "Review test", desired_outcome: goal });
  const start = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "trigger", title: "Receive packet" }),
  );
  const task = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "task",
      title: "Validate fields",
      instructions: "Check invoice",
    }),
  );
  const end = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "outcome", title: "Report result" }),
  );
  for (const [from, to] of [
    [start, task],
    [task, end],
  ])
    await canvas.addConnection(
      w.id,
      connectionInput.parse({ source_node_id: from.id, target_node_id: to.id }),
    );
  return { w, start, task, end };
}
function suggestion(nodeId: string): ReviewerOutput["findings"][number] {
  return {
    action: "new",
    existing_thread_id: null,
    previous_finding_id: null,
    category: "ambiguity",
    title: "Which fields are required?",
    message: "Specify the fields the invoice must contain.",
    node_ids: [nodeId],
    connection_ids: [],
    change_kind: "detail",
    proposal: {
      node_id: nodeId,
      title: null,
      instructions: "Require HTS, ANDA, FDA, REG, and NDC on each good.",
    },
  };
}
async function complete(id: string, items: ReviewerOutput["findings"] = []) {
  const run = await reviews.start(id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.publish(run.id, { findings: items });
  return run;
}
async function action(
  wid: string,
  tid: string,
  kind: "resolve" | "reject" | "reopen" | "apply",
  reason = "",
) {
  const t = (await reviews.state(wid)).threads.find((t) => t.id === tid)!;
  return findings.action(
    wid,
    tid,
    findingAction.parse({
      action: kind,
      expected_revision: t.revision,
      reason,
      request_key: randomUUID(),
    }),
  );
}
it("locks during review, cancels safely, rejects late results and deduplicates starts", async () => {
  const { w, task } = await setup();
  const key = randomUUID();
  const run = await reviews.start(w.id, { request_key: key });
  expect((await reviews.start(w.id, { request_key: key })).id).toBe(run.id);
  await expect(
    canvas.editNode(w.id, task.id, {
      expected_revision: task.revision,
      title: "Edit",
    }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  await reviews.prepare(run.id);
  await reviews.finish(run.id, "cancelled");
  await expect(
    reviews.publish(run.id, { findings: [suggestion(task.id)] }),
  ).rejects.toMatchObject({ code: "REVIEW_INACTIVE" });
  expect((await reviews.state(w.id)).threads).toHaveLength(0);
  expect((await canvas.load(w.id)).workflow.state).toBe("draft");
});
it("captures a missing outcome before analyzing and records both snapshots", async () => {
  const { w } = await setup("");
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  expect(run.status).toBe("awaiting_customer");
  expect(await reviews.prepare(run.id)).toBeNull();
  const answer = {
    desired_outcome: "Validate the packet",
    request_key: randomUUID(),
  };
  await reviews.answerGoal(run.id, answer);
  await reviews.answerGoal(run.id, answer);
  const prepared = await reviews.prepare(run.id);
  expect(prepared!.board.workflow.desired_outcome).toBe(answer.desired_outcome);
  expect(prepared!.run.initial_snapshot.workflow.desired_outcome).toBe("");
  await reviews.publish(run.id, { findings: [] });
  const state = await reviews.state(w.id);
  expect(state.threads[0].status).toBe("closed");
  expect(
    state.messages.filter((m) => m.author_kind === "customer"),
  ).toHaveLength(1);
});
it("applies an approved detail edit and closes its finding atomically", async () => {
  const { w, task } = await setup();
  await complete(w.id, [suggestion(task.id)]);
  const t = (await reviews.state(w.id)).threads[0];
  const result = await action(w.id, t.id, "apply");
  expect(result.status).toBe("closed");
  expect(
    (await canvas.load(w.id)).nodes.find((n) => n.id === task.id)!.instructions,
  ).toContain("HTS, ANDA");
  const history = (await reviews.state(w.id)).messages.at(-1)!;
  expect(history.event_data).toHaveProperty(
    "applied.before.instructions",
    "Check invoice",
  );
});
it("rejects stale proposals without changing the block or closing the finding", async () => {
  const { w, task } = await setup();
  await complete(w.id, [suggestion(task.id)]);
  const t = (await reviews.state(w.id)).threads[0];
  await canvas.editNode(w.id, task.id, {
    expected_revision: task.revision,
    instructions: "Customer revision",
  });
  await expect(action(w.id, t.id, "apply")).rejects.toMatchObject({
    code: "STALE_PROPOSAL",
  });
  expect((await reviews.state(w.id)).threads[0].status).toBe("open");
  expect(
    (await canvas.load(w.id)).nodes.find((n) => n.id === task.id)!.instructions,
  ).toBe("Customer revision");
});
it("requires reasons for manual disposition, preserves reopen history, and forbids AI reopening", async () => {
  const { w, task } = await setup();
  await complete(w.id, [suggestion(task.id)]);
  const t = (await reviews.state(w.id)).threads[0];
  await expect(action(w.id, t.id, "resolve")).rejects.toMatchObject({
    code: "REASON_REQUIRED",
  });
  await action(
    w.id,
    t.id,
    "reject",
    "This detail is deliberately deferred to the receiving manager.",
  );
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await expect(
    reviews.publish(run.id, {
      findings: [
        {
          ...suggestion(task.id),
          action: "followup",
          existing_thread_id: t.id,
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "CLOSED_FINDING" });
  await reviews.finish(run.id, "cancelled");
  await action(w.id, t.id, "reopen");
  expect(
    (await reviews.state(w.id)).messages.at(-1)!.event_data,
  ).toHaveProperty("previous_resolution", "rejected");
});
it("auto-closes only findings whose sole referenced block was deleted", async () => {
  const { w, task, end } = await setup();
  await complete(w.id, [
    suggestion(task.id),
    {
      ...suggestion(task.id),
      title: "Both steps",
      node_ids: [task.id, end.id],
      proposal: null,
    },
  ]);
  await canvas.deleteNode(w.id, task.id, task.revision);
  const threads = (await reviews.state(w.id)).threads;
  expect(
    threads.find((t) => t.title === "Which fields are required?")!
      .resolution_kind,
  ).toBe("target_deleted");
  expect(threads.find((t) => t.title === "Both steps")!.status).toBe("open");
});
it("rolls back a malformed review instead of publishing partial findings", async () => {
  const { w, task } = await setup();
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await expect(
    reviews.publish(run.id, {
      findings: [suggestion(task.id), suggestion(randomUUID())],
    }),
  ).rejects.toMatchObject({ code: "INVALID_AI_ANCHOR" });
  expect((await reviews.state(w.id)).threads).toHaveLength(0);
  await reviews.finish(run.id, "failed", "Invalid review result.");
  expect((await canvas.load(w.id)).workflow.state).toBe("draft");
});
it("requires a completed review and explicit acknowledgment of subsequent semantic edits; notes do not block", async () => {
  const { w, task } = await setup();
  let board = await canvas.load(w.id);
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: board.workflow.content_revision,
      acknowledge_unreviewed: false,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
  await complete(w.id);
  await findings.note(
    w.id,
    noteInput.parse({
      title: "Discussion",
      body: "Optional follow-up",
      request_key: randomUUID(),
    }),
  );
  await canvas.editNode(w.id, task.id, {
    expected_revision: task.revision,
    instructions: "All five fields are required.",
  });
  board = await canvas.load(w.id);
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: board.workflow.content_revision,
      acknowledge_unreviewed: false,
    }),
  ).rejects.toMatchObject({ code: "UNREVIEWED_CHANGES" });
  const spec = await freeze.freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: true,
  });
  expect(spec.unreviewed_changes_acknowledged).toBe(true);
  expect((await canvas.load(w.id)).workflow.state).toBe("frozen");
  await expect(
    db.query("UPDATE nodes SET title=$2 WHERE id=$1", [task.id, "Tamper"]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(
    db.query("UPDATE frozen_specs SET graph=$2 WHERE id=$1", [spec.id, {}]),
  ).rejects.toMatchObject({ code: "23514" });
  await expect(action(w.id, randomUUID(), "reopen")).rejects.toBeDefined();
});
it("blocks open findings and disconnected blocks even after review", async () => {
  const { w, task } = await setup();
  await complete(w.id, [suggestion(task.id)]);
  let ready = await freeze.readiness(w.id);
  expect(ready.open_findings).toHaveLength(1);
  await action(
    w.id,
    String(ready.open_findings[0].id),
    "resolve",
    "The manager verifies these fields.",
  );
  await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "task", title: "Orphan" }),
  );
  ready = await freeze.readiness(w.id);
  expect(ready.issues.some((i) => i.code === "DISCONNECTED")).toBe(true);
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: ready.board.workflow.content_revision,
      acknowledge_unreviewed: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
});
it("expires abandoned review work and unlocks the board", async () => {
  const { w } = await setup();
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await db.query(
    "UPDATE review_runs SET deadline_at=now()-interval '1 second' WHERE id=$1",
    [run.id],
  );
  expect((await reviews.state(w.id)).runs[0].status).toBe("failed");
  expect((await canvas.load(w.id)).workflow.state).toBe("draft");
});
