import nextEnv from "@next/env";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { configuredDatabaseUrl, createDatabase } from "../src/server/database";
import { LocalObjectStore, SupabaseObjectStore } from "../src/server/artifacts/storage";

nextEnv.loadEnvConfig(process.cwd());
const roots = process.argv.filter((arg) => arg.startsWith("--source=")).map((arg) => arg.slice(9));
if (!roots.length) throw new Error("Pass one or more --source=/absolute/artifact/directory arguments.");
const url = configuredDatabaseUrl();
if (!url) throw new Error("Configure the remote database before mirroring artifacts.");
const db = await createDatabase(url);
const sources = roots.map((root) => new LocalObjectStore(root));
const destination = new SupabaseObjectStore();
const verified = new Set<string>();
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });
type Row = { id: string; storage_key: string; content_hash: string; byte_size: string | number; media_type: string };
function matches(row: Row, bytes: Buffer) {
  return bytes.length === Number(row.byte_size) && createHash("sha256").update(bytes).digest("hex") === row.content_hash;
}

try {
  do {
    const rows = (await db.query<Row>("SELECT id,storage_key,content_hash,byte_size,media_type FROM artifacts WHERE state='ready' AND storage_backend='local' ORDER BY created_at DESC")).rows.filter((row) => !verified.has(row.id));
    let cursor = 0, missing = 0, failed = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (!stopping && cursor < rows.length) {
        const row = rows[cursor++];
        try {
          let source: Buffer | undefined;
          for (const store of sources) {
            try {
              const bytes = await store.read(row.storage_key);
              if (!matches(row, bytes)) throw new Error("Local integrity mismatch");
              source = bytes;
              break;
            } catch (error) {
              if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
            }
          }
          if (!source) { missing++; continue; }
          // Never overwrite existing remote bytes, even when they differ.
          try { await destination.write(row.storage_key, source, row.media_type); }
          catch { /* An existing immutable copy is checked below. */ }
          const remote = await destination.read(row.storage_key);
          if (!matches(row, remote)) throw new Error("Remote integrity mismatch");
          verified.add(row.id);
        } catch {
          failed++;
          console.error(`Artifact ${row.id} could not be verified; source and database are unchanged.`);
        }
      }
    }));
    console.log(JSON.stringify({ verified: verified.size, missing_local_files: missing, failed, pending: Math.max(0, rows.length - cursor) }));
    if (!process.argv.includes("--watch") || stopping) {
      if (missing || failed) process.exitCode = 1;
      break;
    }
    await delay(5000);
  } while (!stopping);
} finally { await db.close(); }
