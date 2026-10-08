import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { generatedSources, Project } from "../../domain/project";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { JobService } from "./job-service";
import { assembleProject, validateProject } from "./project";
type Context = NonNullable<
  Awaited<ReturnType<JobService["prepareGeneration"]>>
>;
export interface GenerationAdapters {
  model: string;
  generate: (
    context: Context,
    seed: Project | null,
    signal: AbortSignal,
  ) => Promise<z.infer<typeof generatedSources>>;
  validate: (
    project: Project,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}
export class GenerationService {
  constructor(
    private db: Database,
    private artifacts = new ArtifactService(db),
  ) {}
  async run(id: string, adapters: GenerationAdapters, signal: AbortSignal) {
    const jobs = new JobService(this.db),
      context = await jobs.prepareGeneration(id);
    if (!context) return;
    const { job, plan, steps, spec } = context;
    signal.throwIfAborted();
    // A durable ready artifact is the checkpoint across activity retries. Partial bytes are never reused.
    const checkpoint = (
      await this.db.query(
        "SELECT id FROM artifacts WHERE workflow_id=$1 AND kind='generated_project' AND state='ready' AND metadata->>'generation_job_id'=$2 ORDER BY created_at DESC LIMIT 1",
        [job.workflow_id, id],
      )
    ).rows[0];
    let project: Project, artifactId: string;
    if (checkpoint) {
      artifactId = String(checkpoint.id);
      project = validateProject(
        JSON.parse(
          (
            await this.artifacts.read(job.workflow_id, artifactId)
          ).bytes.toString(),
        ),
      );
    } else {
      let seed: Project | null = null;
      if (job.input_version_id) {
        const prior = (
          await this.db.query(
            "SELECT artifact_id FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
            [job.workflow_id, job.input_version_id],
          )
        ).rows[0];
        seed = validateProject(
          JSON.parse(
            (
              await this.artifacts.read(
                job.workflow_id,
                String(prior.artifact_id),
              )
            ).bytes.toString(),
          ),
        );
      }
      await jobs.progress(id, "generating", { total_steps: steps.length });
      const sources = await adapters.generate(context, seed, signal);
      signal.throwIfAborted();
      project = assembleProject(
        spec.board,
        spec.id,
        plan,
        steps,
        sources,
        adapters.model,
      );
      // Recheck cancellation before writing a possibly expensive artifact.
      await jobs.progress(id, "validating", {
        completed_steps: steps.length,
        total_steps: steps.length,
      });
      artifactId = (
        await this.artifacts.create(
          job.workflow_id,
          "generated_project",
          "generated-project.json",
          "application/json",
          Buffer.from(JSON.stringify(project)),
          { generation_job_id: id },
        )
      ).id;
    }
    if (
      project.plan_version_id !== plan.id ||
      project.frozen_spec_id !== spec.id
    )
      throw new DomainError(
        409,
        "PROJECT_CONTEXT_CHANGED",
        "The generated project does not match the pinned implementation plan.",
      );
    // Complete source is inspectable even when its build check fails. A code
    // version is historical evidence, never a correctness or baseline verdict.
    await jobs.publishVersion(id, {
      artifactId,
      entrypoint: project.entrypoint,
      nodeFileMap: project.node_file_map,
      generationKey: "initial",
    });
    await jobs.progress(id, "validating", {
      completed_steps: steps.length,
      total_steps: steps.length,
    });
    let validation: Record<string, unknown>;
    try {
      validation = await adapters.validate(project, signal);
    } catch (error) {
      if (error instanceof DomainError && error.code === "PROJECT_BUILD_FAILED")
        await jobs.progress(id, "validation_failed", {
          syntax_status: "failed",
          diagnostic: error.details,
        });
      throw error;
    }
    signal.throwIfAborted();
    await jobs.progress(id, "validated", {
      ...validation,
      syntax_status: "passed",
    });
    await jobs.finish(id, "succeeded");
  }
}
