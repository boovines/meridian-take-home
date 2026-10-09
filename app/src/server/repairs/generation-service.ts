import { ClarificationService } from "./clarification-service";
import {
  recoverySources,
  clarificationProposal,
} from "../../domain/clarification";
import { isDeepStrictEqual } from "node:util";
import { RepairStepReplay, type ReplayStep } from "./replay";
import { invokeInSandbox } from "../integrations/sandbox-step";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import { repairSources } from "../../domain/repair";
import { assertRepairEvidenceIntegrity } from "../../domain/repair-integrity";
import type { Project } from "../../domain/project";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { assembleProject, validateProject } from "../engineering/project";
import { VersionService } from "../engineering/version-service";
import { RepairService, attemptById } from "./service";
import { changedStepSources, type PreviousSourceEvidence } from "./evidence";
import { completeRepairSources } from "./patch";
import { RepairDocumentReader, type ReadRepairDocument } from "./documents";
import { RepairAuditReader, type ReadRepairAudit } from "./audit";
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
    const clarification = new ClarificationService(this.db);
    const pending = await clarification.questionForAttempt(attemptId);
    if (pending?.status === "open") return attemptById(this.db, attemptId);
    const claimed = await repairs.claimGeneration(attemptId);
    if (!claimed.token) return claimed.attempt;
    const context = await repairs.generationContext(attemptId, claimed.token);
    signal.throwIfAborted();
    const versions = new VersionService(this.db, this.artifacts);
    const { project: baseline } = await versions.load(
      claimed.job.workflow_id,
      claimed.attempt.baseline_version_id,
    );
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
      );
      const audits = new RepairAuditReader(
        claimed.job.workflow_id,
        new Set(
          [
            ...context.audit_events,
            ...context.baseline_repetitions.flatMap((run) => run.audit_events),
            ...context.previous_attempts.flatMap(
              (a) => a.candidate_audit_events,
            ),
          ].map((e) => String(e.id)),
        ),
        new ExecutionAuditService(this.db, this.artifacts),
        signal,
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
      const generated = (
        context.session.origin === "run" ? recoverySources : repairSources
      ).parse(
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
      if ("clarification" in generated && generated.clarification) {
        if (
          generated.project.status !== "needs_attention" ||
          generated.project.steps.length
        )
          throw new DomainError(
            422,
            "INVALID_CLARIFICATION",
            "A question must pause generation without proposing executable changes.",
          );
        await clarification.ask(
          attemptId,
          claimed.token,
          clarificationProposal.parse(generated.clarification),
          diagnosis,
        );
        return attemptById(this.db, attemptId);
      }
      if (
        "clarification_context" in context &&
        context.clarification_context?.clarifications.length &&
        generated.project.status === "ready"
      ) {
        const assessment =
          "clarification_assessment" in generated
            ? recoverySources.shape.clarification_assessment.parse(
                generated.clarification_assessment,
              )
            : null;
        if (
          !assessment ||
          assessment.disposition !== "clarifies_existing_rules"
        )
          throw new DomainError(
            422,
            assessment?.disposition === "requires_process_change"
              ? "PROCESS_CHANGE_REQUIRED"
              : "CLARIFICATION_UNVERIFIED",
            assessment?.reason ||
              "Compare the answer with the frozen requirements before continuing.",
          );
        const currentIds = new Set(
          context.input_inventory.flatMap((b) =>
            b.documents.map((d) => String(d.artifact_id)),
          ),
        );
        const required = context.clarification_context.clarifications
          .flatMap((c) => c.source_artifact_ids)
          .filter((id) => currentIds.has(id));
        if (
          required.some(
            (id) => !documents.inspected.some((d) => d.artifact_id === id),
          ) ||
          (currentIds.size
            ? !documents.inspected.length
            : !audits.inspected.length)
        )
          throw new DomainError(
            422,
            "CLARIFICATION_EVIDENCE_REQUIRED",
            "Inspect the relevant captured source again after the engineer answer. An answer cannot replace documentary evidence.",
          );
      }
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
            clarification_context_id:
              "clarification_context" in context
                ? (context.clarification_context?.id ?? null)
                : null,
            diagnosis,
            clarification_assessment:
              "clarification_assessment" in generated
                ? generated.clarification_assessment
                : null,
            inspected_documents: documents.inspected,
            inspected_audits: audits.inspected,
          },
        )
      ).id;
    }
    // Check both fresh and restored artifacts before publishing any runnable version.
    // Rejected source remains immutable diagnostic evidence, never acceptance evidence.
    assertRepairEvidenceIntegrity(
      project.files,
      baseline.files,
      context.spec.board,
      context,
    );
    // A new version id is not a new candidate if its executable files are identical.
    // Keep the generated artifact for diagnosis, but never buy another lucky sequence.
    if (
      context.session.origin === "run" &&
      isDeepStrictEqual(baseline.files, project.files)
    )
      throw new DomainError(
        409,
        "UNCHANGED_REPAIR_CANDIDATE",
        "The proposed repair did not change the implementation. Inspect the saved diagnosis before spending on another run.",
      );
    for (const previous of context.previous_attempts.filter(
      (a) => a.candidate_version_id,
    )) {
      const prior = await new VersionService(this.db, this.artifacts).load(
        claimed.job.workflow_id,
        String(previous.candidate_version_id),
      );
      if (isDeepStrictEqual(prior.project.files, project.files))
        throw new DomainError(
          409,
          "UNCHANGED_REPAIR_CANDIDATE",
          "The repair reproduced an already evaluated candidate. Its artifact is retained; change the implementation before starting another confirmation sequence.",
        );
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
