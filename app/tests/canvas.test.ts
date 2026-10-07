import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, migrate, type Database } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { nodeInput, connectionInput } from "../src/domain/canvas";

let db: Database, canvas: CanvasService;
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
});
afterAll(async () => {
  await db?.close();
});
const block = (title: string) => nodeInput.parse({ type: "task", title });
describe("persisted canvas behavior", () => {
  it("saves and reloads independent workflows with routes including a return loop", async () => {
    const a = await canvas.create({
      name: "Receiving",
      desired_outcome: "Validate a shipment",
    });
    const b = await canvas.create({ name: "Onboarding", desired_outcome: "" });
    const first = await canvas.addNode(a.id, block("Check invoice"));
    const second = await canvas.addNode(a.id, block("Request information"));
    await canvas.addConnection(
      a.id,
      connectionInput.parse({
        source_node_id: first.id,
        target_node_id: second.id,
        condition_text: "Missing fields",
      }),
    );
    await canvas.addConnection(
      a.id,
      connectionInput.parse({
        source_node_id: second.id,
        target_node_id: first.id,
        condition_text: "Response received",
      }),
    );
    const reloaded = await new CanvasService(db).load(a.id);
    expect(reloaded.nodes.map((n) => n.title)).toEqual([
      "Check invoice",
      "Request information",
    ]);
    expect(reloaded.connections).toHaveLength(2);
    expect((await canvas.load(b.id)).nodes).toEqual([]);
  });
  it("rejects stale edits and preserves the accepted instructions", async () => {
    const w = await canvas.create({
      name: "Concurrent edits",
      desired_outcome: "",
    });
    const n = await canvas.addNode(w.id, block("Check"));
    await canvas.editNode(w.id, n.id, {
      expected_revision: n.revision,
      instructions: "Require all five fields",
    });
    await expect(
      canvas.editNode(w.id, n.id, {
        expected_revision: n.revision,
        instructions: "Stale answer",
      }),
    ).rejects.toMatchObject({ code: "STALE_EDIT" });
    expect((await canvas.load(w.id)).nodes[0].instructions).toBe(
      "Require all five fields",
    );
  });
  it("allows edits to different nodes without a false workflow-wide revision conflict", async () => {
    const w = await canvas.create({
      name: "Independent edits",
      desired_outcome: "",
    });
    const a = await canvas.addNode(w.id, block("A")),
      b = await canvas.addNode(w.id, block("B"));
    await Promise.all([
      canvas.editNode(w.id, a.id, {
        expected_revision: a.revision,
        title: "New A",
      }),
      canvas.editNode(w.id, b.id, {
        expected_revision: b.revision,
        title: "New B",
      }),
    ]);
    expect((await canvas.load(w.id)).nodes.map((n) => n.title).sort()).toEqual([
      "New A",
      "New B",
    ]);
  });
  it("does not mark layout-only changes as unreviewed business content", async () => {
    const w = await canvas.create({ name: "Layout", desired_outcome: "" });
    const n = await canvas.addNode(w.id, block("Check"));
    const previous = (await canvas.load(w.id)).workflow.content_revision;
    const moved = await canvas.editNode(w.id, n.id, {
      expected_revision: n.revision,
      x: 500,
      y: 200,
    });
    expect((await canvas.load(w.id)).workflow.content_revision).toBe(previous);
    await canvas.editNode(w.id, n.id, {
      expected_revision: moved.revision,
      instructions: "Check the CoA",
    });
    expect((await canvas.load(w.id)).workflow.content_revision).toBe(
      previous + 1,
    );
  });
  it("rejects cross-workflow endpoints through both the service and database constraint", async () => {
    const a = await canvas.create({ name: "A", desired_outcome: "" }),
      b = await canvas.create({ name: "B", desired_outcome: "" });
    const x = await canvas.addNode(a.id, block("X")),
      y = await canvas.addNode(b.id, block("Y"));
    await expect(
      canvas.addConnection(
        a.id,
        connectionInput.parse({ source_node_id: x.id, target_node_id: y.id }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
    await expect(
      db.query(
        "INSERT INTO connections(workflow_id,source_node_id,target_node_id) VALUES($1,$2,$3)",
        [a.id, x.id, y.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("deletes incident routes and clears split references without erasing history", async () => {
    const w = await canvas.create({ name: "Split", desired_outcome: "" });
    const a = await canvas.addNode(
      w.id,
      nodeInput.parse({ type: "task", title: "Both", split_mode: "parallel" }),
    );
    const b = await canvas.addNode(
      w.id,
      nodeInput.parse({
        type: "check",
        title: "Join",
        join_for_split_id: a.id,
      }),
    );
    await canvas.addConnection(
      w.id,
      connectionInput.parse({ source_node_id: a.id, target_node_id: b.id }),
    );
    await canvas.deleteNode(w.id, a.id, a.revision);
    const reloaded = await canvas.load(w.id);
    expect(reloaded.nodes).toHaveLength(1);
    expect(reloaded.nodes[0].join_for_split_id).toBeNull();
    expect(reloaded.connections).toHaveLength(0);
    expect(
      (
        await db.query(
          "SELECT id FROM nodes WHERE id=$1 AND deleted_at IS NOT NULL",
          [a.id],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("rejects another Otherwise route on the same source", async () => {
    const w = await canvas.create({ name: "Routes", desired_outcome: "" });
    const a = await canvas.addNode(w.id, block("A")),
      b = await canvas.addNode(w.id, block("B"));
    const edge = connectionInput.parse({
      source_node_id: a.id,
      target_node_id: b.id,
      is_default: true,
    });
    await canvas.addConnection(w.id, edge);
    await expect(canvas.addConnection(w.id, edge)).rejects.toMatchObject({
      code: "23505",
    });
  });
});
