import { PGlite } from "@electric-sql/pglite";
import { Pool, type PoolClient } from "pg";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DomainError } from "../domain/errors";

export interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
}
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDatabase(
  url?: string,
  localPath?: string,
): Promise<Database> {
  if (url) {
    const pool = new Pool({
      ...databaseConnectionOptions(url),
      max: 4,
      connectionTimeoutMillis: 10000,
      query_timeout: 15000,
    });
    // pg removes failed idle clients; keep its error event from crashing the host.
    pool.on("error", () => {
      console.warn(
        "An idle database connection closed; the pool will reconnect.",
      );
    });
    return {
      query: (sql, values) => pool.query(sql, values),
      async exec(sql) {
        await pool.query(sql);
      },
      async transaction(fn) {
        const client: PoolClient = await pool.connect();
        let connectionError: Error | undefined;
        let discard = false;
        const onError = (error: Error) => {
          connectionError = error;
        };
        client.on("error", onError);
        try {
          // Server-side limits survive a disconnected client and release its locks.
          // All model/network work belongs outside these short transactions.
          await client.query(
            "BEGIN; SET LOCAL statement_timeout = '10s'; SET LOCAL idle_in_transaction_session_timeout = '30s'",
          );
          const result = await fn({
            query: (sql, values) => client.query(sql, values),
            exec: async (sql) => {
              await client.query(sql);
            },
          });
          if (connectionError) throw connectionError;
          await client.query("COMMIT");
          return result;
        } catch (error) {
          discard = Boolean(connectionError);
          if (!discard) {
            try {
              await client.query("ROLLBACK");
            } catch {
              discard = true;
            }
          }
          throw error;
        } finally {
          client.removeListener("error", onError);
          client.release(discard || Boolean(connectionError));
        }
      },
      close: () => pool.end(),
    };
  }
  if (localPath) await mkdir(localPath, { recursive: true });
  const db = new PGlite(localPath);
  await db.waitReady;
  return {
    query: (sql, values) => db.query(sql, values),
    exec: async (sql) => {
      await db.exec(sql);
    },
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: (sql, values) => tx.query(sql, values),
          exec: async (sql) => {
            await tx.exec(sql);
          },
        }),
      ),
    close: () => db.close(),
  };
}

// Hosted environments cannot read a CA file from the developer's laptop.
// An explicitly supplied CA replaces URL TLS parameters without disabling verification.
export function databaseConnectionOptions(url: string) {
  const ca = process.env.SUPABASE_DB_SSL_CA;
  if (!ca) return { connectionString: url };
  const connection = new URL(url);
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey", "ssl"])
    connection.searchParams.delete(key);
  return {
    connectionString: connection.toString(),
    ssl: { ca, rejectUnauthorized: true },
  };
}

export async function migrate(db: Database) {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const dir = path.join(process.cwd(), "migrations");
  for (const name of (await readdir(dir))
    .filter((n) => n.endsWith(".sql"))
    .sort()) {
    await db.transaction(async (tx) => {
      await tx.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
      if (
        (
          await tx.query("SELECT name FROM schema_migrations WHERE name = $1", [
            name,
          ])
        ).rows.length
      )
        return;
      await tx.exec(await readFile(path.join(dir, name), "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES ($1)", [name]);
    });
  }
}

// Connectivity alone cannot establish readiness: deployed code may require tables
// that a reachable database does not have. Never apply remote migrations implicitly.
export async function assertMigrationsApplied(db: Queryable) {
  const expected = (await readdir(path.join(process.cwd(), "migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const exists = (
    await db.query("SELECT to_regclass('public.schema_migrations') AS relation")
  ).rows[0]?.relation;
  const applied = new Set(
    exists
      ? (await db.query("SELECT name FROM schema_migrations")).rows.map(
          (row) => row.name,
        )
      : [],
  );
  const missing = expected.filter((name) => !applied.has(name));
  if (missing.length)
    throw new DomainError(
      503,
      "SCHEMA_OUTDATED",
      "The database needs an application update. Run npm run db:migrate from the deployed release, then retry.",
      { missing_migrations: missing },
    );
}

export function configuredDatabaseUrl() {
  if (process.env.MERIDIAN_DATABASE === "local") return undefined;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const {
    SUPABASE_DB_PASSWORD: password,
    SUPABASE_DB_HOST: host,
    SUPABASE_DB_USER: user,
  } = process.env;
  if (!password || !host || !user) return undefined;
  const cert = process.env.SUPABASE_DB_SSL_ROOT_CERT;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${process.env.SUPABASE_DB_PORT || "5432"}/${process.env.SUPABASE_DB_NAME || "postgres"}?sslmode=verify-full${cert ? `&sslrootcert=${encodeURIComponent(cert)}` : ""}`;
}

const globals = globalThis as typeof globalThis & {
  meridianDatabase?: Promise<Database>;
};
export function getDatabase(): Promise<Database> {
  if (!globals.meridianDatabase) {
    globals.meridianDatabase = (async () => {
      const url = configuredDatabaseUrl();
      if (
        !url &&
        process.env.NODE_ENV === "production" &&
        process.env.MERIDIAN_LOCAL_DEMO !== "true"
      ) {
        throw new Error(
          "Configure Supabase DATABASE_URL before starting production.",
        );
      }
      const db = await createDatabase(
        url,
        process.env.LOCAL_DATABASE_PATH ||
          path.resolve(process.cwd(), "../.runtime/database"),
      );
      try {
        if (!url) await migrate(db);
        else await assertMigrationsApplied(db);
      } catch (error) {
        await db.close();
        throw error;
      }
      return db;
    })().catch((error) => {
      globals.meridianDatabase = undefined;
      throw error;
    });
  }
  return globals.meridianDatabase;
}
