import nextEnv from "@next/env";
import {
  configuredDatabaseUrl,
  createDatabase,
  migrate,
} from "../src/server/database";
nextEnv.loadEnvConfig(process.cwd());
const url = configuredDatabaseUrl();
if (!url)
  throw new Error(
    "Configure DATABASE_URL or the Supabase connection settings.",
  );
const db = await createDatabase(url);
try {
  if (process.argv.includes("--migrate")) {
    await migrate(db);
    console.log("Database migrations applied.");
  } else {
    await db.query("SELECT 1");
    console.log("Database connection verified.");
  }
} catch (error) {
  // Never print URLs, query values, credentials or provider response bodies.
  console.error(
    "Database check failed:",
    typeof error === "object" && error && "code" in error
      ? error.code
      : "CONNECTION_ERROR",
  );
  process.exitCode = 1;
} finally {
  await db.close();
}
