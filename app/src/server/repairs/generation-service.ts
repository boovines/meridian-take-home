import { isDeepStrictEqual } from "node:util";
import { RepairStepReplay, type ReplayStep } from "./replay";
import { invokeInSandbox } from "../integrations/sandbox-step";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import { repairSources } from "../../domain/repair";
import type { Project } from "../../domain/project";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { assembleProject, validateProject } from "../engineering/project";
import { VersionService } from "../engineering/version-service";
import { RepairService } from "./service";
import { changedStepSources, type PreviousSourceEvidence } from "./evidence";
import { completeRepairSources } from "./patch";
import { repairDocumentBudget, RepairDocumentReader, type ReadRepairDocument } from "./documents";
import { repairAuditBudget, RepairAuditReader, type ReadRepairAudit } from "./audit";
import { ExecutionAuditService } from "../runtime/audit-service";
export type RepairContext = Awaited<
  ReturnType<RepairService["generationContext"]>
>;
export interface RepairGenerator {
  model: string;
  generate(
    context: RepairContext,
    baseline: Project,
    signal: AbortSignal,
    previousSources: PreviousSourceEvidence[],
    readDocument: ReadRepairDocument,
    readAudit: ReadRepairAudit,
    replayStep: ReplayStep,
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
      const versions = new VersionService(this.db, this.artifacts);
      const { project: baseline } = await versions.load(
        claimed.job.workflow_id,
        claimed.attempt.baseline_version_id,
      );
      const previousSources = await Promise.all(
        context.previous_attempts
          .filter((prior) => prior.candidate_version_id)
          .slice(-1)
          .map(async (prior) => {
            const { project: candidate } = await versions.load(
              claimed.job.workflow_id,
              String(prior.candidate_version_id),
            );
            return {
              attempt_number: Number(prior.attempt_number),
              candidate_version_id: String(prior.candidate_version_id),
              changed_steps: changedStepSources(candidate, baseline),
            };
          }),
      );
      signal.throwIfAborted();
      const documents = new RepairDocumentReader(
        claimed.job.workflow_id,
        new Set(
          context.input_inventory.flatMap((bundle) =>
            bundle.documents.map((d) => String(d.artifact_id)),
          ),
        ),
        this.artifacts,
        signal,
        repairDocumentBudget(this.db, attemptId, claimed.token),
      );
      const audits = new RepairAuditReader(
        claimed.job.workflow_id,
        new Set(
          [
            ...context.audit_events,
            ...context.previous_attempts.flatMap(
              (a) => a.candidate_audit_events,
            ),
          ].map((e) => String(e.id)),
        ),
        new ExecutionAuditService(this.db, this.artifacts),
        signal,
        repairAuditBudget(this.db, attemptId, claimed.token),
      );
      const replay = new RepairStepReplay(
        this.db,
        context,
        baseline,
        claimed.token,
        signal,
        invokeInSandbox,
        this.artifacts,
      );
      const generated = repairSources.parse(
        await adapter.generate(
          context,
          baseline,
          signal,
          previousSources,
          documents.read,
          audits.read,
          replay.run,
        ),
      );
      signal.throwIfAborted();
      diagnosis = generated.diagnosis;
      project = assembleProject(
        context.spec.board,
        context.spec.id,
        context.plan,
        context.steps,
        completeRepairSources(baseline, context.steps, generated),
        adapter.model,
      );
      artifactId = (
        await this.artifacts.create(
          claimed.job.workflow_id,
          "generated_project",
          "repair-project.json",
          "application/json",
          Buffer.from(JSON.stringify(project)),
          {
            repair_attempt_id: attemptId,
            diagnosis,
            inspected_documents: documents.inspected,
            inspected_audits: audits.inspected,
          },
        )
      ).id;
    }
    // A new version id is not a new candidate if its executable files are identical.
    // Keep the generated artifact for diagnosis, but never buy another lucky sequence.
    for (const previous of context.previous_attempts.filter(a => a.session_id === context.session.id && a.candidate_version_id)) {
      const prior = await new VersionService(this.db, this.artifacts).load(claimed.job.workflow_id, String(previous.candidate_version_id));
      if (isDeepStrictEqual(prior.project.files, project.files))
        throw new DomainError(409, "UNCHANGED_REPAIR_CANDIDATE", "The repair reproduced an already evaluated candidate. Its artifact is retained; change the implementation before starting another confirmation sequence.");
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
