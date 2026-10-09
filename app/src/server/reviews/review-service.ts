import { carryScopingQuestions } from "../scoping/review-obligations";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { Board } from "../../domain/canvas";
import {
  reviewerOutput,
  detailPatch,
  type ReviewRun,
  type DiscussionThread,
  type DiscussionMessage,
  type ThreadAnchor,
  type ReviewState,
  type ReviewerOutput,
  type reviewStart,
  type goalAnswer,
} from "../../domain/review";
import type { Database, Queryable } from "../database";
import { workflow, editable, readBoard } from "../workflows/store";
import {
  reviewRecord,
  appendMessage,
  terminateReview,
  threadById,
} from "./discussion-store";

const activeStatuses = ["queued", "running", "awaiting_customer"];
export const reviewerVersion = "process-review-v3";
export const reviewModel = () =>
  process.env.MERIDIAN_REVIEW_PROVIDER === "fixture" &&
  process.env.MERIDIAN_DATABASE === "local" &&
  process.env.MERIDIAN_LOCAL_DEMO === "true"
    ? "fixture-reviewer"
    : process.env.OPENAI_REVIEW_MODEL || "gpt-5.4-mini";
export const reviewSettings = {
  maxOutputTokens: 7000,
  reasoningEffort: "low",
  maxRetries: 1,
};
function semantic(board: Board) {
  return {
    goal: board.workflow.desired_outcome,
    nodes: board.nodes.map(
      ({
        id,
        type,
        title,
        instructions,
        config,
        split_mode,
        join_for_split_id,
      }) => ({
        id,
        type,
        title,
        instructions,
        config,
        split_mode,
        join_for_split_id,
      }),
    ),
    connections: board.connections.map(
      ({ id, source_node_id, target_node_id, condition_text, is_default }) => ({
        id,
        source_node_id,
        target_node_id,
        condition_text,
        is_default,
      }),
    ),
  };
}
async function reviewById(tx: Queryable, id: string): Promise<ReviewRun> {
  const row = (await tx.query("SELECT * FROM review_runs WHERE id=$1", [id]))
    .rows[0];
  if (!row) throw new DomainError(404, "NOT_FOUND", "Review not found.");
  return reviewRecord(row);
}
async function assertActive(tx: Queryable, run: ReviewRun) {
  const w = await workflow(tx, run.workflow_id, true);
  const pointer = (
    await tx.query("SELECT active_review_run_id FROM workflows WHERE id=$1", [
      w.id,
    ])
  ).rows[0].active_review_run_id;
  if (
    w.state !== "reviewing" ||
    pointer !== run.id ||
    !activeStatuses.includes(run.status)
  )
    throw new DomainError(
      409,
      "REVIEW_INACTIVE",
      "This review has already ended.",
    );
  if (run.deadline_at && new Date(run.deadline_at).getTime() < Date.now())
    throw new DomainError(
      409,
      "REVIEW_EXPIRED",
      "The review exceeded its time limit.",
    );
  return w;
}
export class ReviewService {
  constructor(private db: Database) {}
  async state(id: string): Promise<ReviewState> {
    return this.db.transaction(async (tx) => {
      await workflow(tx, id, true);
      const expired = (
        await tx.query(
          "SELECT * FROM review_runs WHERE workflow_id=$1 AND status IN ('queued','running') AND deadline_at<now()",
          [id],
        )
      ).rows;
      for (const row of expired)
        await terminateReview(
          tx,
          reviewRecord(row),
          "failed",
          "TIME_LIMIT",
          "Review stopped after five minutes without a result. You can start a new review.",
        );
      return this.readState(tx, id);
    });
  }
  private async readState(tx: Queryable, id: string): Promise<ReviewState> {
    const runs = (
      await tx.query(
        "SELECT id,workflow_id,process_version,status,phase,started_content_revision,analyzed_content_revision,model,model_settings,reviewer_version,error_message,deadline_at,created_at,finished_at FROM review_runs WHERE workflow_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20",
        [id],
      )
    ).rows.map((r) => reviewRecord<ReviewRun>(r));
    const threads = (
      await tx.query(
        "SELECT t.*,to_jsonb(r)||jsonb_build_object('source_version_number',f.version_number) AS engineer_request FROM discussion_threads t LEFT JOIN engineer_change_requests r ON r.thread_id=t.id LEFT JOIN frozen_specs f ON f.id=r.source_frozen_spec_id WHERE t.workflow_id=$1 ORDER BY t.created_at,t.id",
        [id],
      )
    ).rows.map((r) => reviewRecord<DiscussionThread>(r));
    const messages = (
      await tx.query(
        "SELECT * FROM discussion_messages WHERE workflow_id=$1 ORDER BY thread_id,message_number",
        [id],
      )
    ).rows.map((r) => reviewRecord<DiscussionMessage>(r));
    const anchors = (
      await tx.query(
        "SELECT * FROM thread_anchors WHERE workflow_id=$1 ORDER BY created_at,id",
        [id],
      )
    ).rows as unknown as ThreadAnchor[];
    return { runs, threads, messages, anchors };
  }
  async start(
    id: string,
    data: z.infer<typeof reviewStart>,
  ): Promise<ReviewRun> {
    return this.db.transaction(async (tx) => {
      const w = await workflow(tx, id, true);
      const old = (
        await tx.query(
          "SELECT * FROM review_runs WHERE workflow_id=$1 AND request_key=$2",
          [id, data.request_key],
        )
      ).rows[0];
      if (old) return reviewRecord(old);
      editable(w);
      const board = await readBoard(tx, id),
        needsGoal = !w.desired_outcome.trim();
      const run = reviewRecord<ReviewRun>(
        (
          await tx.query(
            `INSERT INTO review_runs(workflow_id,request_key,status,phase,started_content_revision,initial_snapshot,model,model_settings,reviewer_version,deadline_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $10 THEN NULL ELSE now()+interval '5 minutes' END) RETURNING *`,
            [
              id,
              data.request_key,
              needsGoal ? "awaiting_customer" : "queued",
              needsGoal ? "clarification" : "analysis",
              w.content_revision,
              board,
              reviewModel(),
              reviewSettings,
              reviewerVersion,
              needsGoal,
            ],
          )
        ).rows[0],
      );
      await tx.query(
        "UPDATE workflows SET state='reviewing',active_review_run_id=$2,updated_at=now() WHERE id=$1",
        [id, run.id],
      );
      if (needsGoal) {
        const thread = reviewRecord<DiscussionThread>(
          (
            await tx.query(
              "INSERT INTO discussion_threads(workflow_id,kind,title,scope,origin_review_run_id) VALUES($1,'clarification','What should this workflow accomplish?','workflow',$2) RETURNING *",
              [id, run.id],
            )
          ).rows[0],
        );
        await appendMessage(tx, thread, {
          author: "ai",
          body: "Describe the outcome this workflow should achieve. I will use it to assess missing steps and steps that may be unnecessary.",
          requestKey: `goal:${run.id}`,
          reviewId: run.id,
        });
      }
      return run;
    });
  }
  async answerGoal(id: string, data: z.infer<typeof goalAnswer>) {
    return this.db.transaction(async (tx) => {
      let run = await reviewById(tx, id);
      await workflow(tx, run.workflow_id, true);
      run = await reviewById(tx, id);
      const row = (
        await tx.query(
          "SELECT * FROM discussion_threads WHERE origin_review_run_id=$1 AND kind='clarification' FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          409,
          "NO_CLARIFICATION",
          "This review is not waiting for an outcome.",
        );
      const thread = reviewRecord<DiscussionThread>(row);
      if (
        (
          await tx.query(
            "SELECT id FROM discussion_messages WHERE thread_id=$1 AND request_key=$2",
            [thread.id, data.request_key],
          )
        ).rows.length
      )
        return run;
      await assertActive(tx, run);
      if (run.status !== "awaiting_customer")
        throw new DomainError(
          409,
          "NOT_WAITING",
          "The outcome has already been confirmed.",
        );
      await appendMessage(tx, thread, {
        author: "customer",
        body: data.desired_outcome,
        requestKey: data.request_key,
        event: {
          action: "goal_confirmed",
          desired_outcome: data.desired_outcome,
        },
      });
      await tx.query(
        "UPDATE workflows SET desired_outcome=$2,revision=revision+1,content_revision=content_revision+1,updated_at=now() WHERE id=$1",
        [run.workflow_id, data.desired_outcome],
      );
      await tx.query(
        "UPDATE review_runs SET status='queued',phase='analysis',deadline_at=now()+interval '5 minutes' WHERE id=$1",
        [id],
      );
      return reviewById(tx, id);
    });
  }
  async prepare(id: string) {
    return this.db.transaction(async (tx) => {
      let run = await reviewById(tx, id);
      await workflow(tx, run.workflow_id, true);
      run = await reviewById(tx, id);
      if (run.status === "completed") return null;
      const w = await assertActive(tx, run);
      if (run.status === "awaiting_customer") return null;
      const snapshot =
        run.analyzed_snapshot || (await readBoard(tx, run.workflow_id));
      if (!snapshot.workflow.desired_outcome.trim())
        throw new DomainError(
          409,
          "MISSING_GOAL",
          "Confirm the desired outcome first.",
        );
      await tx.query(
        "UPDATE review_runs SET status='running',started_at=coalesce(started_at,now()),analyzed_snapshot=$2,analyzed_content_revision=$3 WHERE id=$1",
        [id, snapshot, run.analyzed_content_revision ?? w.content_revision],
      );
      run = await reviewById(tx, id);
      await carryScopingQuestions(tx, run, snapshot);
      return {
        run,
        board: snapshot,
        discussion: await this.readState(tx, run.workflow_id),
      };
    });
  }
  async finish(id: string, status: "cancelled" | "failed", message?: string) {
    return this.db.transaction(async (tx) => {
      let run = await reviewById(tx, id);
      await workflow(tx, run.workflow_id, true);
      run = await reviewById(tx, id);
      if (!activeStatuses.includes(run.status)) return run;
      await terminateReview(
        tx,
        run,
        status,
        status === "failed" ? "REVIEW_FAILED" : undefined,
        message,
      );
      return reviewById(tx, id);
    });
  }
  async publish(id: string, untrusted: unknown) {
    const result = reviewerOutput.parse(untrusted);
    return this.db.transaction(async (tx) => {
      let run = await reviewById(tx, id);
      await workflow(tx, run.workflow_id, true);
      run = await reviewById(tx, id);
      if (run.status === "completed") return run;
      const w = await assertActive(tx, run);
      if (
        !run.analyzed_snapshot ||
        run.analyzed_content_revision !== w.content_revision
      )
        throw new DomainError(
          409,
          "STALE_REVIEW",
          "The analyzed draft is no longer current.",
        );
      const board = run.analyzed_snapshot;
      await carryScopingQuestions(tx, run, board);
      for (let i = 0; i < result.findings.length; i++)
        await this.publishFinding(tx, run, board, result.findings[i], i);
      await terminateReview(tx, run, "completed");
      return reviewById(tx, id);
    });
  }
  private async publishFinding(
    tx: Queryable,
    run: ReviewRun,
    board: Board,
    f: ReviewerOutput["findings"][number],
    index: number,
  ) {
    const nodeIds = [...new Set(f.node_ids)],
      connectionIds = [...new Set(f.connection_ids)];
    if (
      nodeIds.some((id) => !board.nodes.some((n) => n.id === id)) ||
      connectionIds.some((id) => !board.connections.some((c) => c.id === id))
    )
      throw new DomainError(
        422,
        "INVALID_AI_ANCHOR",
        "Review referenced a block or connection outside its input.",
      );
    let thread: DiscussionThread;
    if (f.action === "followup") {
      if (!f.existing_thread_id)
        throw new DomainError(
          422,
          "INVALID_FOLLOWUP",
          "A follow-up needs an existing finding.",
        );
      thread = await threadById(tx, run.workflow_id, f.existing_thread_id);
      if (
        thread.kind !== "finding" ||
        thread.status !== "open" ||
        thread.process_version !== run.process_version
      )
        throw new DomainError(
          422,
          "CLOSED_FINDING",
          "AI cannot reopen or follow up on a closed finding.",
        );
      const anchors = (
        await tx.query(
          "SELECT node_id,connection_id FROM thread_anchors WHERE thread_id=$1",
          [thread.id],
        )
      ).rows;
      if (
        nodeIds.some((id) => !anchors.some((a) => a.node_id === id)) ||
        connectionIds.some((id) => !anchors.some((a) => a.connection_id === id))
      )
        throw new DomainError(
          422,
          "INVALID_FOLLOWUP",
          "A follow-up must keep its original targets; create a separate finding for another concern.",
        );
    } else {
      if (f.existing_thread_id)
        throw new DomainError(
          422,
          "INVALID_FINDING",
          "A new finding cannot overwrite an existing thread.",
        );
      if (f.previous_finding_id) {
        const previous = await threadById(
          tx,
          run.workflow_id,
          f.previous_finding_id,
        );
        if (
          previous.kind !== "finding" ||
          previous.status !== "closed" ||
          !previous.origin_review_run_id
        )
          throw new DomainError(
            422,
            "INVALID_PREVIOUS",
            "A changed concern must refer to a previous closed finding.",
          );
        const previousRun = await reviewById(tx, previous.origin_review_run_id);
        if (
          previousRun.analyzed_snapshot &&
          isDeepStrictEqual(
            semantic(previousRun.analyzed_snapshot),
            semantic(board),
          )
        )
          throw new DomainError(
            422,
            "UNCHANGED_CONCERN",
            "A closed concern cannot be raised again without changed process content.",
          );
      }
      thread = reviewRecord(
        (
          await tx.query(
            `INSERT INTO discussion_threads(id,workflow_id,kind,title,scope,origin_review_run_id,finding_category,previous_finding_id)
        VALUES($1,$2,'finding',$3,$4,$5,$6,$7) RETURNING *`,
            [
              randomUUID(),
              run.workflow_id,
              f.title,
              nodeIds.length || connectionIds.length ? "elements" : "workflow",
              run.id,
              f.category,
              f.previous_finding_id,
            ],
          )
        ).rows[0],
      );
      for (const nodeId of nodeIds)
        await tx.query(
          "INSERT INTO thread_anchors(workflow_id,thread_id,node_id,context_snapshot) VALUES($1,$2,$3,$4)",
          [
            run.workflow_id,
            thread.id,
            nodeId,
            board.nodes.find((n) => n.id === nodeId),
          ],
        );
      for (const connectionId of connectionIds)
        await tx.query(
          "INSERT INTO thread_anchors(workflow_id,thread_id,connection_id,context_snapshot) VALUES($1,$2,$3,$4)",
          [
            run.workflow_id,
            thread.id,
            connectionId,
            board.connections.find((c) => c.id === connectionId),
          ],
        );
    }
    if (f.proposal) {
      if (f.change_kind !== "detail")
        throw new DomainError(
          422,
          "INVALID_AI_EDIT",
          "Graph changes require manual editing.",
        );
      const n = board.nodes.find((n) => n.id === f.proposal!.node_id);
      if (!n || !nodeIds.includes(n.id))
        throw new DomainError(
          422,
          "INVALID_AI_EDIT",
          "The proposed edit must target an anchored block.",
        );
      const patch = detailPatch.parse({
        ...(f.proposal.title !== null ? { title: f.proposal.title } : {}),
        ...(f.proposal.instructions !== null
          ? { instructions: f.proposal.instructions }
          : {}),
      });
      await tx.query(
        "UPDATE discussion_threads SET proposed_node_id=$2,proposed_node_revision=$3,proposed_patch=$4 WHERE id=$1",
        [thread.id, n.id, n.revision, patch],
      );
    } else if (f.action === "followup")
      await tx.query(
        "UPDATE discussion_threads SET proposed_node_id=NULL,proposed_node_revision=NULL,proposed_patch=NULL WHERE id=$1",
        [thread.id],
      );
    await appendMessage(tx, thread, {
      author: "ai",
      body: f.message,
      requestKey: `review:${run.id}:${index}`,
      reviewId: run.id,
    });
  }
}
