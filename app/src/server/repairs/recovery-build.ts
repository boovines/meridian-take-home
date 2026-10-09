import type { Database } from "../database";
import type { Project } from "../../domain/project";
import type { RuntimeError } from "../../domain/runtime";
import { DomainError } from "../../domain/errors";
import { VersionService } from "../engineering/version-service";
import { workflow } from "../workflows/store";
export type RecoveryBuildResult =
  | { ok: true }
  | { ok: false; error: RuntimeError };
export async function checkRecoveryBuild(
  db: Database,
  runId: string,
  validate: (project: Project, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
  versions = new VersionService(db),
): Promise<RecoveryBuildResult> {
  const row = (
    await db.query(
      `SELECT a.id,a.build_result,a.status,r.workflow_id,r.implementation_version_id,j.status AS job_status
    FROM repair_attempts a JOIN workflow_runs r ON r.id=a.rerun_id JOIN workflow_jobs j ON j.id=r.job_id WHERE r.id=$1 AND r.kind='recovery'`,
      [runId],
    )
  ).rows[0];
  if (!row)
    throw new DomainError(404, "NOT_FOUND", "Recovery candidate not found.");
  if (row.build_result) return row.build_result as RecoveryBuildResult;
  if (row.status !== "running" || row.job_status !== "running")
    throw new DomainError(
      409,
      "RECOVERY_INACTIVE",
      "Recovery stopped before its build check.",
    );
  const { project } = await versions.load(
    String(row.workflow_id),
    String(row.implementation_version_id),
  );
  let result: RecoveryBuildResult;
  try {
    await validate(project, signal);
    result = { ok: true };
  } catch (error) {
    signal.throwIfAborted();
    const implementation =
      error instanceof DomainError && error.code === "PROJECT_BUILD_FAILED";
    const details = error instanceof DomainError ? error.details : null;
    const diagnostic =
      implementation &&
      details &&
      typeof details === "object" &&
      "diagnostic" in details &&
      typeof details.diagnostic === "string"
        ? details.diagnostic.slice(0, 2400)
        : "";
    result = {
      ok: false,
      error: {
        code: implementation
          ? "PROJECT_BUILD_FAILED"
          : "BUILD_CHECK_UNAVAILABLE",
        category: implementation ? "implementation" : "infrastructure",
        message: implementation
          ? `The candidate failed syntax validation. ${diagnostic}`
          : "The isolated build check could not finish. Inspect sandbox access before continuing.",
      },
    };
  }
  signal.throwIfAborted();
  return db.transaction(async (tx) => {
    await workflow(tx, String(row.workflow_id), true);
    const saved = (
      await tx.query(
        `UPDATE repair_attempts a SET build_result=$2 FROM repair_sessions s JOIN workflow_jobs j ON j.id=s.job_id
      WHERE a.id=$1 AND a.session_id=s.id AND a.status='running' AND j.status='running' AND a.build_result IS NULL RETURNING a.build_result`,
        [row.id, result],
      )
    ).rows[0];
    if (saved) return saved.build_result as RecoveryBuildResult;
    const existing = (
      await tx.query(
        "SELECT build_result,status FROM repair_attempts WHERE id=$1",
        [row.id],
      )
    ).rows[0];
    if (existing.status === "running" && existing.build_result)
      return existing.build_result as RecoveryBuildResult;
    throw new DomainError(
      409,
      "RECOVERY_INACTIVE",
      "The recovery stopped before its build result could be saved.",
    );
  });
}
