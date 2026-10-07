import { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";
import { DomainError } from "../../domain/canvas";
import type { Project } from "../../domain/project";
import type { Json } from "../../domain/runtime";
import { validateProject } from "../engineering/project";

// Candidate code runs only in an ephemeral network-denied VM. A supervisor
// bounds CPU time and output; application credentials never enter the VM.
export async function invokeInSandbox(
  raw: Project,
  nodeId: string,
  context: Record<string, Json>,
  signal: AbortSignal,
): Promise<unknown> {
  const project = validateProject(raw);
  if (!project.node_file_map[nodeId])
    throw new DomainError(
      422,
      "INVALID_NODE",
      "No generated module exists for this node.",
    );
  const input = Buffer.from(JSON.stringify(context));
  if (input.byteLength > 2_000_000)
    throw new DomainError(
      422,
      "STEP_INPUT_TOO_LARGE",
      "The step context exceeds the 2 MB demo limit.",
    );
  signal.throwIfAborted();
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.create({
      image: "vercel/sandbox/node:24",
      persistent: false,
      resources: { vcpus: 1 },
      networkPolicy: "deny-all",
      timeout: 60000,
    });
  } catch {
    throw new DomainError(
      503,
      "SANDBOX_UNAVAILABLE",
      "Vercel Sandbox could not start. Check access and retry the run.",
    );
  }
  const cancel = () => {
    void sandbox.stop().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await sandbox.mkDir("/tmp/meridian");
    await sandbox.mkDir("/tmp/meridian/steps");
    await sandbox.mkDir("/tmp/meridian/human");
    await sandbox.writeFiles([
      ...Object.entries(project.files).map(([path, source]) => ({
        path: `/tmp/meridian/${path}`,
        content: Buffer.from(source),
      })),
      { path: "/tmp/meridian/context.json", content: input },
    ]);
    const supervisor = `const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['--max-old-space-size=128','run-step.mjs',${JSON.stringify(nodeId)},'context.json'],{timeout:20000,maxBuffer:131072,encoding:'utf8'});if(r.error||r.status!==0){process.stdout.write(JSON.stringify({ok:false,message:r.error?'Step timed out or exceeded its output limit.':String(r.stderr).slice(0,2000)}));}else{try{process.stdout.write(JSON.stringify({ok:true,value:JSON.parse(r.stdout)}))}catch{process.stdout.write(JSON.stringify({ok:false,message:'The step did not return one JSON result.'}))}}`;
    const discard = () =>
      new Writable({
        write(_chunk, _enc, done) {
          done();
        },
      });
    const command = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", supervisor],
      cwd: "/tmp/meridian",
      stdout: discard(),
      stderr: discard(),
    });
    signal.throwIfAborted();
    if (command.exitCode !== 0)
      throw new DomainError(
        422,
        "STEP_CRASH",
        "The isolated step process exited without a result.",
      );
    const text = await command.stdout();
    if (Buffer.byteLength(text) > 140_000)
      throw new DomainError(
        422,
        "STEP_OUTPUT_TOO_LARGE",
        "The isolated result exceeded its limit.",
      );
    const result = JSON.parse(text) as {
      ok: boolean;
      value?: unknown;
      message?: string;
    };
    if (!result.ok)
      throw new DomainError(
        422,
        "STEP_CRASH",
        result.message || "The isolated step failed.",
      );
    return result.value;
  } finally {
    signal.removeEventListener("abort", cancel);
    await sandbox.stop();
  }
}
