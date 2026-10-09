import { finishEvaluationWithRepair } from "../../src/server/evaluations/automatic-repair";
// Test-only executor: exercises persistence/grading with a known pass-through fixture.
// It never evaluates project source and is only loaded by the guarded local dispatcher.
import type { Database } from "../../src/server/database";
import { EvaluationService } from "../../src/server/evaluations/evaluation-service";
import { EvaluationExecutionService } from "../../src/server/evaluations/execution-service";
import { answerScriptedHuman } from "../../src/server/evaluations/scripted-human";
import { RunService } from "../../src/server/runtime/run-service";
import { StepService } from "../../src/server/runtime/step-service";
import { frozenSpec } from "../../src/server/engineering/plan-service";
import { RuntimeEngine } from "../../src/domain/runtime-engine";
import type { Project } from "../../src/domain/project";
import type { Json } from "../../src/domain/runtime";
export async function evaluateFixture(
  db: Database,
  jobId: string,
  evaluationId?: string,
) {
  const evals = new EvaluationService(db),
    execution = new EvaluationExecutionService(db),
    runs = new RunService(db),
    steps = new StepService(db);
  const ready = await evals.prepare(jobId, evaluationId);
  if (!ready) return;
  const spec = await frozenSpec(db, ready.evaluation.workflow_id);
  const adapters = {
    invoke: async (
      _project: Project,
      node: string,
      context: Record<string, Json>,
    ) => ({
      kind: "complete",
      output: context.input,
      matching_connection_ids: spec.board.connections
        .filter((e) => e.source_node_id === node && !e.is_default)
        .map((e) => e.id),
    }),
    reason: async () => ({}),
  };
  for (const r of ready.results) {
    const task = await evals.beginCase(r.id);
    if (task.skip) continue;
    if (task.kind === "step")
      await execution.step(r.id, adapters, AbortSignal.timeout(10000));
    else {
      const context = (await runs.prepareCase(task.run_id))!;
      const engine = new RuntimeEngine(task.run_id, context.definition, {
        now: () => Date.now(),
        scriptedHuman: true,
        changed() {},
        project: (p) => runs.project(task.run_id, p),
        step: (data, resume) =>
          steps.execute(data, adapters, AbortSignal.timeout(10000), resume),
        human: async (id) => {
          const answer = await answerScriptedHuman(db, task.run_id, id);
          if (!answer.ok) throw new Error(answer.message);
        },
      });
      await runs.finishCase(task.run_id, await engine.run());
      await execution.workflow(r.id);
    }
  }
  await db.query(
    'UPDATE workflow_jobs SET progress=progress||\'{"engine":"fixture"}\'::jsonb WHERE id=$1',
    [jobId],
  );
  const next = await finishEvaluationWithRepair(db, jobId, undefined, false, evaluationId);
  if (next) {
    const { repairFixture } = await import("./repair-runner");
    await repairFixture(db, next.id);
  }
}
