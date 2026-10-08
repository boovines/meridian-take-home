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
            project: (() => {
              const sources = fixtureSources(c.spec.board, c.steps);
              sources.steps.forEach(s => s.source_lines.push(`// Distinct fixture candidate ${number}`));
              return sources;
            })(),
          }),
        },
        AbortSignal.timeout(10000),
      );
      for (let round = 1; round <= 3; round++) {
        const evaluation = await service.createEvaluation(attempt.id, round);
        await evaluateFixture(db, jobId, evaluation.id);
        const result = await service.decide(attempt.id);
        if (result.session.status !== "running") return;
        if (result.attempt.status !== "running") break;
      }
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
