import { zipSync, strToU8 } from "fflate";
import { DomainError } from "../../domain/errors";
import type { ImplementationVersion } from "../../domain/engineering";
import type { Database } from "../database";
import { ArtifactService } from "../artifacts/service";
import { validateProject } from "./project";
export class VersionService {
  constructor(
    private db: Database,
    private artifacts = new ArtifactService(db),
  ) {}
  async load(workflowId: string, versionId: string) {
    const version = (
      await this.db.query(
        "SELECT * FROM implementation_versions WHERE workflow_id=$1 AND id=$2",
        [workflowId, versionId],
      )
    ).rows[0] as unknown as ImplementationVersion;
    if (!version)
      throw new DomainError(404, "NOT_FOUND", "Generated version not found.");
    const project = validateProject(
      JSON.parse(
        (
          await this.artifacts.read(workflowId, version.artifact_id)
        ).bytes.toString(),
      ),
    );
    return { version, project };
  }
  async inspect(workflowId: string, versionId: string) {
    const current = await this.load(workflowId, versionId);
    const parent = current.version.parent_version_id
      ? await this.load(workflowId, current.version.parent_version_id)
      : null;
    const paths = new Set([
      ...Object.keys(current.project.files),
      ...Object.keys(parent?.project.files || {}),
    ]);
    const changes = [...paths].sort().map((path) => ({
      path,
      status: !(path in current.project.files)
        ? "removed"
        : !(path in (parent?.project.files || {}))
          ? "added"
          : current.project.files[path] === parent!.project.files[path]
            ? "unchanged"
            : "modified",
      before: parent?.project.files[path] ?? null,
    }));
    const evaluation =
      (
        await this.db.query(
          "SELECT e.id,e.status,e.verdict,e.failure_code,s.version_number AS suite_number FROM evaluation_runs e JOIN evaluation_suite_versions s ON s.id=e.suite_version_id WHERE e.workflow_id=$1 AND e.implementation_version_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1",
          [workflowId, versionId],
        )
      ).rows[0] || null;
    // An in-flight rerun must not erase build evidence for immutable source.
    const buildEvidence = (
      await this.db.query(
        "SELECT build_check_status,failure_code FROM evaluation_runs WHERE workflow_id=$1 AND implementation_version_id=$2 AND (build_check_status IS NOT NULL OR failure_code='PROJECT_BUILD_FAILED') ORDER BY CASE WHEN failure_code='PROJECT_BUILD_FAILED' THEN finished_at ELSE build_checked_at END DESC,id DESC LIMIT 1",
        [workflowId, versionId],
      )
    ).rows[0];
    const build_check_status = !buildEvidence
      ? null
      : buildEvidence.failure_code === "PROJECT_BUILD_FAILED"
        ? "failed"
        : buildEvidence.build_check_status as "passed" | "failed";
    return { ...current, changes, evaluation, build_check_status };
  }
  async download(workflowId: string, versionId: string) {
    const { project, version } = await this.load(workflowId, versionId);
    const zipped = zipSync(
      Object.fromEntries(
        Object.entries(project.files).map(([name, source]) => [
          name,
          strToU8(source),
        ]),
      ),
    );
    return new Response(zipped as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="meridian-agent-v${version.version_number}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  }
}
