// Test-only pass-through generator/executor. It does not execute or "repair" source.
import type { Database } from "../../src/server/database";
import { RepairService } from "../../src/server/repairs/service";
import { RepairGenerationService } from "../../src/server/repairs/generation-service";
import { fixtureSources } from "./engineer";
import { evaluateFixture } from "./evaluation-runner";
export async function repairFixture(db: Database, jobId: string) {
  const service = new RepairService(db);
  try {
    const ready = await service.prepare(jobId);
    if (!ready) return;
    for (let number = 1; number <= ready.session.attempt_limit; number++) {
      const attempt = await service.beginAttempt(jobId, number);
      await new RepairGenerationService(db).run(
        attempt.id,
        {
          model: "fixture",
          generate: async (c) => ({
            diagnosis: {
              summary: "Fixture candidate; no live model repair.",
              affected_node_ids: c.steps.map(s => s.node_id),
              changes: ["Preserve the known pass-through fixture."],
            },
            project: fixtureSources(c.spec.board, c.steps),
          }),
        },
        AbortSignal.timeout(10000),
      );
      const evaluation = await service.createEvaluation(attempt.id);
      await evaluateFixture(db, jobId, evaluation.id);
      if ((await service.decide(attempt.id)).session.status !== "running")
        return;
    }
  } catch {
    await service.finish(
      jobId,
      "failed",
      "Fixture repair could not complete.",
      "FIXTURE_REPAIR_FAILED",
    );
  }
}
