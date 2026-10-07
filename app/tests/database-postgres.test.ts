import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase } from "../src/server/database";

it.skipIf(!process.env.TEST_DATABASE_URL)("releases an abandoned transaction's lock and reconnects after PostgreSQL terminates it", async () => {
  const url = process.env.TEST_DATABASE_URL!;
  if (!["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname))
    throw new Error("Use isolated local/CI PostgreSQL.");
  const db = await createDatabase(url);
  const table = `recovery_${randomUUID().replaceAll("-", "")}`;
  try {
    await db.exec(`CREATE TABLE ${table} (value integer NOT NULL); INSERT INTO ${table} VALUES (0)`);
    await expect(db.transaction(async (tx) => {
      await tx.exec(`UPDATE ${table} SET value=1`);
      // Simulate a client that stops talking while holding a row lock.
      await tx.exec("SET LOCAL idle_in_transaction_session_timeout = '50ms'");
      await new Promise(resolve => setTimeout(resolve, 150));
    })).rejects.toThrow();
    expect((await db.query(`SELECT value FROM ${table}`)).rows).toEqual([{ value: 0 }]);
    await db.transaction(async (tx) => {
      await tx.exec(`UPDATE ${table} SET value=2`);
    });
    expect((await db.query(`SELECT value FROM ${table}`)).rows).toEqual([{ value: 2 }]);
  } finally {
    await db.exec(`DROP TABLE IF EXISTS ${table}`);
    await db.close();
  }
});
