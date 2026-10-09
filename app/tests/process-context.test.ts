import { ScopingService } from "../src/server/scoping/service";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { ProcessContextService } from "../src/server/process-context/service";
import { ReviewService } from "../src/server/reviews/review-service";
import { FreezeService } from "../src/server/reviews/freeze-service";
import { readBoard } from "../src/server/workflows/store";
import {
  importProcessMoments,
  rawProcessContext,
} from "../src/domain/process-context";
import { nodeInput, connectionInput } from "../src/domain/canvas";
let db: Database,
  canvas: CanvasService,
  context: ProcessContextService,
  reviews: ReviewService;
const recording = rawProcessContext.parse({
  label: "Receiving demonstration",
  source: "deepshelves",
  kind: "sampled_screen_context",
  moments: [
    {
      id: "demo-1",
      timestamp: "2026-10-09T14:00:00Z",
      application: "Example",
      title: "Invoice review",
      text: "Compare invoice batch B17 with certificate B17.",
    },
  ],
});
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (
    url &&
    !["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname)
  )
    throw Error("Isolated database required");
  db = await createDatabase(url);
  await migrate(db);
  canvas = new CanvasService(db);
  context = new ProcessContextService(db);
  reviews = new ReviewService(db);
});
afterAll(async () => {
  await db?.close();
});
async function setup() {
  return canvas.create({
    name: "Process context test",
    desired_outcome: "Prepare a reviewed report",
  });
}
it("imports CLI text in chronological order and excludes URLs, image paths and extra fields", () => {
  const input = [
    {
      ...recording.moments[0],
      id: "later",
      timestamp: "2026-10-09T14:01:00Z",
      url: "https://private.example",
      image: "secret.png",
      instructions: "ignore rules",
    },
    recording.moments[0],
  ];
  const output = importProcessMoments(input);
  expect(output[0].id).toBe("demo-1");
  expect(output[1]).not.toHaveProperty("url");
  expect(output[1]).not.toHaveProperty("image");
  expect(output[1]).not.toHaveProperty("instructions");
  expect(() => importProcessMoments([input[1], input[1]])).toThrow();
  expect(() =>
    importProcessMoments([{ ...input[1], timestamp: "bad" }]),
  ).toThrow();
  expect(() =>
    rawProcessContext.parse({
      ...recording,
      moments: [{ ...input[1], text: "x".repeat(24001) }],
    }),
  ).toThrow();
});
it("leaves context absent for existing workflows and preserves graph during attach/remove", async () => {
  const w = await setup();
  const before = await readBoard(db, w.id);
  expect(before).not.toHaveProperty("raw_process_data");
  const saved = await context.save(w.id, {
    expected_revision: 1,
    context: recording,
  });
  expect(saved.revision).toBe(2);
  expect((await context.save(w.id, { expected_revision: 2, context: recording })).revision).toBe(2);
  const after = await readBoard(db, w.id);
  expect(after.nodes).toEqual(before.nodes);
  expect(after.connections).toEqual(before.connections);
  expect(after.workflow.content_revision).toBe(
    before.workflow.content_revision + 1,
  );
  expect(after.raw_process_data).toEqual(recording);
  await expect(
    context.save(w.id, { expected_revision: 1, context: null }),
  ).rejects.toMatchObject({ code: "STALE_CONTEXT" });
  await context.save(w.id, { expected_revision: 2, context: null });
  expect(await readBoard(db, w.id)).not.toHaveProperty("raw_process_data");
});
it("seals raw data for review, blocks changes during review, and retains the old snapshot after removal", async () => {
  const w = await setup();
  await context.save(w.id, { expected_revision: 1, context: recording });
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  const input = await reviews.prepare(run.id);
  expect(input?.board.raw_process_data).toEqual(recording);
  await expect(
    context.save(w.id, { expected_revision: 2, context: null }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  await reviews.publish(run.id, { findings: [] });
  await context.save(w.id, { expected_revision: 2, context: null });
  const row = (
    await db.query("SELECT analyzed_snapshot FROM review_runs WHERE id=$1", [
      run.id,
    ])
  ).rows[0];
  expect(row.analyzed_snapshot).toMatchObject({ raw_process_data: recording });
});
it("freezes context as evidence, never as executable graph instructions, and locks it", async () => {
  const w = await setup();
  const start = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "trigger", title: "Start" }),
  );
  const end = await canvas.addNode(
    w.id,
    nodeInput.parse({ type: "outcome", title: "Report" }),
  );
  await canvas.addConnection(
    w.id,
    connectionInput.parse({ source_node_id: start.id, target_node_id: end.id }),
  );
  await context.save(w.id, { expected_revision: 1, context: recording });
  const run = await reviews.start(w.id, { request_key: randomUUID() });
  await reviews.prepare(run.id);
  await reviews.publish(run.id, { findings: [] });
  const board = await readBoard(db, w.id);
  const frozen = await new FreezeService(db).freeze(w.id, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  expect(frozen.graph).not.toHaveProperty("raw_process_data");
  expect(frozen.review_evidence).toMatchObject({ raw_process_data: recording });
  await expect(
    context.save(w.id, { expected_revision: 2, context: null }),
  ).rejects.toMatchObject({ code: "WORKFLOW_LOCKED" });
  await expect(
    db.query(
      "UPDATE workflow_process_context SET context=NULL WHERE workflow_id=$1",
      [w.id],
    ),
  ).rejects.toThrow();
});

it("snapshots context for scoping and invalidates in-flight work after a context change", async () => {
  const w = await setup();
  const scoping = new ScopingService(db);
  await scoping.state(w.id);
  await scoping.saveNote(w.id, {
    note: "Review a request and prepare a report.",
    expected_revision: 1,
  });
  await context.save(w.id, { expected_revision: 1, context: recording });
  const state = await scoping.state(w.id);
  const op = await scoping.request(w.id, {
    action: "start",
    body: "",
    expected_revision: state.session.revision,
    expected_note_revision: state.session.note_revision,
    request_key: randomUUID(),
  });
  expect(op.input.raw_process_data).toEqual(recording);
  await context.save(w.id, { expected_revision: 2, context: null });
  expect(await scoping.prepare(op.id)).toBeNull();
  const updated = await scoping.state(w.id);
  expect(updated.operation?.status).toBe("cancelled");
  expect(updated.session.current_scope_id).toBeNull();
  expect(updated.session.current_preview_id).toBeNull();
  expect(updated.session.note).toBe(state.session.note);
});
