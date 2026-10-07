import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/canvas";
import {
  caseInput,
  type SuiteVersion,
  type EvaluationCase,
  type createSuiteInput,
  type editCaseInput,
  type verifyInput,
} from "../../domain/evaluation";
import type { Database, Queryable } from "../database";
import { workflow, record, expectRevision } from "../workflows/store";
import { frozenSpec } from "../engineering/plan-service";
export async function suiteById(tx: Queryable, wid: string, id: string) {
  const row = (
    await tx.query(
      "SELECT * FROM evaluation_suite_versions WHERE workflow_id=$1 AND id=$2",
      [wid, id],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Evaluation suite not found.");
  return record<SuiteVersion>(row);
}
export async function suiteCases(tx: Queryable, id: string) {
  return (
    await tx.query(
      "SELECT * FROM evaluation_cases WHERE suite_version_id=$1 ORDER BY created_at,id",
      [id],
    )
  ).rows.map((r) => record<EvaluationCase>(r));
}
function draft(suite: SuiteVersion) {
  if (suite.state !== "draft")
    throw new DomainError(
      409,
      "SUITE_LOCKED",
      "Create a suite revision to change verified expectations.",
    );
}
export class SuiteService {
  constructor(private db: Database) {}
  async create(wid: string, data: z.infer<typeof createSuiteInput>) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const spec = await frozenSpec(tx, wid);
      const prior = (
        await tx.query(
          "SELECT * FROM evaluation_suite_versions WHERE workflow_id=$1 AND creation_key=$2",
          [wid, data.request_key],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.parent_suite_version_id !== data.parent_suite_version_id ||
          prior.name !== data.name
        )
          throw new DomainError(
            409,
            "REQUEST_REUSED",
            "This request belongs to a different suite revision.",
          );
        return record<SuiteVersion>(prior);
      }
      if (
        (
          await tx.query(
            "SELECT id FROM evaluation_suite_versions WHERE workflow_id=$1 AND state='draft'",
            [wid],
          )
        ).rows.length
      )
        throw new DomainError(
          409,
          "DRAFT_EXISTS",
          "Finish the existing draft suite first.",
        );
      const parent = data.parent_suite_version_id
        ? await suiteById(tx, wid, data.parent_suite_version_id)
        : null;
      if (parent && parent.state !== "locked")
        throw new DomainError(422, "INVALID_PARENT", "Revise a locked suite.");
      const suite = record<SuiteVersion>(
        (
          await tx.query(
            `INSERT INTO evaluation_suite_versions(workflow_id,frozen_spec_id,version_number,parent_suite_version_id,creation_key,name) VALUES($1,$2,(SELECT coalesce(max(version_number),0)+1 FROM evaluation_suite_versions WHERE workflow_id=$1),$3,$4,$5) RETURNING *`,
            [wid, spec.id, parent?.id || null, data.request_key, data.name],
          )
        ).rows[0],
      );
      if (parent) {
        await tx.query(
          `INSERT INTO evaluation_cases(workflow_id,suite_version_id,case_key,name,kind,node_id,input_bundle_id,input_data,human_responses,assertions) SELECT workflow_id,$2,case_key,name,kind,node_id,input_bundle_id,input_data,human_responses,assertions FROM evaluation_cases WHERE suite_version_id=$1`,
          [parent.id, suite.id],
        );
        // A revised oracle ends active repair; its old results remain immutable.
        await tx.query(
          "UPDATE workflow_jobs SET status='cancel_requested',phase='suite revised',updated_at=now() WHERE workflow_id=$1 AND kind='repair' AND status IN ('queued','running','waiting_for_human')",
          [wid],
        );
      }
      return suite;
    });
  }
  private async validate(
    tx: Queryable,
    wid: string,
    data: z.infer<typeof caseInput>,
  ) {
    if (Buffer.byteLength(JSON.stringify(data)) > 100_000)
      throw new DomainError(
        422,
        "CASE_TOO_LARGE",
        "Keep test definitions under 100 KB; use captured input artifacts for large documents.",
      );
    const spec = await frozenSpec(tx, wid);
    if (data.node_id && !spec.board.nodes.some((n) => n.id === data.node_id))
      throw new DomainError(
        422,
        "INVALID_NODE",
        "The tested step must belong to this frozen process.",
      );
    if (
      data.input_bundle_id &&
      !(
        await tx.query(
          "SELECT id FROM input_bundles WHERE workflow_id=$1 AND id=$2",
          [wid, data.input_bundle_id],
        )
      ).rows.length
    )
      throw new DomainError(
        422,
        "INVALID_INPUT",
        "The captured input must belong to this workflow.",
      );
    for (const response of data.human_responses) {
      const node = spec.board.nodes.find((n) => n.id === response.node_id);
      if (
        !node ||
        response.response.type !==
          (node.type === "human_approval" ? "approval" : "text")
      )
        throw new DomainError(
          422,
          "INVALID_RESPONSE_FIXTURE",
          "Scripted responses must match the frozen node and its response type.",
        );
    }
  }
  async addCase(wid: string, sid: string, raw: z.infer<typeof caseInput>) {
    const data = caseInput.parse(raw);
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      draft(await suiteById(tx, wid, sid));
      await this.validate(tx, wid, data);
      const prior = (
        await tx.query(
          "SELECT * FROM evaluation_cases WHERE suite_version_id=$1 AND case_key=$2",
          [sid, data.case_key],
        )
      ).rows[0];
      if (prior) {
        const comparable = Object.fromEntries(
          Object.keys(data).map((k) => [k, prior[k]]),
        );
        if (!isDeepStrictEqual(comparable, data))
          throw new DomainError(
            409,
            "CASE_EXISTS",
            "This case key already has different content.",
          );
        return record<EvaluationCase>(prior);
      }
      if ((await suiteCases(tx, sid)).length >= 50)
        throw new DomainError(
          422,
          "SUITE_LIMIT",
          "The demo supports up to 50 cases per suite.",
        );
      const row = (
        await tx.query(
          `INSERT INTO evaluation_cases(workflow_id,suite_version_id,case_key,name,kind,node_id,input_bundle_id,input_data,human_responses,assertions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            wid,
            sid,
            data.case_key,
            data.name,
            data.kind,
            data.node_id,
            data.input_bundle_id,
            data.input_data,
            JSON.stringify(data.human_responses),
            JSON.stringify(data.assertions),
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE evaluation_suite_versions SET revision=revision+1,updated_at=now() WHERE id=$1",
        [sid],
      );
      return record<EvaluationCase>(row);
    });
  }
  async editCase(
    wid: string,
    sid: string,
    cid: string,
    data: z.infer<typeof editCaseInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      draft(await suiteById(tx, wid, sid));
      const current = (await suiteCases(tx, sid)).find((c) => c.id === cid);
      if (!current)
        throw new DomainError(
          404,
          "NOT_FOUND",
          "Case not found in this suite.",
        );
      expectRevision(current, data.expected_revision);
      const c = caseInput.parse(data.case);
      if (c.case_key !== current.case_key)
        throw new DomainError(
          422,
          "CASE_KEY_FIXED",
          "A case keeps its identity across edits.",
        );
      await this.validate(tx, wid, c);
      const row = (
        await tx.query(
          `UPDATE evaluation_cases SET name=$2,kind=$3,node_id=$4,input_bundle_id=$5,input_data=$6,human_responses=$7,assertions=$8,verified_at=NULL,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            cid,
            c.name,
            c.kind,
            c.node_id,
            c.input_bundle_id,
            c.input_data,
            JSON.stringify(c.human_responses),
            JSON.stringify(c.assertions),
          ],
        )
      ).rows[0];
      await tx.query(
        "UPDATE evaluation_suite_versions SET revision=revision+1,updated_at=now() WHERE id=$1",
        [sid],
      );
      return record<EvaluationCase>(row);
    });
  }
  async verifyCase(
    wid: string,
    sid: string,
    cid: string,
    data: z.infer<typeof verifyInput>,
  ) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      draft(await suiteById(tx, wid, sid));
      const current = (await suiteCases(tx, sid)).find((c) => c.id === cid);
      if (!current)
        throw new DomainError(
          404,
          "NOT_FOUND",
          "Case not found in this suite.",
        );
      expectRevision(current, data.expected_revision);
      const row = (
        await tx.query(
          "UPDATE evaluation_cases SET verified_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
          [cid],
        )
      ).rows[0];
      await tx.query(
        "UPDATE evaluation_suite_versions SET revision=revision+1,updated_at=now() WHERE id=$1",
        [sid],
      );
      return record<EvaluationCase>(row);
    });
  }
  async lock(wid: string, sid: string, data: z.infer<typeof verifyInput>) {
    return this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      const suite = await suiteById(tx, wid, sid);
      draft(suite);
      expectRevision(suite, data.expected_revision);
      const cases = await suiteCases(tx, sid);
      if (!cases.length || cases.some((c) => !c.verified_at))
        throw new DomainError(
          422,
          "VERIFICATION_REQUIRED",
          "Verify every case's inputs, expectations and assertions before locking the suite.",
        );
      return record<SuiteVersion>(
        (
          await tx.query(
            "UPDATE evaluation_suite_versions SET state='locked',locked_at=now(),revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *",
            [sid],
          )
        ).rows[0],
      );
    });
  }
  async state(wid: string, sid?: string) {
    await workflow(this.db, wid);
    const suites = (
      await this.db.query(
        "SELECT * FROM evaluation_suite_versions WHERE workflow_id=$1 ORDER BY version_number DESC LIMIT 20",
        [wid],
      )
    ).rows.map((r) => record<SuiteVersion>(r));
    const selected = sid ? await suiteById(this.db, wid, sid) : suites[0];
    return {
      suites,
      cases: selected ? await suiteCases(this.db, selected.id) : [],
    };
  }
}
