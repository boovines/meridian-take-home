import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
export interface ObjectStore {
  readonly backend: "local" | "supabase";
  write(key: string, bytes: Buffer, mediaType: string): Promise<void>;
  read(key: string): Promise<Buffer>;
}
function safeKey(key: string) {
  if (!/^[a-f0-9-]+\/[a-f0-9-]+\/payload$/.test(key))
    throw new Error("Invalid artifact storage key.");
  return key;
}
export class LocalObjectStore implements ObjectStore {
  readonly backend = "local" as const;
  constructor(private root = path.resolve("../.runtime/artifacts")) {}
  async write(key: string, bytes: Buffer) {
    const target = path.join(this.root, safeKey(key));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }
  async read(key: string) {
    return readFile(path.join(this.root, safeKey(key)));
  }
}
export class SupabaseObjectStore implements ObjectStore {
  readonly backend = "supabase" as const;
  private client;
  constructor(
    private bucket = process.env.SUPABASE_ARTIFACT_BUCKET ||
      "meridian-artifacts",
  ) {
    const key =
        process.env.SUPABASE_SECRET_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY,
      url = process.env.SUPABASE_URL;
    if (!key || !url)
      throw new Error(
        "Configure the Supabase server secret key for private file storage.",
      );
    this.client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  async write(key: string, bytes: Buffer, mediaType: string) {
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(safeKey(key), bytes, { contentType: mediaType, upsert: false });
    if (error)
      throw new Error(
        "Private artifact upload failed. Check the configured bucket and server key.",
      );
  }
  async read(key: string) {
    const { data, error } = await this.client.storage
      .from(this.bucket)
      .download(safeKey(key));
    if (error || !data) throw new Error("Unable to read the private artifact.");
    return Buffer.from(await data.arrayBuffer());
  }
}
export function objectStore(backend?: "local" | "supabase"): ObjectStore {
  if (backend === "local")
    return new LocalObjectStore(process.env.LOCAL_ARTIFACT_PATH);
  if (
    backend === "supabase" ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )
    return new SupabaseObjectStore();
  if (
    process.env.NODE_ENV === "production" &&
    process.env.MERIDIAN_LOCAL_DEMO !== "true"
  )
    throw new Error("Production requires private Supabase artifact storage.");
  return new LocalObjectStore(process.env.LOCAL_ARTIFACT_PATH);
}
