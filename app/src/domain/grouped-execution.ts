import { z } from "zod";
import { DomainError } from "./errors";
import { uuid } from "./validation";

export const GROUP_LIMITS = {
  messages: 10,
  groups: 20,
  sources: 100,
  concurrent_children: 2,
  active_ms: 3_600_000,
  spend_usd: 5,
  clarification_rounds: 3,
} as const;

const identifier = z.string().trim().min(1).max(200);
const explanation = z.string().trim().min(1).max(2000);
export const selectedEmailExecution = z
  .object({
    request_key: uuid,
    implementation_version_id: uuid,
    message_ids: z
      .array(z.string().regex(/^[a-f0-9]{10,40}$/))
      .min(1)
      .max(GROUP_LIMITS.messages)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Select each message once.",
      ),
  })
  .strict();

/** Source IDs are host-assigned from a sealed capture, never invented by grouping. */
export interface GroupingSource {
  id: string;
  kind: "message" | "document";
  message_id: string;
  artifact_id: string;
}

/** Business-specific keys and grouping decisions belong to the generated workflow. */
export const groupingResult = z
  .object({
    groups: z
      .array(
        z
          .object({
            key: identifier,
            label: identifier,
            context: z.json(),
          })
          .strict(),
      )
      .max(GROUP_LIMITS.groups),
    assignments: z
      .array(
        z
          .object({
            source_id: identifier,
            targets: z
              .array(
                z
                  .object({
                    group_key: identifier,
                    scope: explanation,
                    reason: explanation,
                  })
                  .strict(),
              )
              .max(GROUP_LIMITS.groups),
            unresolved: z
              .object({
                scope: explanation,
                question: explanation,
              })
              .strict()
              .nullable(),
            exclusion_reason: explanation.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(GROUP_LIMITS.sources),
  })
  .strict();
export type GroupingResult = z.infer<typeof groupingResult>;

/** This validates coverage/ownership, not the semantic truth of an AI assignment. */
export function validateGrouping(
  raw: unknown,
  sources: readonly GroupingSource[],
): GroupingResult {
  const result = groupingResult.parse(raw);
  const sourceIds = new Set(sources.map((s) => s.id));
  if (
    sources.length !== sourceIds.size ||
    sources.length > GROUP_LIMITS.sources
  )
    throw new DomainError(
      422,
      "INVALID_SOURCE_INVENTORY",
      "Captured source identities must be unique and bounded.",
    );
  const groupKeys = new Set(result.groups.map((g) => g.key));
  if (groupKeys.size !== result.groups.length)
    throw new DomainError(
      422,
      "DUPLICATE_GROUP",
      "Each group needs a distinct identity; combine related evidence into one group.",
    );
  const covered = new Set<string>(),
    usedGroups = new Set<string>();
  for (const assignment of result.assignments) {
    if (!sourceIds.has(assignment.source_id))
      throw new DomainError(
        422,
        "UNKNOWN_GROUPING_SOURCE",
        "Grouping cannot include evidence outside the selected capture.",
      );
    if (covered.has(assignment.source_id))
      throw new DomainError(
        422,
        "DUPLICATE_SOURCE_DISPOSITION",
        "Record one disposition per source, including every target and unresolved portion.",
      );
    covered.add(assignment.source_id);
    const assignedGroups = new Set<string>();
    for (const target of assignment.targets) {
      if (
        !groupKeys.has(target.group_key) ||
        assignedGroups.has(target.group_key)
      )
        throw new DomainError(
          422,
          "INVALID_GROUP_TARGET",
          "Targets must reference distinct groups in this grouping decision.",
        );
      assignedGroups.add(target.group_key);
      usedGroups.add(target.group_key);
    }
    if (
      assignment.exclusion_reason &&
      (assignment.targets.length || assignment.unresolved)
    )
      throw new DomainError(
        422,
        "CONTRADICTORY_DISPOSITION",
        "An excluded source cannot also supply a group or await clarification.",
      );
    if (
      !assignment.targets.length &&
      !assignment.unresolved &&
      !assignment.exclusion_reason
    )
      throw new DomainError(
        422,
        "UNDISPOSED_SOURCE",
        "Assign, exclude, or ask about every selected source.",
      );
  }
  if (covered.size !== sourceIds.size)
    throw new DomainError(
      422,
      "INCOMPLETE_SOURCE_COVERAGE",
      "Every selected email and document must have an explicit disposition.",
    );
  if (usedGroups.size !== groupKeys.size)
    throw new DomainError(
      422,
      "UNSUPPORTED_GROUP",
      "Every group needs supporting evidence from the selected capture.",
    );
  return result;
}

export function groupingCoverage(result: GroupingResult) {
  return {
    source_count: result.assignments.length,
    assigned_count: result.assignments.filter((a) => a.targets.length > 0)
      .length,
    excluded_count: result.assignments.filter(
      (a) => a.exclusion_reason !== null,
    ).length,
    needs_clarification_count: result.assignments.filter(
      (a) => a.unresolved !== null,
    ).length,
    // A partially assigned source appears in both assigned and clarification counts.
    complete: result.assignments.every((a) => a.unresolved === null),
  };
}

export const answerGroupingQuestion = z
  .object({
    request_key: uuid,
    answer: z.string().trim().min(1).max(10000),
  })
  .strict();
