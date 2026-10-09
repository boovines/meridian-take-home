import { z } from "zod";
import {
  GROUP_LIMITS,
  type GroupingResult,
  type GroupingSource,
} from "../../domain/grouped-execution";
import { DomainError } from "../../domain/errors";
import { uuid } from "../../domain/validation";
import { bundleInput } from "../../domain/runtime";
const message = z
  .object({ id: z.string(), source_artifact_id: uuid })
  .passthrough();
const document = z
  .object({ artifact_id: uuid, message_id: z.string() })
  .passthrough();
export const capturedInput = z
  .object({ messages: z.array(message), documents: z.array(document) })
  .passthrough();
export function sourcesForCapture(
  manifest: z.infer<typeof bundleInput>["manifest"],
): GroupingSource[] {
  const input = capturedInput.parse(manifest.input);
  const sources: GroupingSource[] = [
    ...input.messages.map((m) => ({
      id: `message:${m.id}`,
      kind: "message" as const,
      message_id: m.id,
      artifact_id: m.source_artifact_id,
    })),
    ...input.documents.map((d) => ({
      id: `document:${d.artifact_id}`,
      kind: "document" as const,
      message_id: d.message_id,
      artifact_id: d.artifact_id,
    })),
  ];
  if (
    sources.length !== manifest.artifacts.length ||
    sources.length > GROUP_LIMITS.sources ||
    new Set(sources.map((s) => s.id)).size !== sources.length ||
    new Set(sources.map((s) => s.artifact_id)).size !== sources.length ||
    input.messages.length !== manifest.message_ids.length
  )
    throw new DomainError(
      422,
      "INVALID_CAPTURE",
      "Capture must contain unique, bounded source identities.",
    );
  if (
    new Set(input.messages.map((m) => m.id)).size !==
      manifest.message_ids.length ||
    manifest.message_ids.some(
      (id) => !input.messages.some((m) => m.id === id),
    ) ||
    sources.some(
      (s) =>
        !manifest.artifacts.some(
          (a) =>
            a.artifact_id === s.artifact_id && a.message_id === s.message_id,
        ),
    ) ||
    sources.some((s) => !manifest.message_ids.includes(s.message_id))
  )
    throw new DomainError(
      422,
      "INVALID_CAPTURE",
      "Every captured source must retain its selected email and artifact provenance.",
    );
  return sources;
}
export function childManifest(
  manifest: z.infer<typeof bundleInput>["manifest"],
  decision: GroupingResult,
  groupKey: string,
  decisionId: string,
) {
  const sources = sourcesForCapture(manifest),
    input = capturedInput.parse(manifest.input),
    group = decision.groups.find((g) => g.key === groupKey);
  if (!group)
    throw new DomainError(
      422,
      "UNKNOWN_GROUP",
      "Choose a group from the persisted decision.",
    );
  const assigned = decision.assignments.filter((a) =>
    a.targets.some((t) => t.group_key === groupKey),
  );
  const selected = sources.filter((s) =>
    assigned.some((a) => a.source_id === s.id),
  );
  const artifactIds = new Set(selected.map((s) => s.artifact_id));
  return bundleInput.shape.manifest.parse({
    input: {
      messages: input.messages.filter((m) =>
        artifactIds.has(m.source_artifact_id),
      ),
      documents: input.documents.filter((d) => artifactIds.has(d.artifact_id)),
      execution_group: {
        key: group.key,
        label: group.label,
        context: group.context,
        decision_id: decisionId,
        source_scopes: assigned.map((a) => ({
          source_id: a.source_id,
          ...a.targets.find((t) => t.group_key === groupKey)!,
        })),
      },
    },
    message_ids: [...new Set(selected.map((s) => s.message_id))],
    artifacts: manifest.artifacts.filter((a) => artifactIds.has(a.artifact_id)),
  });
}
