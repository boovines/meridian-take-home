import nextEnv from "@next/env";
import { Sandbox } from "@vercel/sandbox";
nextEnv.loadEnvConfig(process.cwd());
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to run a short-lived Vercel Sandbox check.");
const sandbox = await Sandbox.create({
  image: "vercel/sandbox/node:24",
  persistent: false,
  timeout: 30000,
  resources: { vcpus: 1 },
  networkPolicy: "deny-all",
});
try {
  await sandbox.mkDir("/tmp/meridian");
  const result = await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      "console.log(JSON.stringify({calculation:2+2,credentialPresent:!!process.env.OPENAI_API_KEY,node:process.version}))",
    ],
    cwd: "/tmp/meridian",
  });
  const output = JSON.parse(await result.stdout());
  if (
    result.exitCode !== 0 ||
    output.calculation !== 4 ||
    output.credentialPresent
  )
    throw new Error("Unexpected sandbox result.");
  console.log(
    "Vercel Sandbox execution verified:",
    output.node,
    "with no application credentials and denied network egress.",
  );
} finally {
  await sandbox.stop();
  console.log("Ephemeral sandbox stopped.");
}
