import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { ReplyService } from "../src/server/reviews/reply-service";
import { ReplyProposalService } from "../src/server/reviews/reply-proposal-service";
import { FindingService } from "../src/server/reviews/finding-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { nodeInput, connectionInput, type Board } from "../src/domain/canvas";
import { messageInput, noteInput, findingAction } from "../src/domain/review";
import {
  replyProposalEvent,
  type ReplyRewriter,
} from "../src/domain/review-reply";
let db: Database, canvas: CanvasService, reviews: ReviewService;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Isolated test database required");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  reviews = new ReviewService(db);
});
afterAll(async () => {
  await db?.close();
});
async function setup(scope: "nodes" | "connection" | "workflow" = "nodes") {
  const w = await canvas.create({
    name: "Reply incorporation",
    desired_outcome: "Validate and report",
  });
  const start = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "trigger", title: "Start" }),
  );
  const first = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "task",
      title: "Validate",
      instructions: "Check fields. Keep manager approval.",
    }),
  );
  const second = await canvas.addNode(
    w.id,
    nodeInput.parse({
      type: "outcome",
      title: "Report",
      instructions: "Report results. Do not send email.",
    }),
  );
  await canvas.addConnection(
    w.id,
    connectionInput.parse({
      source_node_id: start.id,
      target_node_id: first.id,
    }),
  );
  const edge = await canvas.addConnection(
    w.id,
    connectionInput.parse({
      source_node_id: first.id,
      target_node_id: second.id,
    }),
  );
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.publish(run.id, {
    findings: [
      {
        action: "new",
        existing_thread_id: null,
        previous_finding_id: null,
        category: "ambiguity",
        title: "Which fields should be checked and reported?",
        message: "Specify the required fields and report contents.",
        node_ids: scope === "nodes" ? [first.id, second.id] : [],
        connection_ids: scope === "connection" ? [edge.id] : [],
        change_kind: "question",
        proposal: null,
      },
    ],
  });
  const state = await reviews.state(w.id);
  const thread = state.threads[0];
  const data = messageInput.parse({
    body: "Require a batch number and show it in the report.",
    expected_revision: thread.revision,
    parent_message_id: state.messages[0].id,
    request_key: randomUUID(),
  });
  return { w, first, second, thread, data };
}
const rewrite: ReplyRewriter = async ({ targets }) => ({
  outcome: "updated",
  explanation: "Added batch numbers to validation and reporting.",
  updates: targets.map((n) => ({
    node_id: n.id,
    instructions: `${n.instructions} Require a batch number.`,
  })),
});
it("proposes without editing, then atomically accepts multiple blocks and freezes accepted instructions", async () => {
  const { w, first, second, thread, data } = await setup();
  const before = await canvas.load(w.id),
    provider = vi.fn(rewrite),
    service = new ReplyService(db, provider);
  const reply = await service.reply(w.id, thread.id, data);
  expect((await service.reply(w.id, thread.id, data)).id).toBe(reply.id);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(await canvas.load(w.id)).toEqual(before);
  const proposedState = await reviews.state(w.id);
  const proposalMessage = proposedState.messages.at(-1)!;
  expect(proposalMessage.author_kind).toBe("ai");
  const decision = {
    decision: "accept" as const,
    expected_revision: proposedState.threads[0].revision,
    request_key: randomUUID(),
  };
  const proposals = new ReplyProposalService(db);
  const accepted = await proposals.decide(
    w.id,
    thread.id,
    proposalMessage.id,
    decision,
  );
  expect(
    (await proposals.decide(w.id, thread.id, proposalMessage.id, decision)).id,
  ).toBe(accepted.id);
  const board = await canvas.load(w.id);
  expect(board.workflow.content_revision).toBe(
    before.workflow.content_revision + 1,
  );
  for (const n of [first, second])
    expect(board.nodes.find((v) => v.id === n.id)).toMatchObject({
      instructions: `${n.instructions} Require a batch number.`,
      revision: n.revision + 1,
    });
  const state = await reviews.state(w.id);
  expect(state.threads[0].status).toBe("open");
  expect(
    state.messages.filter((m) => m.author_kind === "customer"),
  ).toHaveLength(2);
  const audit = replyProposalEvent.parse(proposalMessage.event_data);
  expect(audit.reply_message_id).toBe(reply.id);
  expect(audit.edits).toHaveLength(2);
  expect(audit.edits[0].before.instructions).toBe(first.instructions);
  await new FindingService(db).action(
    w.id,
    thread.id,
    findingAction.parse({
      action: "resolve",
      reason: "Confirmed",
      expected_revision: state.threads[0].revision,
      request_key: randomUUID(),
    }),
  );
  const freeze = new FreezeService(db);
  expect((await freeze.readiness(w.id)).unreviewed_changes).toBe(true);
  const spec = await freeze.freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: true,
  });
  expect(
    (spec.graph as Board).nodes.find((n) => n.id === first.id)?.instructions,
  ).toContain("Require a batch number");
  expect(JSON.stringify(spec.review_evidence)).toContain(reply.id);
});
it("leaves both blocks and the discussion untouched when inference fails", async () => {
  const { w, thread, data } = await setup(),
    before = await canvas.load(w.id);
  await expect(
    new ReplyService(db, async () => {
      throw new Error("Provider unavailable");
    }).reply(w.id, thread.id, data),
  ).rejects.toThrow("Provider unavailable");
  expect(await canvas.load(w.id)).toEqual(before);
  expect((await reviews.state(w.id)).messages).toHaveLength(1);
});
it("does not hold a transaction during inference and rejects the entire rewrite after a concurrent edit", async () => {
  const { w, first, second, thread, data } = await setup();
  const service = new ReplyService(db, async (context, signal) => {
    await canvas.editNode(w.id, first.id, {
      expected_revision: first.revision,
      instructions: "A newer owner edit",
    });
    return rewrite(context, signal);
  });
  await expect(service.reply(w.id, thread.id, data)).rejects.toMatchObject({
    code: "STALE_REPLY_UPDATE",
  });
  const board = await canvas.load(w.id);
  expect(board.nodes.find((n) => n.id === first.id)?.instructions).toBe(
    "A newer owner edit",
  );
  expect(board.nodes.find((n) => n.id === second.id)?.instructions).toBe(
    second.instructions,
  );
  expect((await reviews.state(w.id)).messages).toHaveLength(1);
});
it.each(["unknown", "duplicate", "empty"])(
  "rejects %s model edits without saving partial results",
  async (kind) => {
    const { w, thread, data } = await setup(),
      before = await canvas.load(w.id);
    const service = new ReplyService(db, async (context, signal) => {
      const result = await rewrite(context, signal);
      if (kind === "unknown") result.updates[1].node_id = randomUUID();
      if (kind === "duplicate") result.updates.push(result.updates[0]);
      if (kind === "empty") result.updates[1].instructions = "";
      return result;
    });
    await expect(service.reply(w.id, thread.id, data)).rejects.toMatchObject({
      code: "INVALID_REPLY_UPDATE",
    });
    expect(await canvas.load(w.id)).toEqual(before);
    expect((await reviews.state(w.id)).messages).toHaveLength(1);
  },
);
it.each(["no_change", "manual_change"] as const)(
  "records %s honestly without changing the graph",
  async (outcome) => {
    const { w, thread, data } = await setup(),
      before = await canvas.load(w.id);
    await new ReplyService(db, async () => ({
      outcome,
      updates: [],
      explanation: "This requires the owner's next decision.",
    })).reply(w.id, thread.id, data);
    expect(await canvas.load(w.id)).toEqual(before);
    expect(
      (await reviews.state(w.id)).messages.at(-1)?.event_data?.outcome,
    ).toBe(outcome);
  },
);
it.each(["connection", "workflow"] as const)(
  "keeps %s findings out of unrelated block instructions",
  async (scope) => {
    const { w, thread, data } = await setup(scope),
      before = await canvas.load(w.id),
      provider = vi.fn(rewrite);
    await new ReplyService(db, provider).reply(w.id, thread.id, data);
    expect(provider).not.toHaveBeenCalled();
    expect(await canvas.load(w.id)).toEqual(before);
    expect(
      (await reviews.state(w.id)).messages.at(-1)?.event_data?.outcome,
    ).toBe("manual_change");
  },
);
it("does not rewrite ordinary discussion notes", async () => {
  const { w, first } = await setup();
  const thread = await new FindingService(db).note(
    w.id,
    noteInput.parse({
      title: "Note",
      body: "Discussion",
      node_ids: [first.id],
      request_key: randomUUID(),
    }),
  );
  const provider = vi.fn(rewrite),
    before = await canvas.load(w.id);
  await new ReplyService(db, provider).reply(
    w.id,
    thread.id,
    messageInput.parse({ body: "Thanks", request_key: randomUUID() }),
  );
  expect(provider).not.toHaveBeenCalled();
  expect(await canvas.load(w.id)).toEqual(before);
});
it("rejects stale discussion state before inference and cancellation before commit", async () => {
  const { w, thread, data } = await setup(),
    provider = vi.fn(rewrite);
  await expect(
    new ReplyService(db, provider).reply(w.id, thread.id, {
      ...data,
      expected_revision: 999,
    }),
  ).rejects.toMatchObject({ code: "STALE_EDIT" });
  expect(provider).not.toHaveBeenCalled();
  const controller = new AbortController();
  await expect(
    new ReplyService(db, async (context, signal) => {
      controller.abort();
      return rewrite(context, signal);
    }).reply(w.id, thread.id, data, controller.signal),
  ).rejects.toThrow();
  expect((await reviews.state(w.id)).messages).toHaveLength(1);
});
it("cannot commit after review starts while the rewrite is running", async () => {
  const { w, thread, data } = await setup();
  await expect(
    new ReplyService(db, async (context, signal) => {
      await reviews.start(w.id, { request_key: randomUUID() });
      return rewrite(context, signal);
    }).reply(w.id, thread.id, data),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  expect((await reviews.state(w.id)).messages).toHaveLength(1);
});

it("does not silently omit a removed target from a multi-block finding", async () => {
  const { w, second, thread, data } = await setup();
  await canvas.deleteNode(w.id, second.id, second.revision);
  const provider = vi.fn(rewrite),
    before = await canvas.load(w.id);
  await new ReplyService(db, provider).reply(w.id, thread.id, data);
  expect(provider).not.toHaveBeenCalled();
  expect(await canvas.load(w.id)).toEqual(before);
  expect((await reviews.state(w.id)).messages.at(-1)?.body).toContain(
    "removed",
  );
});
it("commits a concurrent duplicate request only once", async () => {
  const { w, thread, data } = await setup();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ReplyService(db, async (context, signal) => {
    if (++started === 2) release();
    await gate;
    return rewrite(context, signal);
  });
  const replies = await Promise.all([
    service.reply(w.id, thread.id, data),
    service.reply(w.id, thread.id, data),
  ]);
  expect(replies[0].id).toBe(replies[1].id);
  expect(
    (await reviews.state(w.id)).messages.filter(
      (m) => m.author_kind === "customer",
    ),
  ).toHaveLength(1);
  await expect(
    service.reply(w.id, thread.id, { ...data, body: "Different answer" }),
  ).rejects.toMatchObject({ code: "REQUEST_REUSED" });
});

async function proposed() {
  const fixture = await setup();
  await new ReplyService(db, rewrite).reply(
    fixture.w.id,
    fixture.thread.id,
    fixture.data,
  );
  const state = await reviews.state(fixture.w.id);
  return {
    ...fixture,
    proposal: state.messages.at(-1)!,
    revision: state.threads[0].revision,
  };
}
it("rejects a proposal without changing any blocks and retains the decision", async () => {
  const { w, thread, proposal, revision } = await proposed();
  const before = await canvas.load(w.id);
  await new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
    decision: "reject",
    expected_revision: revision,
    request_key: randomUUID(),
  });
  expect(await canvas.load(w.id)).toEqual(before);
  const state = await reviews.state(w.id);
  expect(state.messages.at(-1)?.event_data).toMatchObject({
    action: "reply_proposal_decided",
    decision: "reject",
    proposal_message_id: proposal.id,
  });
  expect(state.threads[0].status).toBe("open");
  await expect(
    new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
      decision: "accept",
      expected_revision: state.threads[0].revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PROPOSAL_DECIDED" });
});
it("rejects all proposed edits if one target changes before acceptance", async () => {
  const { w, first, second, thread, proposal, revision } = await proposed();
  await canvas.editNode(w.id, first.id, {
    expected_revision: first.revision,
    instructions: "Concurrent edit",
  });
  const before = await canvas.load(w.id);
  await expect(
    new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
      decision: "accept",
      expected_revision: revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
  expect(await canvas.load(w.id)).toEqual(before);
  expect(before.nodes.find((n) => n.id === second.id)?.instructions).toBe(
    second.instructions,
  );
  await new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
    decision: "reject",
    expected_revision: revision,
    request_key: randomUUID(),
  });
});
it("supersedes earlier proposals after a follow-up and refuses cross-thread decisions", async () => {
  const { w, thread, proposal, revision, data } = await proposed();
  await new ReplyService(db, rewrite).reply(w.id, thread.id, {
    ...data,
    body: "Also clarify the report",
    expected_revision: revision,
    request_key: randomUUID(),
  });
  const state = await reviews.state(w.id);
  await expect(
    new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
      decision: "accept",
      expected_revision: state.threads[0].revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "PROPOSAL_SUPERSEDED" });
  const other = await setup();
  await expect(
    new ReplyProposalService(db).decide(
      other.w.id,
      other.thread.id,
      proposal.id,
      {
        decision: "accept",
        expected_revision: other.thread.revision,
        request_key: randomUUID(),
      },
    ),
  ).rejects.toMatchObject({ code: "PROPOSAL_NOT_FOUND" });
});
it("cannot accept while review locks the workflow", async () => {
  const { w, thread, proposal, revision } = await proposed();
  const before = (await canvas.load(w.id)).nodes;
  await reviews.start(w.id, { request_key: randomUUID() });
  await expect(
    new ReplyProposalService(db).decide(w.id, thread.id, proposal.id, {
      decision: "accept",
      expected_revision: revision,
      request_key: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  expect((await canvas.load(w.id)).nodes).toEqual(before);
});
it("serializes competing accept and reject decisions", async () => {
  const { w, thread, proposal, revision } = await proposed();
  const service = new ReplyProposalService(db);
  const outcomes = await Promise.allSettled(
    (["accept", "reject"] as const).map((decision) =>
      service.decide(w.id, thread.id, proposal.id, {
        decision,
        expected_revision: revision,
        request_key: randomUUID(),
      }),
    ),
  );
  expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const state = await reviews.state(w.id);
  expect(
    state.messages.filter(
      (m) => m.event_data?.action === "reply_proposal_decided",
    ),
  ).toHaveLength(1);
});
