import { z } from "zod";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DomainError } from "../../domain/errors";
import { assertRepairEvidenceIntegrity } from "../../domain/repair-integrity";
import { grade } from "../../domain/grading";
import { counterexampleInput, applyCounterexample } from "../../domain/repair-counterexample";
import type { Project } from "../../domain/project";
import { selectRoutes, type Json } from "../../domain/runtime";
import type { Database, Queryable } from "../database";
import { ArtifactService } from "../artifacts/service";
import { workflow } from "../workflows/store";
import {
  invokeApprovedStep,
  invocationFailure,
  type StepAdapters,
} from "../runtime/invoke-step";
import { repairIntegrityEvidence } from "./evidence";
import { implementationPath } from "./patch";
import type { RepairContext } from "./generation-service";

export const replayInput = z
  .object({
    recorded_input_id: z.uuid(),
    counterexample: counterexampleInput.nullable().optional(),
    candidate_patch: z
      .object({
        node_id: z.uuid(),
        source_lines: z.array(z.string().max(10000)).min(1).max(2000),
      })
      .strict(),
  })
  .strict();
export type ReplayStep = (
  input: z.infer<typeof replayInput>,
) => Promise<unknown>;
export class RepairStepReplay {
  constructor(
    private db: Database,
    private context: RepairContext,
    private baseline: Project,
    private token: string,
    private signal: AbortSignal,
    private invoke: StepAdapters["invoke"],
    private artifacts = new ArtifactService(db),
  ) {}
  private async active(tx: Queryable) {
    const a = (
      await tx.query(
        "SELECT a.status,a.attempt_token,s.status AS session_status,j.status AS job_status,j.deadline_at FROM repair_attempts a JOIN repair_sessions s ON s.id=a.session_id JOIN workflow_jobs j ON j.id=s.job_id WHERE a.id=$1",
        [this.context.attempt.id],
      )
    ).rows[0];
    if (
      !a ||
      a.status !== "running" ||
      a.attempt_token !== this.token ||
      a.session_status !== "running" ||
      a.job_status !== "running" ||
      new Date(String(a.deadline_at)).getTime() <= Date.now()
    )
      throw new DomainError(
        409,
        "STALE_REPLAY",
        "This repair invocation no longer owns replay work.",
      );
  }
  run: ReplayStep = async (raw) => {
    this.signal.throwIfAborted();
    const input = replayInput.parse(raw),
      c = this.context,
      wid = c.session.workflow_id;
    const trace = [
      ...c.traces,
      ...c.previous_attempts.flatMap((a) => a.candidate_traces),
    ].find((t) => t.occurrence_id === input.recorded_input_id);
    const isolated = c.results.find(
      (r) =>
        r.id === input.recorded_input_id &&
        c.cases.some((k) => k.id === r.case_id && k.kind === "step"),
    );
    if (!trace && !isolated)
      throw new DomainError(
        422,
        "REPLAY_INPUT_DENIED",
        "Use a recorded occurrence or isolated case result supplied in this repair context.",
      );
    const caseDefinition = isolated
      ? c.cases.find((k) => k.id === isolated.case_id)!
      : null;
    const nodeId = String(trace?.node_id || caseDefinition?.node_id);
    if (
      nodeId !== input.candidate_patch.node_id ||
      !c.steps.some((s) => s.node_id === nodeId && s.selected_method === "code")
    )
      throw new DomainError(
        422,
        "REPLAY_PATCH_DENIED",
        "Replay can replace only its recorded, approved Code step.",
      );
    let executionContext: Record<string, Json>, recordedOutput: Json | null;
    if (trace) {
      const row = (
        await this.db.query(
          "SELECT s.input_step_refs,s.output_data,s.run_id,b.manifest FROM step_executions s JOIN workflow_runs r ON r.id=s.run_id JOIN input_bundles b ON b.id=r.input_bundle_id WHERE s.workflow_id=$1 AND s.id=$2",
          [wid, input.recorded_input_id],
        )
      ).rows[0];
      if (!row)
        throw new DomainError(
          422,
          "REPLAY_INPUT_DENIED",
          "Recorded input no longer exists.",
        );
      const refs = row.input_step_refs as Record<string, string>,
        steps: Record<string, Json> = {};
      const outputs = (
        await this.db.query(
          "SELECT id,node_id,output_data FROM step_executions WHERE run_id=$1 AND id=ANY($2::uuid[]) AND status='completed'",
          [row.run_id, Object.values(refs)],
        )
      ).rows;
      if (outputs.length !== Object.keys(refs).length)
        throw new DomainError(
          422,
          "REPLAY_INPUT_DENIED",
          "Recorded predecessors are incomplete.",
        );
      for (const out of outputs)
        steps[String(out.node_id)] = out.output_data as Json;
      executionContext = {
        input: (row.manifest as { input: Json }).input,
        steps,
      };
      recordedOutput = row.output_data as Json;
    } else {
      executionContext = structuredClone(caseDefinition!.input_data!) as Record<
        string,
        Json
      >;
      if (caseDefinition!.input_bundle_id) {
        const b = (
          await this.db.query(
            "SELECT manifest FROM input_bundles WHERE workflow_id=$1 AND id=$2",
            [wid, caseDefinition!.input_bundle_id],
          )
        ).rows[0];
        executionContext.input = (b.manifest as { input: Json }).input;
      }
      recordedOutput = isolated!.actual_output;
    }
    const recordedInputHash = createHash("sha256").update(JSON.stringify(executionContext)).digest("hex");
    if (input.counterexample) executionContext = applyCounterexample(executionContext, input.counterexample);
    const project: Project = {
      ...this.baseline,
      files: {
        ...this.baseline.files,
        [implementationPath(this.baseline, nodeId)]:
          input.candidate_patch.source_lines.join("\n"),
      },
    };
    const requestBytes = Buffer.from(
      JSON.stringify({
        baseline_version_id: c.attempt.baseline_version_id,
        recorded_input_id: input.recorded_input_id,
        node_id: nodeId,
        context: executionContext,
        candidate_patch: input.candidate_patch,
        counterexample: input.counterexample ?? null,
        recorded_input_sha256: recordedInputHash,
      }),
    );
    if (requestBytes.length > 2_000_000)
      throw new DomainError(
        422,
        "REPLAY_INPUT_TOO_LARGE",
        "Recorded input and patch exceed the replay limit.",
      );
    const replay = await this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      await this.active(tx);
      this.signal.throwIfAborted();
      const n =
        Number(
          (
            await tx.query(
              "SELECT count(*) AS n FROM repair_replays WHERE attempt_id=$1",
              [c.attempt.id],
            )
          ).rows[0].n,
        ) + 1;
      if (n > 3)
        throw new DomainError(
          422,
          "REPLAY_LIMIT",
          "At most three diagnostic replays are available per repair attempt.",
        );
      return (
        await tx.query(
          "INSERT INTO repair_replays(workflow_id,attempt_id,call_number,attempt_token,step_execution_id,case_result_id,node_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
          [
            wid,
            c.attempt.id,
            n,
            this.token,
            trace ? input.recorded_input_id : null,
            isolated ? input.recorded_input_id : null,
            nodeId,
          ],
        )
      ).rows[0];
    });
    const requestArtifact = await this.artifacts.create(
      wid,
      "trace",
      "replay-input.json",
      "application/json",
      requestBytes,
      { repair_attempt_id: c.attempt.id, replay_id: replay.id },
    );
    await this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      await this.active(tx);
      await tx.query(
        "UPDATE repair_replays SET request_artifact_id=$2 WHERE id=$1",
        [replay.id, requestArtifact.id],
      );
    });
    let report: Record<string, Json>;
    try {
      // Retain the attempted patch and diagnostic rejection without buying a sandbox.
      assertRepairEvidenceIntegrity(
        project.files, this.baseline.files, c.spec.board, [repairIntegrityEvidence(c), executionContext],
      );
      const result = await invokeApprovedStep(
        project,
        nodeId,
        "code",
        executionContext,
        {
          invoke: this.invoke,
          reason: async () => {
            throw new Error("Reasoning is unavailable in deterministic replay");
          },
        },
        this.signal,
      );
      // Match runtime and isolated evaluations before presenting trusted checks.
      const routes = selectRoutes(
        c.spec.board.nodes.find((node) => node.id === nodeId)!,
        c.spec.board.connections.filter((edge) => edge.source_node_id === nodeId),
        result.matching_connection_ids,
      ).map((edge) => edge.id);
      report = {
        status: "completed",
        selected_connection_ids: routes,
        actual_output: result.output,
        changed_from_recording: input.counterexample ? null : !isDeepStrictEqual(
          recordedOutput,
          result.output,
        ),
        recorded_output: recordedOutput,
        hypothesis_checks: input.counterexample ? JSON.parse(JSON.stringify(grade(result.output,
          input.counterexample.expectations.map((item,index)=>({...item,key:`hypothesis-${index+1}`,label:`Model hypothesis ${index+1}`,operator:"equals" as const})),
        ))) : [],
        checks: caseDefinition && !input.counterexample
          ? JSON.parse(
              JSON.stringify(grade(result.output, caseDefinition.assertions)),
            )
          : [],
        assertions_scope: input.counterexample
          ? "model-authored hypothesis only; modified input is not a trusted case"
          : caseDefinition
          ? "same isolated case only"
          : "none; workflow totals do not grade an intermediate step",
      };
    } catch (e) {
      if (this.signal.aborted) throw e;
      report = {
        status: "error",
        error: JSON.parse(JSON.stringify(invocationFailure(e))),
      };
    }
    this.signal.throwIfAborted();
    const evidence = {
      ...report,
      replay_id: String(replay.id),
      recorded_input_id: input.recorded_input_id,
      node_id: nodeId,
      input_sha256: createHash("sha256")
        .update(JSON.stringify(executionContext))
        .digest("hex"),
      patch_sha256: createHash("sha256")
        .update(input.candidate_patch.source_lines.join("\n"))
        .digest("hex"),
      diagnostic_only: true,
      input_modified: !!input.counterexample,
      recorded_input_sha256: recordedInputHash,
      hypothesis_rationale: input.counterexample?.rationale ?? null,
    };
    const resultArtifact = await this.artifacts.create(
      wid,
      "trace",
      "replay-result.json",
      "application/json",
      Buffer.from(JSON.stringify(evidence)),
      { repair_attempt_id: c.attempt.id, replay_id: replay.id },
    );
    await this.db.transaction(async (tx) => {
      await workflow(tx, wid, true);
      await this.active(tx);
      this.signal.throwIfAborted();
      await tx.query(
        "UPDATE repair_replays SET result_artifact_id=$2,status='completed',finished_at=now(),summary=$3 WHERE id=$1",
        [
          replay.id,
          resultArtifact.id,
          { status: report.status, node_id: nodeId, diagnostic_only: true, input_modified: !!input.counterexample },
        ],
      );
    });
    const text = JSON.stringify(evidence);
    return text.length <= 48000
      ? evidence
      : {
          replay_id: replay.id,
          diagnostic_only: true,
          input_modified: !!input.counterexample,
          assertions_scope: report.assertions_scope ?? null,
          hypothesis_checks_summary: Array.isArray(report.hypothesis_checks)
            ? report.hypothesis_checks.map(check => {
              const value = check as Record<string, Json>;
              return { key: value.key, passed: value.passed, missing: value.missing };
            }) : [],
          truncated: true,
          json_preview: text.slice(0, 48000),
          result_artifact_id: resultArtifact.id,
        };
  };
}
