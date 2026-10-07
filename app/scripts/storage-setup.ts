import nextEnv from "@next/env";
import { createClient } from "@supabase/supabase-js";
nextEnv.loadEnvConfig(process.cwd());
const url = process.env.SUPABASE_URL,
  key =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key)
  throw new Error(
    "Configure SUPABASE_URL and the server secret key in app/.env.local.",
  );
const bucket = process.env.SUPABASE_ARTIFACT_BUCKET || "meridian-artifacts";
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const existing = await client.storage.getBucket(bucket);
if (existing.error) {
  const created = await client.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: 25 * 1024 * 1024,
  });
  if (created.error)
    throw new Error(
      "Could not create the private artifact bucket. Check the server key and bucket configuration.",
    );
} else if (existing.data.public)
  throw new Error("The configured artifact bucket must be private.");
console.log("Private Supabase artifact bucket is ready.");
