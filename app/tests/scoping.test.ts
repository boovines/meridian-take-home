import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ScopingService } from "../src/server/scoping/service";
import { ScaffoldApplyService } from "../src/server/scoping/apply-service";
import { ReviewService } from "../src/server/reviews/review-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { FindingService } from "../src/server/reviews/finding-service";
import {
  scopeReady,
  scaffoldBoard,
  scopeForDraft,
  type ScopingOperation,
} from "../src/domain/scoping";
import { nodeInput } from "../src/domain/canvas";
import { readyScope, readyScaffold, fixtureScope } from "./fixtures/scoping";
let db: Database,
  canvas: CanvasService,
  scoping: ScopingService,
  apply: ScaffoldApplyService,
  reviews: ReviewService,
  freeze: FreezeService;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw new Error("Use an isolated local database.");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  scoping = new ScopingService(db);
  apply = new ScaffoldApplyService(db);
  reviews = new ReviewService(db);
  freeze = new FreezeService(db);
});
afterAll(async () => db?.close());
async function setup() {
  const w = await canvas.create({
    name: "Scoping test",
    desired_outcome: "An approved response",
  });
  await scoping.state(w.id);
  await scoping.saveNote(w.id, {
    note: "Receive a request and prepare a response for human approval.",
    expected_revision: 1,
  });
  return w;
}
async function request(
  id: string,
  action: "start" | "answer" | "notes" | "revise" | "preview",
  body = "",
) {
  const { session: s } = await scoping.state(id);
  return scoping.request(id, {
    action,
    body,
    expected_revision: s.revision,
    expected_note_revision: s.note_revision,
    request_key: randomUUID(),
  });
}
async function finish(op: ScopingOperation) {
  await scoping.prepare(op.id);
  await scoping.publish(op.id, fixtureScope(op));
}
async function preview(id: string) {
  await finish(await request(id, "start"));
  await finish(
    await request(
      id,
      "answer",
      "The process owner approves. If rejected, revise and ask again.",
    ),
  );
  await finish(await request(id, "preview"));
  const s = (await scoping.state(id)).session;
  return {
    preview_id: s.current_preview_id!,
    expected_revision: s.revision,
    expected_workflow_revision: (await canvas.load(id)).workflow.revision,
    request_key: randomUUID(),
  };
}
it("persists note revisions independently, rejects conflicts and preserves raw notes/history", async () => {
  const w = await setup();
  expect((await canvas.load(w.id)).workflow.content_revision).toBe(0);
  await expect(
    scoping.saveNote(w.id, { note: "stale", expected_revision: 1 }),
  ).rejects.toMatchObject({ code: "NOTE_CONFLICT" });
  await finish(await request(w.id, "start"));
  const state = await new ScopingService(db).state(w.id);
  expect(state.session.note).toContain("Receive a request");
  expect(state.messages.map((m) => m.author)).toEqual(["expert", "agent"]);
  expect(state.versions).toHaveLength(1);
  expect(
    scopeReady((state.versions[0].data as { scope: typeof readyScope }).scope),
  ).toBe(false);
  const draft = await request(w.id, "preview");
  expect(draft.input.scope?.unresolved.map((u) => u.question)).toContain(
    "Confirm the workflow's humans before implementation.",
  );
});
it("applies a connected graph once, retains human approval/loop and requires real post-apply review", async () => {
  const w = await setup();
  // Historical completion on an earlier empty definition must not satisfy freeze.
  const old = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(old.id);
  await reviews.publish(old.id, { findings: [] });
  const data = await preview(w.id);
  const board = await apply.apply(w.id, data);
  expect(board.nodes).toHaveLength(4);
  expect(board.connections).toHaveLength(4);
  expect(board.nodes.some((n) => n.type === "human_approval")).toBe(true);
  expect(board.nodes.find((n) => n.type === "outcome")?.instructions).toContain(
    "How long should",
  );
  expect(board.workflow.content_revision).toBe(1);
  expect((await apply.apply(w.id, data)).nodes.map((n) => n.id)).toEqual(
    board.nodes.map((n) => n.id),
  );
  expect((await freeze.readiness(w.id)).completed_review_id).toBeNull();
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: 1,
      acknowledge_unreviewed: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
  expect((await scoping.state(w.id)).needs_review).toBe(true);
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  const input = await reviews.prepare(run.id);
  expect(
    input?.discussion.threads.filter((t) => t.kind === "finding"),
  ).toHaveLength(1);
  // Provider omission cannot erase unresolved scoping obligations.
  await reviews.publish(run.id, { findings: [] });
  expect((await scoping.state(w.id)).needs_review).toBe(false);
  const state = await reviews.state(w.id),
    t = state.threads.find((t) => t.kind === "finding")!;
  expect(t.origin_review_run_id).toBe(run.id);
  expect(state.anchors[0].node_id).toBe(
    board.nodes.find((n) => n.type === "outcome")?.id,
  );
  await new FindingService(db).action(w.id, t.id, {
    action: "reject",
    expected_revision: t.revision,
    reason: "Retention is out of scope; this workflow only previews responses.",
    request_key: randomUUID(),
  });
  const next = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(next.id);
  await reviews.publish(next.id, { findings: [] });
  expect(
    (await reviews.state(w.id)).threads.filter((t) => t.kind === "finding"),
  ).toHaveLength(1);
  const spec = await freeze.freeze(w.id, {
    expected_content_revision: 1,
    acknowledge_unreviewed: false,
  });
  expect(
    (spec.review_evidence as { scoping: { applied_preview_id: string } })
      .scoping.applied_preview_id,
  ).toBe(data.preview_id);
  await expect(
    scoping.saveNote(w.id, { note: "locked", expected_revision: 2 }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  // A qualifying v1 scaffold review cannot satisfy a newly opened v2 revision.
  const { ProcessRevisionService } =
    await import("../src/server/process-revisions/service");
  await new ProcessRevisionService(db).start(w.id, {
    source_frozen_spec_id: String(spec.id),
  });
  expect((await freeze.readiness(w.id)).completed_review_id).toBeNull();
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: 1,
      acknowledge_unreviewed: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
  const revisedReview = await reviews.start(w.id, {
    request_key: randomUUID(),
  });
  await reviews.prepare(revisedReview.id);
  await reviews.publish(revisedReview.id, { findings: [] });
  const revisedSpec = await freeze.freeze(w.id, {
    expected_content_revision: 1,
    acknowledge_unreviewed: false,
  });
  expect(revisedSpec.version_number).toBe(2);
  expect(revisedSpec.parent_frozen_spec_id).toBe(spec.id);
});
it("does not overwrite a manually populated or stale board", async () => {
  const w = await setup(),
    data = await preview(w.id);
  const n = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "trigger", title: "Manual start" }),
  );
  await expect(apply.apply(w.id, data)).rejects.toMatchObject({
    code: "BOARD_NOT_EMPTY",
  });
  await expect(
    apply.apply(w.id, {
      ...data,
      expected_workflow_revision: (await canvas.load(w.id)).workflow.revision,
    }),
  ).rejects.toMatchObject({ code: "BOARD_NOT_EMPTY" });
  expect((await canvas.load(w.id)).nodes.map((n) => n.id)).toEqual([n.id]);
  expect((await scoping.state(w.id)).versions.length).toBe(3);
});
it("fences cancellation, updated notes, duplicate requests and expired worker results", async () => {
  const w = await setup(),
    op = await request(w.id, "start");
  const old = await scoping.request(w.id, {
    action: "start",
    body: "",
    expected_revision: 1,
    expected_note_revision: 2,
    request_key: String(
      (
        await db.query(
          "SELECT request_key FROM scoping_operations WHERE id=$1",
          [op.id],
        )
      ).rows[0].request_key,
    ),
  });
  expect(old.id).toBe(op.id);
  await scoping.saveNote(w.id, { note: "Changed scope", expected_revision: 2 });
  const replacement = await request(w.id, "notes");
  await scoping.publish(op.id, fixtureScope(op));
  expect((await scoping.state(w.id)).versions).toHaveLength(0);
  await scoping.finish(replacement.id, "cancelled");
  await scoping.publish(replacement.id, fixtureScope(replacement));
  expect((await scoping.state(w.id)).versions).toHaveLength(0);
  const expired = await request(w.id, "start");
  await db.query(
    "UPDATE scoping_operations SET deadline_at=now()-interval '1 second' WHERE id=$1",
    [expired.id],
  );
  expect(await scoping.prepare(expired.id)).toBeNull();
  expect((await scoping.state(w.id)).operation?.status).toBe("failed");
});
it("rejects invalid and incomplete previews without graph mutation; old preview remains in history", async () => {
  const w = await setup();
  await preview(w.id);
  const before = await scoping.state(w.id);
  await finish(
    await request(w.id, "revise", "Keep approval, simplify the wording."),
  );
  const op = await request(w.id, "preview");
  await expect(
    scoping.publish(op.id, {
      message: "Bad graph",
      graph: { ...readyScaffold, connections: [] },
    }),
  ).rejects.toThrow();
  await scoping.finish(op.id, "failed", "Invalid graph");
  const after = await scoping.state(w.id);
  expect(
    after.versions.some((v) => v.id === before.session.current_preview_id),
  ).toBe(true);
  expect((await canvas.load(w.id)).nodes).toHaveLength(0);
  expect(() =>
    scaffoldBoard({ ...readyScaffold, unresolved_anchors: [] }, w, readyScope),
  ).toThrow("preserve every unresolved");
  expect(() =>
    scaffoldBoard(
      {
        ...readyScaffold,
        nodes: [...readyScaffold.nodes, readyScaffold.nodes[0]],
      },
      w,
      readyScope,
    ),
  ).toThrow("unique key");
});
it("saving a newer note prevents an old snapshot preview from being applied", async () => {
  const w = await setup(),
    data = await preview(w.id);
  await scoping.saveNote(w.id, {
    note: "An important new approval requirement",
    expected_revision: 2,
  });
  await expect(apply.apply(w.id, data)).rejects.toMatchObject({
    code: "STALE_PREVIEW",
  });
});
it("cancelled reviews preserve scoping obligations and subsequent reviews reuse their findings", async () => {
  const w = await setup();
  await apply.apply(w.id, await preview(w.id));
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.finish(run.id, "cancelled");
  const first = (await reviews.state(w.id)).threads[0];
  expect((await freeze.readiness(w.id)).completed_review_id).toBeNull();
  const next = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(next.id);
  await reviews.publish(next.id, { findings: [] });
  expect((await reviews.state(w.id)).threads.map((t) => t.id)).toEqual([
    first.id,
  ]);
  expect((await freeze.readiness(w.id)).open_findings).toHaveLength(1);
});
it("maps parallel joins and loop endpoints to real same-board IDs deterministically", async () => {
  const w = await setup();
  const graph = {
    ...readyScaffold,
    unresolved_anchors: [],
    nodes: [
      { ...readyScaffold.nodes[0], split_mode: "parallel" as const },
      { ...readyScaffold.nodes[1], key: "left" },
      { ...readyScaffold.nodes[1], key: "right" },
      { ...readyScaffold.nodes[3], join_for_split_key: "start" },
    ],
    connections: [
      { ...readyScaffold.connections[0], key: "a", target: "left" },
      { ...readyScaffold.connections[0], key: "b", target: "right" },
      {
        ...readyScaffold.connections[0],
        key: "c",
        source: "left",
        target: "result",
      },
      {
        ...readyScaffold.connections[0],
        key: "d",
        source: "right",
        target: "result",
      },
    ],
  };
  const board = scaffoldBoard(graph, w, { ...readyScope, unresolved: [] });
  expect(board.nodes.find((n) => n.id === "result")?.join_for_split_id).toBe(
    "start",
  );
  expect(board.nodes.find((n) => n.id === "left")?.y).toBe(
    board.nodes.find((n) => n.id === "right")?.y,
  );
  expect(scaffoldBoard(graph, w, { ...readyScope, unresolved: [] })).toEqual(
    board,
  );
});
it("rejects cross-workflow references and stale workflow metadata, and rolls back malformed graphs", async () => {
  const w = await setup(),
    other = await setup(),
    data = await preview(w.id);
  await expect(
    db.query(
      "UPDATE scoping_sessions SET current_preview_id=$2 WHERE workflow_id=$1",
      [other.id, data.preview_id],
    ),
  ).rejects.toMatchObject({ code: "23503" });
  await expect(
    db.query("UPDATE scoping_versions SET data='{}' WHERE id=$1", [
      data.preview_id,
    ]),
  ).rejects.toMatchObject({ code: "23514" });
  await canvas.updateWorkflow(w.id, {
    name: "Changed metadata",
    expected_revision: data.expected_workflow_revision,
  });
  await expect(apply.apply(w.id, data)).rejects.toMatchObject({
    code: "STALE_EDIT",
  });
  expect((await canvas.load(w.id)).nodes).toHaveLength(0);
});
it("serializes simultaneous applications and note saves without lost updates", async () => {
  const w = await setup(),
    data = await preview(w.id);
  const results = await Promise.all([
    apply.apply(w.id, data),
    apply.apply(w.id, data),
  ]);
  expect(results[0].nodes.map((n) => n.id)).toEqual(
    results[1].nodes.map((n) => n.id),
  );
  const saves = await Promise.allSettled([
    scoping.saveNote(w.id, { note: "First draft", expected_revision: 2 }),
    scoping.saveNote(w.id, { note: "Other draft", expected_revision: 2 }),
  ]);
  expect(saves.filter((s) => s.status === "fulfilled")).toHaveLength(1);
  expect(saves.filter((s) => s.status === "rejected")).toHaveLength(1);
  expect((await canvas.load(w.id)).workflow.content_revision).toBe(1);
});
it("never publishes after review locks the board; deleted targets retain audited dispositions", async () => {
  const w = await setup(),
    op = await request(w.id, "start");
  const lock = await reviews.start(w.id, { request_key: randomUUID() });
  expect(await scoping.prepare(op.id)).toBeNull();
  await reviews.finish(lock.id, "cancelled");
  const board = await apply.apply(w.id, await preview(w.id));
  const outcome = board.nodes.find((n) => n.type === "outcome")!;
  await canvas.deleteNode(w.id, outcome.id, outcome.revision);
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.publish(run.id, { findings: [] });
  const finding = (await reviews.state(w.id)).threads.find(
    (t) => t.kind === "finding",
  )!;
  expect(finding.resolution_kind).toBe("target_deleted");
  expect((await freeze.readiness(w.id)).issues.length).toBeGreaterThan(0);
});

