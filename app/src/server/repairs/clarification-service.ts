import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  answerClarification,
  clarificationProposal,
  type EngineerQuestion,
  type ClarificationContext,
} from "../../domain/clarification";
import { DomainError } from "../../domain/errors";
import type { Database, Queryable } from "../database";
import { workflow } from "../workflows/store";
import { pauseRecoveryClock } from "./recovery-clock";

// The generation claim and its immutable context snapshot share a transaction.
export async function snapshotClarifications(
  tx: Queryable,
  attemptId: string,
  token: string,
) {
  const row = (
    await tx.query(
      `SELECT a.invocation_count,s.workflow_id,s.input_bundle_id,p.frozen_spec_id FROM repair_attempts a
    JOIN repair_sessions s ON s.id=a.session_id JOIN implementation_plan_versions p ON p.id=s.plan_version_id WHERE a.id=$1`,
      [attemptId],
    )
  ).rows[0];
  const rows = (
    await tx.query(
      `SELECT q.id AS question_id,q.question,q.answer,q.source_artifact_ids,q.audit_event_ids,
      CASE WHEN c.id IS NOT NULL THEN 'workflow' ELSE 'captured_input' END AS scope
    FROM engineer_questions q JOIN repair_sessions s ON s.id=q.session_id
    JOIN implementation_plan_versions p ON p.id=s.plan_version_id
    LEFT JOIN workflow_clarifications c ON c.question_id=q.id
    WHERE q.workflow_id=$1 AND q.status='answered' AND p.frozen_spec_id=$2
      AND (s.input_bundle_id=$3 OR c.id IS NOT NULL) ORDER BY q.answered_at,q.id LIMIT 51`,
      [row.workflow_id, row.frozen_spec_id, row.input_bundle_id],
    )
  ).rows;
  if (rows.length > 50)
    throw new DomainError(
      422,
      "CLARIFICATION_CONTEXT_LIMIT",
      "Review the accumulated clarifications before adding more recovery context.",
    );
  await tx.query(
    `INSERT INTO repair_clarification_contexts(attempt_id,invocation_number,attempt_token,clarifications) VALUES($1,$2,$3,$4)`,
    [attemptId, row.invocation_count, token, JSON.stringify(rows)],
  );
}
export async function clarificationSnapshot(
  tx: Queryable,
  attemptId: string,
  token?: string,
): Promise<{ id: string; clarifications: ClarificationContext[] } | null> {
  const row = (
    await tx.query(
      `SELECT id,clarifications FROM repair_clarification_contexts WHERE attempt_id=$1 ${token ? "AND attempt_token=$2" : ""} ORDER BY invocation_number DESC LIMIT 1`,
      token ? [attemptId, token] : [attemptId],
    )
  ).rows[0];
  return row
    ? {
        id: String(row.id),
        clarifications: row.clarifications as ClarificationContext[],
      }
    : null;
}
export class ClarificationService {
  constructor(private db: Database) {}
  async questionForAttempt(attemptId: string) {
    return (
      await this.db.query(
        "SELECT * FROM engineer_questions WHERE attempt_id=$1",
        [attemptId],
      )
    ).rows[0] as unknown as EngineerQuestion | undefined;
  }
  async ask(
    attemptId: string,
    token: string,
    raw: z.infer<typeof clarificationProposal>,
    diagnosis: unknown,
  ) {
    const proposal = clarificationProposal.parse(raw);
    return this.db.transaction(async (tx) => {
      const old = (
        await tx.query("SELECT workflow_id FROM repair_attempts WHERE id=$1", [
          attemptId,
        ])
      ).rows[0];
      if (!old)
        throw new DomainError(404, "NOT_FOUND", "Repair attempt not found.");
      await workflow(tx, String(old.workflow_id), true);
      const row = (
        await tx.query(
          `SELECT a.*,s.job_id,s.origin,s.status AS session_status,s.input_bundle_id,p.frozen_spec_id,j.status AS job_status,j.deadline_at,f.graph
        FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id JOIN workflow_jobs j ON j.id=s.job_id
        JOIN implementation_plan_versions p ON p.id=s.plan_version_id JOIN frozen_specs f ON f.id=p.frozen_spec_id WHERE a.id=$1`,
          [attemptId],
        )
      ).rows[0];
      const existing = (
        await tx.query("SELECT * FROM engineer_questions WHERE attempt_id=$1", [
          attemptId,
        ])
      ).rows[0];
      if (existing) {
        if (
          existing.status === "open" &&
          row.job_status === "waiting_for_human" &&
          row.attempt_token === token &&
          [
            "question",
            "why_needed",
            "node_ids",
            "source_artifact_ids",
            "audit_event_ids",
          ].every((k) =>
            isDeepStrictEqual(
              existing[k],
              proposal[k as keyof typeof proposal],
            ),
          )
        )
          return existing;
        throw new DomainError(
          409,
          "CLARIFICATION_LIMIT",
          "This candidate already used its clarification. Inspect its answer and evidence before starting another run.",
        );
      }
      if (
        row.origin !== "run" ||
        row.session_status !== "running" ||
        row.job_status !== "running" ||
        row.status !== "running" ||
        row.candidate_version_id ||
        row.attempt_token !== token
      )
        throw new DomainError(
          409,
          "REPAIR_INACTIVE",
          "This recovery no longer accepts a question.",
        );
      if (
        Number(row.invocation_count) >= 2 ||
        new Date(String(row.deadline_at)).getTime() <= Date.now()
      )
        throw new DomainError(
          422,
          "CLARIFICATION_LIMIT",
          "The generation or active-time allowance cannot support another continuation.",
        );
      const nodes = (row.graph as { nodes: { id: string }[] }).nodes;
      if (proposal.node_ids.some((id) => !nodes.some((n) => n.id === id)))
        throw new DomainError(
          422,
          "INVALID_QUESTION_SCOPE",
          "Question references a block outside the frozen workflow.",
        );
      const inventory = (
        await tx.query("SELECT manifest FROM input_bundles WHERE id=$1", [
          row.input_bundle_id,
        ])
      ).rows[0].manifest as { artifacts: { artifact_id: string }[] };
      if (
        proposal.source_artifact_ids.some(
          (id) => !inventory.artifacts.some((a) => a.artifact_id === id),
        )
      )
        throw new DomainError(
          422,
          "INVALID_QUESTION_SCOPE",
          "Question references a document outside the captured input.",
        );
      for (const id of proposal.audit_event_ids) {
        const audit = (
          await tx.query(
            `SELECT e.id FROM execution_audit_events e JOIN step_executions x ON x.id=e.step_execution_id JOIN workflow_runs r ON r.id=x.run_id
          JOIN repair_sessions s ON s.id=$2 WHERE e.id=$1 AND r.workflow_id=s.workflow_id AND (r.id=s.source_run_id OR r.job_id=s.job_id)`,
            [id, row.session_id],
          )
        ).rows[0];
        if (!audit)
          throw new DomainError(
            422,
            "INVALID_QUESTION_SCOPE",
            "Question references audit evidence outside this recovery.",
          );
      }
      const q = (
        await tx.query(
          `INSERT INTO engineer_questions(workflow_id,session_id,attempt_id,question,why_needed,node_ids,source_artifact_ids,audit_event_ids)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            row.workflow_id,
            row.session_id,
            attemptId,
            proposal.question,
            proposal.why_needed,
            proposal.node_ids,
            proposal.source_artifact_ids,
            proposal.audit_event_ids,
          ],
        )
      ).rows[0];
      await tx.query("UPDATE repair_attempts SET diagnosis=$2 WHERE id=$1", [
        attemptId,
        diagnosis,
      ]);
      await pauseRecoveryClock(tx, String(row.job_id), true);
      await tx.query(
        "UPDATE workflow_jobs SET status='waiting_for_human',phase='waiting for engineer clarification',updated_at=now() WHERE id=$1",
        [row.job_id],
      );
      return q;
    });
  }
  async answer(
    workflowId: string,
    questionId: string,
    raw: z.infer<typeof answerClarification>,
  ) {
    const input = answerClarification.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const q = (
        await tx.query(
          `SELECT q.*,s.status AS session_status,s.job_id,p.frozen_spec_id,j.status AS job_status
        FROM engineer_questions q JOIN repair_sessions s ON s.id=q.session_id JOIN implementation_plan_versions p ON p.id=s.plan_version_id
        JOIN workflow_jobs j ON j.id=s.job_id WHERE q.id=$1 AND q.workflow_id=$2`,
          [questionId, workflowId],
        )
      ).rows[0];
      if (!q)
        throw new DomainError(404, "NOT_FOUND", "Engineer question not found.");
      if (q.status === "answered" && q.answer_key === input.request_key) {
        if (q.answer !== input.answer || q.reuse !== input.reuse)
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This response key belongs to a different answer.",
          );
        return { question_id: questionId, job_id: String(q.job_id) };
      }
      if (
        q.status !== "open" ||
        q.session_status !== "running" ||
        q.job_status !== "waiting_for_human"
      )
        throw new DomainError(
          409,
          "QUESTION_INACTIVE",
          "This question is closed or recovery has stopped. Your unsent answer is preserved.",
        );
      if (
        (
          await tx.query(
            "SELECT id FROM engineer_questions WHERE workflow_id=$1 AND answer_key=$2",
            [workflowId, input.request_key],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "REQUEST_REUSED",
          "This response key belongs to another question.",
        );
      await tx.query(
        "UPDATE engineer_questions SET status='answered',answer=$2,reuse=$3,answer_key=$4,answered_at=now() WHERE id=$1",
        [questionId, input.answer, input.reuse, input.request_key],
      );
      if (input.reuse)
        await tx.query(
          "INSERT INTO workflow_clarifications(workflow_id,frozen_spec_id,question_id) VALUES($1,$2,$3)",
          [workflowId, q.frozen_spec_id, questionId],
        );
      await pauseRecoveryClock(tx, String(q.job_id), false);
      await tx.query(
        "UPDATE workflow_jobs SET status='running',phase='reinspecting evidence after engineer answer',updated_at=now() WHERE id=$1",
        [q.job_id],
      );
      return { question_id: questionId, job_id: String(q.job_id) };
    });
  }
}
