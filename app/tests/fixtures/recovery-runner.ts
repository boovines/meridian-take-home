// Test-only runtime adapter. Exercises host persistence and routing; it neither
// executes generated source nor establishes source/LLM correctness.
import type { Database } from "../../src/server/database";
import { RunService } from "../../src/server/runtime/run-service";
import { StepService } from "../../src/server/runtime/step-service";
import { RuntimeEngine } from "../../src/domain/runtime-engine";
import { checkRecoveryBuild } from "../../src/server/repairs/recovery-build";
export async function rerunRecoveryFixture(db: Database, runId: string) {
  const runs = new RunService(db),
    steps = new StepService(db);
  await checkRecoveryBuild(
    db,
    runId,
    async () => ({ engine: "fixture" }),
    AbortSignal.timeout(10000),
  );
  const context = await runs.prepareCase(runId);
  if (!context) return;
  const engine = new RuntimeEngine(runId, context.definition, {
    now: () => Date.now(),
    changed() {},
    project: (p) => runs.project(runId, p),
    human: async () => {
      throw new Error(
        "Interactive human recovery requires the durable worker; fixture mode never approves on behalf of the user.",
      );
    },
    step: (data, resume) =>
      steps.execute(
        data,
        {
          invoke: async (_project, node, c) => ({
            kind: "complete",
            output: c.input,
            matching_connection_ids: context.definition.board.connections
              .filter((e) => e.source_node_id === node && !e.is_default)
              .map((e) => e.id),
          }),
          reason: async () => ({}),
        },
        AbortSignal.timeout(10000),
        resume,
      ),
  });
  await runs.finishCase(runId, await engine.run());
}
