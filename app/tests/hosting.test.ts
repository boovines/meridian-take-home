import { afterEach, expect, it, vi } from "vitest";
import { createDatabase, databaseConnectionOptions } from "../src/server/database";
import { objectStore, LocalObjectStore, SupabaseObjectStore } from "../src/server/artifacts/storage";

afterEach(() => vi.unstubAllEnvs());

it("uses an inline hosted CA without URL options weakening TLS verification", () => {
  vi.stubEnv("SUPABASE_DB_SSL_CA", "test certificate");
  const result = databaseConnectionOptions("postgresql://localhost/demo?sslmode=no-verify&sslrootcert=/laptop/ca.pem&application_name=demo");
  expect(result.ssl).toEqual({ ca: "test certificate", rejectUnauthorized: true });
  const url = new URL(result.connectionString);
  expect(url.searchParams.has("sslmode")).toBe(false);
  expect(url.searchParams.has("sslrootcert")).toBe(false);
  expect(url.searchParams.get("application_name")).toBe("demo");
});

it("preserves existing database configuration when no hosted CA is supplied", () => {
  vi.stubEnv("SUPABASE_DB_SSL_CA", "");
  const url = "postgresql://localhost/demo?sslmode=verify-full";
  expect(databaseConnectionOptions(url)).toEqual({ connectionString: url });
});

it("reads local history from its private mirror only when explicitly configured", () => {
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SECRET_KEY", "fixture-key");
  vi.stubEnv("LOCAL_ARTIFACT_READ_BACKEND", "");
  expect(objectStore("local")).toBeInstanceOf(LocalObjectStore);
  vi.stubEnv("LOCAL_ARTIFACT_READ_BACKEND", "supabase");
  expect(objectStore("local")).toBeInstanceOf(SupabaseObjectStore);
});


it("reads a legacy frozen snapshot only when unambiguous and leaves its pointer unchanged", async () => {
  const { frozenSpec } = await import("../src/server/engineering/plan-service");
  const db = await createDatabase();
  try {
    // Isolated legacy-shaped fixture, including the absent current-version pointer.
    await db.exec("CREATE TABLE workflows(id text PRIMARY KEY,state text,current_frozen_spec_id text); CREATE TABLE frozen_specs(id text,workflow_id text,version_number integer,parent_frozen_spec_id text,graph jsonb)");
    await db.exec("INSERT INTO workflows VALUES ('w','frozen',NULL); INSERT INTO frozen_specs VALUES ('v1','w',1,NULL,'{}')");
    expect((await frozenSpec(db, "w")).id).toBe("v1");
    expect((await db.query("SELECT current_frozen_spec_id FROM workflows")).rows[0].current_frozen_spec_id).toBeNull();
    await db.exec("UPDATE workflows SET state='draft'");
    await expect(frozenSpec(db, "w")).rejects.toMatchObject({ code: "FREEZE_REQUIRED" });
    await db.exec("UPDATE workflows SET state='frozen'; INSERT INTO frozen_specs VALUES ('v2','w',2,'v1','{}')");
    await expect(frozenSpec(db, "w")).rejects.toMatchObject({ code: "FREEZE_REQUIRED" });
    expect((await frozenSpec(db, "w", "v1")).id).toBe("v1");
    await db.exec("UPDATE workflows SET current_frozen_spec_id='v2'");
    expect((await frozenSpec(db, "w")).id).toBe("v2");
  } finally { await db.close(); }
});
