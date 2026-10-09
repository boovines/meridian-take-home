import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  validateGrouping,
  groupingCoverage,
  selectedEmailExecution,
  type GroupingSource,
} from "../src/domain/grouped-execution";
const sources: GroupingSource[] = [
  {
    id: "email:a",
    kind: "message",
    message_id: "a",
    artifact_id: randomUUID(),
  },
  {
    id: "document:1",
    kind: "document",
    message_id: "a",
    artifact_id: randomUUID(),
  },
  {
    id: "email:b",
    kind: "message",
    message_id: "b",
    artifact_id: randomUUID(),
  },
];
const group = (key: string) => ({ key, label: key, context: { request: key } });
const target = (group_key: string, scope = "Entire source") => ({
  group_key,
  scope,
  reason: "Explicit customer reference in source",
});
const assignment = (
  source_id: string,
  targets: ReturnType<typeof target>[],
) => ({ source_id, targets, unresolved: null, exclusion_reason: null });
it("keeps multiple groups from one source and multiple sources in one group without deduplicating distinct identities", () => {
  const result = validateGrouping(
    {
      groups: [group("A"), group("B")],
      assignments: [
        assignment("email:a", [
          target("A", "Request A section"),
          target("B", "Request B section"),
        ]),
        assignment("document:1", [target("A")]),
        assignment("email:b", [target("B")]),
      ],
    },
    sources,
  );
  expect(result.groups).toHaveLength(2);
  expect(groupingCoverage(result)).toMatchObject({
    source_count: 3,
    assigned_count: 3,
    complete: true,
  });
});
it("preserves identifiable portions while surfacing ambiguity and explicit irrelevant-source exclusions", () => {
  const result = validateGrouping(
    {
      groups: [group("A")],
      assignments: [
        {
          ...assignment("email:a", [target("A", "Named request A")]),
          unresolved: {
            scope: "Unlabeled second request",
            question: "Which request owns the unlabeled section?",
          },
        },
        assignment("document:1", [target("A")]),
        {
          ...assignment("email:b", []),
          exclusion_reason: "Unrelated newsletter",
        },
      ],
    },
    sources,
  );
  expect(groupingCoverage(result)).toEqual({
    source_count: 3,
    assigned_count: 2,
    excluded_count: 1,
    needs_clarification_count: 1,
    complete: false,
  });
});
it("rejects silent omissions, invented sources, duplicate dispositions, empty groups and contradictory exclusions", () => {
  const valid = {
    groups: [group("A")],
    assignments: sources.map((s) => assignment(s.id, [target("A")])),
  };
  expect(() =>
    validateGrouping(
      { ...valid, assignments: valid.assignments.slice(1) },
      sources,
    ),
  ).toThrow(/Every selected/);
  expect(() =>
    validateGrouping(
      {
        ...valid,
        assignments: [
          ...valid.assignments,
          assignment("not-selected", [target("A")]),
        ],
      },
      sources,
    ),
  ).toThrow(/outside/);
  expect(() =>
    validateGrouping(
      { ...valid, assignments: [...valid.assignments, valid.assignments[0]] },
      sources,
    ),
  ).toThrow(/one disposition/);
  expect(() =>
    validateGrouping(
      { ...valid, groups: [...valid.groups, group("unsupported")] },
      sources,
    ),
  ).toThrow(/supporting evidence/);
  expect(() =>
    validateGrouping(
      {
        ...valid,
        assignments: valid.assignments.map((a) => ({
          ...a,
          exclusion_reason: "Irrelevant",
        })),
      },
      sources,
    ),
  ).toThrow(/excluded source/);
});
it("rejects duplicate group identities and unknown or repeated targets", () => {
  const valid = {
    groups: [group("A")],
    assignments: sources.map((s) => assignment(s.id, [target("A")])),
  };
  expect(() =>
    validateGrouping({ ...valid, groups: [group("A"), group("A")] }, sources),
  ).toThrow(/distinct identity/);
  expect(() =>
    validateGrouping(
      {
        ...valid,
        assignments: valid.assignments.map((a) => ({
          ...a,
          targets: [target("B")],
        })),
      },
      sources,
    ),
  ).toThrow(/distinct groups/);
  expect(() =>
    validateGrouping(
      {
        ...valid,
        assignments: valid.assignments.map((a) => ({
          ...a,
          targets: [target("A"), target("A")],
        })),
      },
      sources,
    ),
  ).toThrow(/distinct groups/);
});
it("requires an explicit bounded unique email selection before execution", () => {
  const base = {
    request_key: randomUUID(),
    implementation_version_id: randomUUID(),
  };
  expect(
    selectedEmailExecution.safeParse({ ...base, message_ids: [] }).success,
  ).toBe(false);
  expect(
    selectedEmailExecution.safeParse({
      ...base,
      message_ids: ["abcdef12345", "abcdef12345"],
    }).success,
  ).toBe(false);
  expect(
    selectedEmailExecution.safeParse({
      ...base,
      message_ids: Array.from({ length: 11 }, (_, i) => `abcdef1234${i}`),
    }).success,
  ).toBe(false);
  expect(
    selectedEmailExecution.safeParse({ ...base, message_ids: ["abcdef12345"] })
      .success,
  ).toBe(true);
});
