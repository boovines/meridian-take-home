import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("pg", () => ({
  Pool: class {
    on() { return this; }
    async connect() { return state.clients.shift(); }
    async end() {}
  },
}));
import { createDatabase } from "../src/server/database";

it("keeps the original transaction failure and discards a connection whose rollback failed", async () => {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("Connection lost during rollback");
      return { rows: [] };
    }),
    release: vi.fn(),
  });
  state.clients.push(client);
  const db = await createDatabase("postgres://localhost/isolated-test");
  const original = new Error("Operation interrupted");
  await expect(db.transaction(async () => { throw original; })).rejects.toBe(original);
  expect(client.release).toHaveBeenCalledWith(true);
  await db.close();
});

it("contains a checked-out connection error and refuses to commit its transaction", async () => {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async () => ({ rows: [] })),
    release: vi.fn(),
  });
  state.clients.push(client);
  const db = await createDatabase("postgres://localhost/isolated-test");
  const lost = new Error("Connection closed while transaction was idle");
  await expect(db.transaction(async () => {
    client.emit("error", lost);
    return "must not commit";
  })).rejects.toBe(lost);
  expect(client.query).not.toHaveBeenCalledWith("COMMIT");
  expect(client.release).toHaveBeenCalledWith(true);
  expect(client.listenerCount("error")).toBe(0);
  await db.close();
});
