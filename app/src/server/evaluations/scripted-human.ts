import type { Database } from "../database";
import { workflow } from "../workflows/store";
import { runById, finishedRuns } from "../runtime/store";
import { jobById } from "../engineering/job-service";
import { scriptedResponse } from "../../domain/evaluation";
export async function answerScriptedHuman(
  db: Database,
  runId: string,
  id: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return db.transaction(async (tx) => {
    let run = await runById(tx, runId);
    await workflow(tx, run.workflow_id, true);
    run = await runById(tx, runId);
    const job = await jobById(tx, run.job_id);
    if (
      run.kind !== "evaluation" ||
      finishedRuns.includes(run.status) ||
      job.status !== "running"
    )
      return {
        ok: false,
        message: "The evaluation run cannot accept a scripted response.",
      };
    const row = (
      await tx.query(
        `SELECT h.*,s.node_id,s.node_visit_number FROM human_requests h JOIN step_executions s ON s.id=h.step_execution_id WHERE h.id=$1 AND h.run_id=$2`,
        [id, runId],
      )
    ).rows[0];
    if (!row)
      return {
        ok: false,
        message: "The human request does not belong to this test execution.",
      };
    if (row.status === "answered")
      return row.response_source === "fixture"
        ? { ok: true }
        : {
            ok: false,
            message: "This evaluation has an unexpected interactive response.",
          };
    const c = (
      await tx.query(
        `SELECT c.human_responses FROM workflow_runs wr JOIN evaluation_case_results r ON r.id=wr.evaluation_case_result_id JOIN evaluation_cases c ON c.id=r.case_id JOIN evaluation_suite_versions s ON s.id=c.suite_version_id WHERE wr.id=$1 AND s.state='locked'`,
        [runId],
      )
    ).rows[0];
    const responses = scriptedResponse.array().parse(c?.human_responses || []);
    const response = responses.find(
      (r) =>
        r.node_id === row.node_id &&
        r.node_visit_number === Number(row.node_visit_number),
    )?.response;
    if (!response || response.type !== row.response_type)
      return {
        ok: false,
        message: `The locked case has no ${row.response_type} response for visit ${row.node_visit_number} to this step.`,
      };
    await tx.query(
      "UPDATE human_requests SET status='answered',response=$2,response_source='fixture',response_request_key=id,answered_at=now(),delivered_at=now() WHERE id=$1 AND status='pending'",
      [id, response],
    );
    return { ok: true };
  });
}
