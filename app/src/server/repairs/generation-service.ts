import type { z } from "zod";
import { DomainError } from "../../domain/canvas";
import { repairSources } from "../../domain/repair";
import type { Project } from "../../domain/project";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { assembleProject, validateProject } from "../engineering/project";
import { RepairService } from "./service";
export type RepairContext = Awaited<
  ReturnType<RepairService["generationContext"]>
>;
export interface RepairGenerator {
  model: string;
  generate(
    context: RepairContext,
    baseline: Project,
    signal: AbortSignal,
  ): Promise<z.infer<typeof repairSources>>;
}
export class RepairGenerationService {
  constructor(
    private db: Database,
    private artifacts = new ArtifactService(db),
  ) {}
  async run(attemptId: string, adapter: RepairGenerator, signal: AbortSignal) {
    const repairs = new RepairService(this.db);
    const claimed = await repairs.claimGeneration(attemptId);
    if (!claimed.token) return claimed.attempt;
    const context = await repairs.generationContext(attemptId);
    signal.throwIfAborted();
    // Reuse a complete durable artifact if a prior activity died before publishing.
    const checkpoint = (
      await this.db.query(
        "SELECT id,metadata FROM artifacts WHERE workflow_id=$1 AND kind='generated_project' AND state='ready' AND metadata->>'repair_attempt_id'=$2 ORDER BY created_at DESC LIMIT 1",
        [claimed.job.workflow_id, attemptId],
      )
    ).rows[0];
    let project: Project,
      artifactId: string,
      diagnosis: z.infer<typeof repairSources>["diagnosis"];
    if (checkpoint) {
      artifactId = String(checkpoint.id);
      project = validateProject(
        JSON.parse(
          (
            await this.artifacts.read(claimed.job.workflow_id, artifactId)
          ).bytes.toString(),
        ),
      );
      diagnosis = repairSources.shape.diagnosis.parse(
        (checkpoint.metadata as Record<string, unknown>).diagnosis,
      );
    } else {
      const version = (
        await this.db.query(
          "SELECT artifact_id FROM implementation_versions WHERE id=$1 AND workflow_id=$2",
          [claimed.attempt.baseline_version_id, claimed.job.workflow_id],
        )
      ).rows[0];
      const baseline = validateProject(
        JSON.parse(
          (
            await this.artifacts.read(
              claimed.job.workflow_id,
              String(version.artifact_id),
            )
          ).bytes.toString(),
        ),
      );
      const generated = repairSources.parse(
        await adapter.generate(context, baseline, signal),
      );
      signal.throwIfAborted();
      diagnosis = generated.diagnosis;
      project = assembleProject(
        context.spec.board,
        context.spec.id,
        context.plan,
        context.steps,
        generated.project,
        adapter.model,
      );
      artifactId = (
        await this.artifacts.create(
          claimed.job.workflow_id,
          "generated_project",
          "repair-project.json",
          "application/json",
          Buffer.from(JSON.stringify(project)),
          { repair_attempt_id: attemptId, diagnosis },
        )
      ).id;
    }
    signal.throwIfAborted();
    if (
      project.plan_version_id !== context.plan.id ||
      project.frozen_spec_id !== context.spec.id
    )
      throw new DomainError(
        409,
        "REPAIR_CONTEXT_CHANGED",
        "The candidate does not match the repair's approved plan.",
      );
    // Build failures are evaluation evidence; publish source before evaluating it.
    return repairs.publishCandidate(
      attemptId,
      claimed.token,
      artifactId,
      project,
      diagnosis,
    );
  }
}
