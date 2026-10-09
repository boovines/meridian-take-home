import { expect, it } from "vitest";
import {
  createDatabase,
  migrate,
  assertMigrationsApplied,
} from "../src/server/database";
it("rejects an empty or outdated schema and accepts it only after migrations", async () => {
  const db = await createDatabase();
  try {
    await expect(assertMigrationsApplied(db)).rejects.toMatchObject({
      code: "SCHEMA_OUTDATED",
    });
    await migrate(db);
    await expect(assertMigrationsApplied(db)).resolves.toBeUndefined();
    await db.query(
      "DELETE FROM schema_migrations WHERE name='018_process_context.sql'",
    );
    await expect(assertMigrationsApplied(db)).rejects.toMatchObject({
      code: "SCHEMA_OUTDATED",
      details: { missing_migrations: ["018_process_context.sql"] },
    });
  } finally {
    await db.close();
  }
});
