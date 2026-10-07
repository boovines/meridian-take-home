import { Sandbox } from "@vercel/sandbox";
import { Writable } from "node:stream";
import { DomainError } from "../../domain/canvas";
import type { Project } from "../../domain/project";
import { validateProject } from "../engineering/project";

export async function validateInSandbox(input: Project, signal: AbortSignal) {
  const project = validateProject(input);
  signal.throwIfAborted();
  const sandbox = await Sandbox.create({
    image: "vercel/sandbox/node:24",
    persistent: false,
    resources: { vcpus: 1 },
    networkPolicy: "deny-all",
    timeout: 60000,
  });
  const cancel = () => {
    void sandbox.stop().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    await sandbox.mkDir("/tmp/meridian");
    await sandbox.mkDir("/tmp/meridian/steps");
    await sandbox.mkDir("/tmp/meridian/human");
    await sandbox.writeFiles(
      Object.entries(project.files).map(([path, source]) => ({
        path: `/tmp/meridian/${path}`,
        content: Buffer.from(source),
      })),
    );
    // Syntax checking parses source without executing candidate top-level code.
    const check = `const {spawnSync}=require('node:child_process'); const files=${JSON.stringify(Object.keys(project.files).filter((p) => p.endsWith(".mjs")))}; for(const file of files){const r=spawnSync(process.execPath,['--check',file],{timeout:3000,maxBuffer:8192});if(r.status!==0){console.error(JSON.stringify({file,diagnostic:String(r.stderr).slice(0,2000)}));process.exit(1)}} console.log('Syntax valid for '+files.length+' modules.');`;
    const discard = () =>
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      });
    const result = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", check],
      cwd: "/tmp/meridian",
      stdout: discard(),
      stderr: discard(),
    });
    signal.throwIfAborted();
    if (result.exitCode !== 0) {
      const diagnostic = (await result.stderr()).slice(0, 2400);
      throw new DomainError(
        422,
        "PROJECT_BUILD_FAILED",
        "Generated JavaScript failed syntax validation. Regenerate the project.",
        { diagnostic },
      );
    }
    return {
      engine: "vercel-sandbox",
      check: "node --check",
      module_count: Object.keys(project.files).filter((p) => p.endsWith(".mjs"))
        .length,
    };
  } finally {
    signal.removeEventListener("abort", cancel);
    await sandbox.stop();
  }
}
