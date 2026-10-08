import type { z } from "zod";
import { DomainError } from "../../domain/errors";
import type { PlanStep } from "../../domain/engineering";
import type { Project } from "../../domain/project";
import type { repairSources } from "../../domain/repair";

// A human node's public module is a host-owned gate. Its editable response
// handler, when present, is the implementation the repair model can change.
export function implementationPath(project: Project, nodeId: string) {
  const humanPath = `human/${nodeId}.mjs`;
  return Object.hasOwn(project.files, humanPath)
    ? humanPath
    : project.node_file_map[nodeId];
}

export function completeRepairSources(
  baseline: Project,
  steps: PlanStep[],
  repair: z.infer<typeof repairSources>,
) {
  const patch = repair.project;
  if (patch.status !== "ready") return patch;
  const allowed = new Set(steps.map((s) => s.node_id));
  const affected = new Set(repair.diagnosis.affected_node_ids);
  const replacements = new Map(patch.steps.map((s) => [s.node_id, s]));
  if (
    !patch.steps.length ||
    replacements.size !== patch.steps.length ||
    [...affected].some((id) => !allowed.has(id)) ||
    patch.steps.some((s) => !allowed.has(s.node_id) || !affected.has(s.node_id))
  )
    throw new DomainError(
      422,
      "INVALID_REPAIR_PATCH",
      "Repair must name each replacement step once, within the approved plan and diagnosed scope.",
    );
  return {
    ...patch,
    steps: steps.map((step) => {
      const replacement = replacements.get(step.node_id);
      if (replacement) return replacement;
      const source = baseline.files[implementationPath(baseline, step.node_id)];
      if (source === undefined)
        throw new DomainError(
          422,
          "INVALID_REPAIR_BASELINE",
          "The retained baseline is missing an approved step implementation.",
        );
      return { node_id: step.node_id, source_lines: source.split("\n") };
    }),
  };
}