it("validates review-anchor uniqueness before saving a preview and normalizes blank Otherwise text", async () => {
  const w = await setup();
  const duplicateAnchors = {
    ...readyScaffold,
    unresolved_anchors: [
      {
        key: "retention",
        node_keys: ["result", "result"],
        connection_keys: [],
      },
    ],
  };
  expect(() => scaffoldBoard(duplicateAnchors, w, readyScope)).toThrow(
    "only once",
  );
  const graph = {
    ...readyScaffold,
    connections: readyScaffold.connections.map((c) =>
      c.key === "revise" ? { ...c, is_default: true, condition_text: "  " } : c,
    ),
  };
  const board = scaffoldBoard(graph, w, readyScope);
  expect(board.connections.find((c) => c.id === "revise")?.condition_text).toBe(
    "",
  );
});
it("rolls back every inserted block when persistence fails partway through apply", async () => {
  const w = await setup(),
    data = await preview(w.id);
  const failing: Database = {
    ...db,
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          ...tx,
          query: async (sql, values) => {
            if (sql.startsWith("INSERT INTO connections"))
              throw new Error("Injected persistence failure");
            return tx.query(sql, values);
          },
        }),
      ),
  };
  await expect(
    new ScaffoldApplyService(failing).apply(w.id, data),
  ).rejects.toThrow("Injected persistence failure");
  expect((await canvas.load(w.id)).nodes).toHaveLength(0);
  expect((await canvas.load(w.id)).workflow.content_revision).toBe(0);
  expect((await scoping.state(w.id)).session.applied_preview_id).toBeNull();
  expect((await apply.apply(w.id, data)).nodes).toHaveLength(4);
});

