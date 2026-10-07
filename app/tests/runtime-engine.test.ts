import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { RuntimeEngine, type RuntimePorts } from "../src/domain/runtime-engine";
import {
  selectRoutes,
  type ScheduleStep,
  type StepReply,
  type RuntimeProjection,
} from "../src/domain/runtime";
import {
  nodeInput,
  connectionInput,
  type Board,
  type CanvasNode,
} from "../src/domain/canvas";
function graph(types: CanvasNode["type"][], paths: number[][]) {
  const wid = randomUUID();
  const nodes = types.map((type) => ({
    ...nodeInput.parse({ type, title: type }),
    id: randomUUID(),
    workflow_id: wid,
    revision: 1,
    config_version: 1,
  }));
  const connections = paths.map(([a, b]) => ({
    ...connectionInput.parse({
      source_node_id: nodes[a].id,
      target_node_id: nodes[b].id,
    }),
    id: randomUUID(),
    workflow_id: wid,
    revision: 1,
  }));
  const board = { workflow: { id: wid }, nodes, connections } as Board;
  return { board, nodes, connections };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function harness(
  board: Board,
  step: RuntimePorts["step"],
  extra: Partial<RuntimePorts> = {},
  limits = { step_attempts: 100, active_ms: 900000 },
) {
  let now = 0;
  const projections: RuntimeProjection[] = [];
  const engine = new RuntimeEngine(
    randomUUID(),
    { board, methods: {}, limits },
    {
      now: () => now,
      project: async (p) => {
        projections.push(p);
      },
      human: async () => {},
      changed() {},
      step,
      ...extra,
    },
  );
  return {
    engine,
    projections,
    tick: (ms: number) => {
      now += ms;
    },
  };
}
function complete(data: ScheduleStep, board: Board): StepReply {
  return {
    kind: "complete",
    step_id: `visit-${data.occurrence_number}`,
    connection_ids: board.connections
      .filter((e) => e.source_node_id === data.node_id)
      .map((e) => e.id),
  };
}
it("rejects multiple matches and foreign routes, and uses Otherwise only on zero matches", () => {
  const { nodes, connections } = graph(
    ["trigger", "outcome", "outcome"],
    [
      [0, 1],
      [0, 2],
    ],
  );
  connections[1].is_default = true;
  expect(selectRoutes(nodes[0], connections, [])).toEqual([connections[1]]);
  expect(selectRoutes(nodes[0], connections, [connections[0].id])).toEqual([
    connections[0],
  ]);
  expect(() =>
    selectRoutes(nodes[0], connections, [connections[1].id]),
  ).toThrow("INVALID_ROUTES");
  connections[1].is_default = false;
  expect(() =>
    selectRoutes(
      nodes[0],
      connections,
      connections.map((e) => e.id),
    ),
  ).toThrow("AMBIGUOUS_ROUTE");
  expect(() => selectRoutes(nodes[0], connections, [])).toThrow(
    "NO_MATCHING_ROUTE",
  );
});
it("loops create fresh human visits, retain previous step outputs, and exclude human waiting", async () => {
  const { board, nodes, connections } = graph(
    ["trigger", "human_approval", "outcome"],
    [
      [0, 1],
      [1, 1],
      [1, 2],
    ],
  );
  const visits: ScheduleStep[] = [];
  const h = harness(
    board,
    async (data, resume) => {
      if (!resume) visits.push(data);
      h.tick(10);
      if (data.node_id === nodes[1].id)
        return resume
          ? {
              kind: "complete",
              step_id: `visit-${data.occurrence_number}`,
              connection_ids: [
                connections[data.node_visit_number === 1 ? 1 : 2].id,
              ],
            }
          : {
              kind: "human",
              step_id: `visit-${data.occurrence_number}`,
              request_id: `approval-${data.node_visit_number}`,
            };
      return complete(data, board);
    },
    {
      human: async () => {
        expect(h.engine.isWaiting()).toBe(true);
        h.tick(1000000);
      },
    },
  );
  const result = await h.engine.run();
  expect(result.status).toBe("completed");
  expect(visits.map((v) => v.node_visit_number)).toEqual([1, 1, 2, 1]);
  expect(visits[2].input_step_refs[nodes[1].id]).toBe("visit-2");
  expect(h.engine.activeElapsed()).toBe(60);
  expect(
    h.projections.filter((p) => p.status === "waiting_for_human"),
  ).toHaveLength(2);
});
it("a failed parallel branch lets its running sibling finish but never runs the merge", async () => {
  const { board, nodes } = graph(
    ["trigger", "task", "task", "check", "outcome"],
    [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ],
  );
  nodes[0].split_mode = "parallel";
  nodes[3].join_for_split_id = nodes[0].id;
  const started = deferred<void>(),
    left = deferred<StepReply>(),
    right = deferred<StepReply>(),
    calls: string[] = [];
  const h = harness(board, async (data) => {
    calls.push(data.node_id);
    if (data.node_id === nodes[1].id) return left.promise;
    if (data.node_id === nodes[2].id) {
      started.resolve();
      return right.promise;
    }
    return complete(data, board);
  });
  const running = h.engine.run();
  await started.promise;
  left.resolve({
    kind: "error",
    step_id: "left",
    error: {
      code: "PARSER",
      message: "Parser failed",
      category: "implementation",
    },
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(h.engine.failure?.code).toBe("PARSER");
  right.resolve({
    kind: "complete",
    step_id: "right",
    connection_ids: board.connections
      .filter((e) => e.source_node_id === nodes[2].id)
      .map((e) => e.id),
  });
  expect((await running).status).toBe("failed");
  expect(calls).toEqual(nodes.slice(0, 3).map((n) => n.id));
});
it("a merge waits for both branches and each loop creates a new parallel occurrence", async () => {
  const { board, nodes, connections } = graph(
    ["trigger", "task", "task", "check", "outcome"],
    [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 0],
      [3, 4],
    ],
  );
  nodes[0].split_mode = "parallel";
  nodes[3].join_for_split_id = nodes[0].id;
  const visits: ScheduleStep[] = [];
  const h = harness(board, async (data) => {
    visits.push(data);
    if (data.node_id === nodes[3].id) {
      expect(data.input_step_refs[nodes[1].id]).toBeTruthy();
      expect(data.input_step_refs[nodes[2].id]).toBeTruthy();
      return {
        kind: "complete",
        step_id: `visit-${data.occurrence_number}`,
        connection_ids: [connections[data.node_visit_number === 1 ? 4 : 5].id],
      };
    }
    return complete(data, board);
  });
  expect((await h.engine.run()).status).toBe("completed");
  expect(
    visits
      .filter((v) => v.node_id === nodes[3].id)
      .map((v) => v.node_visit_number),
  ).toEqual([1, 2]);
  const branches = visits
    .filter((v) => v.node_id === nodes[1].id)
    .map((v) => v.branch_ref);
  expect(branches[0]).not.toBe(branches[1]);
});
it("parallel human waiting does not pause active time while its sibling still works", async () => {
  const { board, nodes } = graph(
    ["trigger", "human_approval", "task", "check", "outcome"],
    [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ],
  );
  nodes[0].split_mode = "parallel";
  nodes[3].join_for_split_id = nodes[0].id;
  const wait = deferred<void>(),
    human = deferred<void>(),
    sibling = deferred<StepReply>();
  const h = harness(
    board,
    async (data, resume) => {
      if (data.node_id === nodes[1].id && !resume)
        return { kind: "human", step_id: "h", request_id: "h" };
      if (data.node_id === nodes[2].id) return sibling.promise;
      return complete(data, board);
    },
    {
      human: async () => {
        wait.resolve();
        await human.promise;
      },
    },
  );
  const running = h.engine.run();
  await wait.promise;
  h.tick(50);
  expect(h.engine.isWaiting()).toBe(false);
  expect(h.engine.activeElapsed()).toBe(50);
  sibling.resolve({
    kind: "complete",
    step_id: "sibling",
    connection_ids: board.connections
      .filter((e) => e.source_node_id === nodes[2].id)
      .map((e) => e.id),
  });
  await new Promise((r) => setTimeout(r, 0));
  expect(h.engine.isWaiting()).toBe(true);
  h.tick(10000);
  expect(h.engine.activeElapsed()).toBe(50);
  human.resolve();
  expect((await running).status).toBe("completed");
});
it("unbounded loops stop as needs attention rather than success", async () => {
  const { board } = graph(["trigger"], [[0, 0]]);
  let calls = 0;
  const h = harness(
    board,
    async (d) => {
      calls++;
      return complete(d, board);
    },
    {},
    { step_attempts: 3, active_ms: 100 },
  );
  expect((await h.engine.run()).status).toBe("needs_attention");
  expect(calls).toBe(3);
});
it("keeps parallel inputs independent until the paired merge", async () => {
  const { board, nodes } = graph(
    ["trigger", "task", "task", "task", "check", "outcome"],
    [
      [0, 1],
      [0, 3],
      [1, 2],
      [2, 4],
      [3, 4],
      [4, 5],
    ],
  );
  nodes[0].split_mode = "parallel";
  nodes[4].join_for_split_id = nodes[0].id;
  const left = deferred<StepReply>(),
    rightDone = deferred<void>();
  const h = harness(board, async (data) => {
    if (data.node_id === nodes[1].id) return left.promise;
    if (data.node_id === nodes[3].id) rightDone.resolve();
    if (data.node_id === nodes[2].id)
      expect(data.input_step_refs[nodes[3].id]).toBeUndefined();
    if (data.node_id === nodes[4].id) {
      expect(data.input_step_refs[nodes[2].id]).toBeTruthy();
      expect(data.input_step_refs[nodes[3].id]).toBeTruthy();
    }
    return complete(data, board);
  });
  const running = h.engine.run();
  await rightDone.promise;
  await new Promise((r) => setTimeout(r, 0));
  left.resolve({
    kind: "complete",
    step_id: "left",
    connection_ids: board.connections
      .filter((e) => e.source_node_id === nodes[1].id)
      .map((e) => e.id),
  });
  expect((await running).status).toBe("completed");
});
