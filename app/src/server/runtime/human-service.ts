import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import { answerInput, type HumanRequest } from "../../domain/runtime";
import type { Database } from "../database";
import { workflow } from "../workflows/store";
import { assertJobParentActive } from "../grouped-execution/ownership";
import { jobById } from "../engineering/job-service";
import { runById, finishedRuns } from "./store";
export class HumanService {
  constructor(private db: Database) {}
  async answer(
    workflowId: string,
    id: string,
    raw: z.infer<typeof answerInput>,
  ) {
    const data = answerInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, workflowId, true);
      const row = (
        await tx.query(
          "SELECT * FROM human_requests WHERE workflow_id=$1 AND id=$2",
          [workflowId, id],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(404, "NOT_FOUND", "Human request not found.");
      if (row.status === "answered") {
        if (
          row.response_request_key === data.request_key &&
          isDeepStrictEqual(row.response, data.response)
        )
          return row as unknown as HumanRequest;
        throw new DomainError(
          409,
          "ALREADY_ANSWERED",
          "This visit already has its response.",
        );
      }
      const run = await runById(tx, String(row.run_id)),
        job = await jobById(tx, run.job_id);
      await assertJobParentActive(tx, job);
      if (run.kind === "evaluation")
        throw new DomainError(
          422,
          "SCRIPTED_RESPONSE_REQUIRED",
          "Evaluations use responses from their locked case, not interactive answers.",
        );
      if (
        row.status !== "pending" ||
        finishedRuns.includes(run.status) ||
        !["running", "waiting_for_human"].includes(job.status)
      )
        throw new DomainError(
          409,
          "REQUEST_CLOSED",
          "This run can no longer accept a response.",
        );
      if (data.response.type !== row.response_type)
        throw new DomainError(
          422,
          "RESPONSE_TYPE",
          "Provide the kind of response this step requires.",
        );
      // The answered row is also a durable signal-delivery intent. No separate queue/lease.
      return (
        await tx.query(
          "UPDATE human_requests SET status='answered',response=$2,response_source='human',response_request_key=$3,answered_at=now() WHERE id=$1 RETURNING *",
          [id, data.response, data.request_key],
        )
      ).rows[0] as unknown as HumanRequest;
    });
  }
  async response(id: string) {
    const row = (
      await this.db.query("SELECT * FROM human_requests WHERE id=$1", [id])
    ).rows[0];
    if (!row)
      throw new DomainError(404, "NOT_FOUND", "Human request not found.");
    return row as unknown as HumanRequest;
  }
}