it("limits question rounds across reloads and note updates without counting failed or duplicate requests", async () => {
  const w = await setup();
  const failed = await request(w.id, "start");
  await scoping.finish(failed.id, "failed", "Try again");
  const first = await request(w.id, "start");
  expect(first.input.question_rounds_remaining).toBe(2);
  await finish(first);
  const second = await request(w.id, "answer", "I do not know yet.");
  expect(second.input.question_rounds_remaining).toBe(1);
  await scoping.publish(second.id, {
    message: "One more question?",
    scope: fixtureScope(first).scope,
  });
  const third = await request(w.id, "answer", "Keep that open for review.");
  expect(third.input.question_rounds_remaining).toBe(0);
  await scoping.publish(third.id, {
    message: "What is the exact address?",
    scope: fixtureScope(first).scope,
  });
  let state = await new ScopingService(db).state(w.id);
  expect(state.messages.at(-1)?.body).toContain(
    "Your draft can be generated now",
  );
  expect(state.messages.at(-1)?.body).not.toContain("exact address");
  await scoping.saveNote(w.id, {
    note: "Updated notes with another detail",
    expected_revision: state.session.note_revision,
  });
  const update = await request(w.id, "notes");
  expect(update.input.question_rounds_remaining).toBe(0);
  await finish(update);
  state = await scoping.state(w.id);
  const payload = {
    action: "answer" as const,
    body: "Optional correction",
    expected_revision: state.session.revision,
    expected_note_revision: state.session.note_revision,
    request_key: randomUUID(),
  };
  const one = await scoping.request(w.id, payload);
  expect((await scoping.request(w.id, payload)).id).toBe(one.id);
  expect(one.input.question_rounds_remaining).toBe(0);
});
it("carries structural gaps into preview, application and mandatory review without inventing coverage", async () => {
  const w = await setup();
  await finish(await request(w.id, "start"));
  const op = await request(w.id, "preview");
  expect(op.input.scope?.coverage.humans).toBeNull();
  expect(op.input.scope?.blockers.length).toBeGreaterThan(0);
  expect(op.input.scope?.unresolved.map((u) => u.question).sort()).toEqual(
    [
      "How long should the approved response be retained?",
      "Confirm who approves and how rejection continues.",
      "Confirm the workflow's routing before implementation.",
      "Confirm the workflow's humans before implementation.",
    ].sort(),
  );
  await finish(op);
  const state = await scoping.state(w.id);
  const board = await apply.apply(w.id, {
    preview_id: state.session.current_preview_id!,
    expected_revision: state.session.revision,
    expected_workflow_revision: w.revision,
    request_key: randomUUID(),
  });
  expect(board.nodes.length).toBeGreaterThan(0);
  const review = await reviews.start(w.id, { request_key: randomUUID() });
  const input = await reviews.prepare(review.id);
  expect(
    input?.discussion.threads.filter((t) => t.kind === "finding"),
  ).toHaveLength(4);
  await reviews.publish(review.id, { findings: [] });
  await expect(
    freeze.freeze(w.id, {
      expected_content_revision: board.workflow.content_revision,
      acknowledge_unreviewed: true,
    }),
  ).rejects.toMatchObject({ code: "NOT_READY" });
});
it("draft gap keys preserve existing questions even on key collisions", () => {
  const scope = {
    ...readyScope,
    coverage: { ...readyScope.coverage, humans: null },
    blockers: ["Who approves?"],
    unresolved: [{ key: "draft_blocker_0", question: "Existing detail" }],
  };
  const draft = scopeForDraft(scope);
  expect(draft.unresolved.map((u) => u.question).sort()).toEqual(
    [
      "Existing detail",
      "Who approves?",
      "Confirm the workflow's humans before implementation.",
    ].sort(),
  );
  expect(new Set(draft.unresolved.map((u) => u.key)).size).toBe(3);
  expect(scope.unresolved).toHaveLength(1);
  expect(draft.coverage.humans).toBeNull();
});
