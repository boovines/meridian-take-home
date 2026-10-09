import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  GROUP_LIMITS,
  selectedEmailExecution,
  validateGrouping,
  answerGroupingQuestion,
} from "../../domain/grouped-execution";
import { bundleInput } from "../../domain/runtime";
import { DomainError } from "../../domain/errors";
import type { WorkflowJob } from "../../domain/engineering";
import type { Database } from "../database";
import { workflow } from "../workflows/store";
import { jobById } from "../engineering/job-service";
import { specForPlan } from "../engineering/plan-service";
import { runById } from "../runtime/store";
import { RunService } from "../runtime/run-service";
import { BundleService } from "../runtime/bundle-service";
import { activeGroupParent } from "./ownership";
import { sourcesForCapture, childManifest } from "./sources";
export class GroupedExecutionService {
  constructor(private db: Database) {}
  async start(wid: string, raw: z.infer<typeof selectedEmailExecution>) {
    const data = selectedEmailExecution.parse(raw),
      source = {
        implementation_version_id: data.implementation_version_id,
        message_ids: data.message_ids,
      };
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const prior = (
        await tx.query(
          "SELECT * FROM workflow_jobs WHERE workflow_id=$1 AND request_key=$2",
          [wid, data.request_key],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.kind !== "grouped" ||
          !isDeepStrictEqual(prior.source_request, source)
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request identifies another selected-email operation.",
          );
        return prior as unknown as WorkflowJob;
      }
      const version = (
        await tx.query(
          "SELECT v.* FROM implementation_versions v JOIN implementation_plan_versions p ON p.id=v.plan_version_id WHERE v.workflow_id=$1 AND v.id=$2 AND p.state='approved'",
          [wid, data.implementation_version_id],
        )
      ).rows[0];
      if (!version)
        throw new DomainError(
          422,
          "INVALID_VERSION",
          "Generate code from an approved plan before running selected emails.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM workflow_jobs WHERE workflow_id=$1 AND parent_job_id IS NULL AND status IN ('queued','running','waiting_for_human','cancel_requested')",
            [wid],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "OPERATION_ACTIVE",
          "Wait for or cancel the active workflow operation first.",
        );
      const id = randomUUID();
      const job = (
        await tx.query(
          "INSERT INTO workflow_jobs(id,workflow_id,kind,request_key,source_request,plan_version_id,input_version_id,executor_ref,deadline_at) VALUES($1,$2,'grouped',$3,$4,$5,$6,$7,now()+interval '1 day') RETURNING *",
          [
            id,
            wid,
            data.request_key,
            source,
            version.plan_version_id,
            version.id,
            `job-${id}`,
          ],
        )
      ).rows[0] as unknown as WorkflowJob;
      await tx.query(
        "INSERT INTO grouped_executions(job_id,workflow_id,limits) VALUES($1,$2,$3)",
        [id, wid, GROUP_LIMITS],
      );
      return job;
    });
  }
  async attachCapture(jobId: string, bundleId: string) {
    return this.db.transaction(async (tx) => {
      const job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      await activeGroupParent(tx, job.id, job.workflow_id, job.plan_version_id);
      const parent = (
        await tx.query("SELECT * FROM grouped_executions WHERE job_id=$1", [
          jobId,
        ])
      ).rows[0];
      if (parent.input_bundle_id) return String(parent.input_bundle_id);
      const bundle = (
        await tx.query(
          "SELECT manifest FROM input_bundles WHERE workflow_id=$1 AND id=$2",
          [job.workflow_id, bundleId],
        )
      ).rows[0];
      if (!bundle)
        throw new DomainError(
          422,
          "INVALID_CAPTURE",
          "Capture must belong to this workflow.",
        );
      const manifest = bundleInput.shape.manifest.parse(bundle.manifest);
      if (
        !isDeepStrictEqual(
          [...manifest.message_ids].sort(),
          [...(job.source_request.message_ids as string[])].sort(),
        )
      )
        throw new DomainError(
          422,
          "SELECTION_CHANGED",
          "Capture must contain exactly the selected email identities.",
        );
      sourcesForCapture(manifest);
      await tx.query(
        "UPDATE grouped_executions SET input_bundle_id=$2 WHERE job_id=$1",
        [jobId, bundleId],
      );
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='grouping selected sources',started_at=coalesce(started_at,now()),updated_at=now() WHERE id=$1",
        [jobId],
      );
      return bundleId;
    });
  }
  async answerQuestion(
    wid: string,
    questionId: string,
    raw: z.infer<typeof answerGroupingQuestion>,
  ) {
    const data = answerGroupingQuestion.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const question = (
        await tx.query(
          "SELECT * FROM grouping_questions WHERE workflow_id=$1 AND id=$2",
          [wid, questionId],
        )
      ).rows[0];
      if (!question)
        throw new DomainError(404, "NOT_FOUND", "Grouping question not found.");
      if (question.status === "answered") {
        if (
          question.answer_key === data.request_key &&
          question.answer === data.answer
        )
          return question;
        throw new DomainError(
          409,
          "ALREADY_ANSWERED",
          "This question already has an immutable response.",
        );
      }
      const job = await jobById(tx, String(question.parent_job_id));
      await activeGroupParent(tx, job.id, wid, job.plan_version_id);
      if (question.status !== "open")
        throw new DomainError(
          409,
          "QUESTION_CLOSED",
          "This clarification no longer accepts an answer.",
        );
      return (
        await tx.query(
          "UPDATE grouping_questions SET status='answered',answer=$2,answer_key=$3,answered_at=now() WHERE id=$1 RETURNING *",
          [questionId, data.answer, data.request_key],
        )
      ).rows[0];
    });
  }
  async startGrouping(jobId: string, requestKey: string) {
    return this.db.transaction(async (tx) => {
      const job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      await activeGroupParent(tx, job.id, job.workflow_id, job.plan_version_id);
      const latest = (
        await tx.query(
          "SELECT * FROM grouping_decisions WHERE parent_job_id=$1 ORDER BY sequence DESC LIMIT 1",
          [jobId],
        )
      ).rows[0];
      const sequence = latest ? Number(latest.sequence) : 0;
      // The round, not a transport retry key, identifies a grouping invocation.
      const prior = (
        await tx.query(
          "SELECT j.*,r.id AS run_id FROM workflow_jobs j JOIN workflow_runs r ON r.job_id=j.id AND r.kind='manual' WHERE j.parent_job_id=$1 AND r.execution_mode='grouping' AND j.source_request->>'phase_sequence'=$2",
          [jobId, String(sequence)],
        )
      ).rows[0];
      if (prior)
        return {
          job: await jobById(tx, String(prior.id)),
          run: await runById(tx, String(prior.run_id)),
        };
      const capture = (
        await tx.query(
          "SELECT b.* FROM grouped_executions g JOIN input_bundles b ON b.id=g.input_bundle_id WHERE g.job_id=$1",
          [jobId],
        )
      ).rows[0];
      if (!capture)
        throw new DomainError(
          422,
          "CAPTURE_REQUIRED",
          "Capture selected email sources before grouping.",
        );
      let bundleId = String(capture.id);
      if (latest) {
        const questions = (
          await tx.query(
            "SELECT * FROM grouping_questions WHERE decision_id=$1 ORDER BY source_id",
            [latest.id],
          )
        ).rows;
        if (!questions.length)
          throw new DomainError(
            409,
            "GROUPING_COMPLETE",
            "This decision has no unresolved sources to regroup.",
          );
        if (questions.some((q) => q.status !== "answered"))
          throw new DomainError(
            409,
            "CLARIFICATION_PENDING",
            "Answer the current grouping questions before regrouping.",
          );
        if (sequence > GROUP_LIMITS.clarification_rounds)
          throw new DomainError(
            422,
            "GROUPING_LIMIT",
            "The grouping clarification allowance is exhausted.",
          );
        const manifest = bundleInput.shape.manifest.parse(capture.manifest);
        const answers = (
          await tx.query(
            "SELECT source_id,scope,question,answer,decision_id FROM grouping_questions WHERE parent_job_id=$1 AND status='answered' ORDER BY created_at,id",
            [jobId],
          )
        ).rows;
        manifest.input = {
          ...(manifest.input as Record<
            string,
            z.infer<typeof bundleInput>["manifest"]["input"]
          >),
          grouping_clarification: { previous_decision: latest.result, answers },
        } as z.infer<typeof bundleInput>["manifest"]["input"];
        const next = await new BundleService(this.db).createInTransaction(
          tx,
          job.workflow_id,
          {
            source_kind: capture.source_kind as "gmail" | "fixture",
            shipment_reference: null,
            manifest,
          },
        );
        bundleId = String(next.id);
      }
      const spec = await specForPlan(tx, job.workflow_id, job.plan_version_id);
      const triggers = spec.board.nodes.filter((n) => n.type === "trigger");
      if (triggers.length !== 1)
        throw new DomainError(
          422,
          "INVALID_TRIGGER",
          "Grouping requires exactly one approved trigger.",
        );
      return new RunService(this.db).startInTransaction(
        tx,
        job.workflow_id,
        {
          request_key: requestKey,
          implementation_version_id: job.input_version_id!,
          input_bundle_id: bundleId,
          rerun_of_id: null,
        },
        {
          parent_job_id: jobId,
          execution_mode: "grouping",
          phase_node_id: triggers[0].id,
          phase_sequence: sequence,
        },
      );
    });
  }
  async publishGrouping(jobId: string, runId: string) {
    return this.db.transaction(async (tx) => {
      const job = await jobById(tx, jobId);
      await workflow(tx, job.workflow_id, true);
      await activeGroupParent(tx, job.id, job.workflow_id, job.plan_version_id);
      const prior = (
        await tx.query(
          "SELECT * FROM grouping_decisions WHERE parent_job_id=$1 AND source_run_id=$2",
          [jobId, runId],
        )
      ).rows[0];
      if (prior) return prior;
      const result = (
        await tx.query(
          "SELECT s.output_data FROM workflow_runs r JOIN workflow_jobs j ON j.id=r.job_id JOIN step_executions s ON s.id=r.result_step_id WHERE r.id=$1 AND r.status='completed' AND r.execution_mode='grouping' AND j.parent_job_id=$2",
          [runId, jobId],
        )
      ).rows[0];
      if (!result)
        throw new DomainError(
          422,
          "GROUPING_NOT_COMPLETE",
          "Grouping must finish in an approved, traced execution before publication.",
        );
      const captured = (
        await tx.query(
          "SELECT b.manifest,b.source_kind FROM grouped_executions g JOIN input_bundles b ON b.id=g.input_bundle_id WHERE g.job_id=$1",
          [jobId],
        )
      ).rows[0];
      const manifest = bundleInput.shape.manifest.parse(captured?.manifest),
        decision = validateGrouping(
          result.output_data,
          sourcesForCapture(manifest),
        );
      const sequence =
        Number(
          (
            await tx.query(
              "SELECT count(*) AS n FROM grouping_decisions WHERE parent_job_id=$1",
              [jobId],
            )
          ).rows[0].n,
        ) + 1;
      if (sequence > GROUP_LIMITS.clarification_rounds + 1)
        throw new DomainError(
          422,
          "GROUPING_LIMIT",
          "The grouping clarification allowance is exhausted.",
        );
      const row = (
        await tx.query(
          "INSERT INTO grouping_decisions(workflow_id,parent_job_id,sequence,source_run_id,result) VALUES($1,$2,$3,$4,$5) RETURNING *",
          [job.workflow_id, jobId, sequence, runId, decision],
        )
      ).rows[0];
      // Each new decision is retained; unchanged child inputs are reused by the
      // orchestration layer instead of rerunning successful groups.
      for (const assignment of decision.assignments)
        if (assignment.unresolved)
          await tx.query(
            "INSERT INTO grouping_questions(workflow_id,parent_job_id,decision_id,source_id,scope,question) VALUES($1,$2,$3,$4,$5,$6)",
            [
              job.workflow_id,
              jobId,
              row.id,
              assignment.source_id,
              assignment.unresolved.scope,
              assignment.unresolved.question,
            ],
          );
      for (const group of decision.groups) {
        const previous = (
          await tx.query(
            "SELECT * FROM grouped_children WHERE parent_job_id=$1 AND group_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
            [jobId, group.key],
          )
        ).rows[0];
        const nextManifest = childManifest(
          manifest,
          decision,
          group.key,
          String(row.id),
        );
        if (previous) {
          const oldManifest = (
            await tx.query("SELECT manifest FROM input_bundles WHERE id=$1", [
              previous.input_bundle_id,
            ])
          ).rows[0].manifest as typeof nextManifest;
          const semantic = (m: typeof nextManifest) => {
            const copy = structuredClone(m);
            delete (copy.input as { execution_group: Record<string, unknown> })
              .execution_group.decision_id;
            return copy;
          };
          if (isDeepStrictEqual(semantic(oldManifest), semantic(nextManifest)))
            continue;
        }
        const bundle = await new BundleService(this.db).createInTransaction(
          tx,
          job.workflow_id,
          {
            source_kind: captured.source_kind as "gmail" | "fixture",
            shipment_reference: null,
            manifest: nextManifest,
          },
        );
        const child = await new RunService(this.db).startInTransaction(
          tx,
          job.workflow_id,
          {
            request_key: randomUUID(),
            implementation_version_id: job.input_version_id!,
            input_bundle_id: String(bundle.id),
            rerun_of_id: null,
          },
          { parent_job_id: jobId },
        );
        await tx.query(
          "INSERT INTO grouped_children(workflow_id,parent_job_id,decision_id,group_key,label,input_bundle_id,job_id,supersedes_child_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [
            job.workflow_id,
            jobId,
            row.id,
            group.key,
            group.label,
            bundle.id,
            child.job.id,
            previous?.id ?? null,
          ],
        );
      }
      return row;
    });
  }
}
