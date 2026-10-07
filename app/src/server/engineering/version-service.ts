import { zipSync, strToU8 } from "fflate";
import { DomainError } from "../../domain/canvas";
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
    const changes = [...paths]
      .sort()
      .map((path) => ({
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
    return { ...current, changes };
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
