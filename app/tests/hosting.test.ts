import { afterEach, expect, it, vi } from "vitest";
import { databaseConnectionOptions } from "../src/server/database";
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
