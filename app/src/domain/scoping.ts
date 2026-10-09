import { z } from "zod";
import { revisionSchema, uuid } from "./validation";
import { nodeTypes, type Board, type Workflow } from "./canvas";
import { DomainError } from "./errors";
import { validateGraph } from "./validate-graph";

const text = z.string().trim().min(1).max(10000);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
export const scopeSchema = z
  .object({
    summary: text,
    coverage: z
      .object({
        trigger: text.nullable(),
        outcome: text.nullable(),
        steps: text.nullable(),
        routing: text.nullable(),
        humans: text.nullable(),
        exceptions: text.nullable(),
      })
      .strict(),
    blockers: z.array(text).max(12),
    assumptions: z.array(text).max(12),
    unresolved: z.array(z.object({ key, question: text }).strict()).max(15),
  })
  .strict();
export type Scope = z.infer<typeof scopeSchema>;
export function scopeReady(scope: Scope) {
  return Object.values(scope.coverage).every(Boolean) && !scope.blockers.length;
}
export const interviewOutput = z
  .object({ message: text, scope: scopeSchema })
  .strict();
export const scaffoldSchema = z
  .object({
    desired_outcome: text,
    nodes: z
      .array(
        z
          .object({
            key,
            type: z.enum(nodeTypes),
            title: z.string().trim().min(1).max(200),
            instructions: z.string().trim().min(1).max(18000),
            split_mode: z.enum(["exclusive", "parallel"]).nullable(),
            join_for_split_key: key.nullable(),
          })
          .strict(),
      )
      .min(2)
      .max(40),
    connections: z
      .array(
        z
          .object({
            key,
            source: key,
            target: key,
            condition_text: z.string().max(5000),
            is_default: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(80),
    unresolved_anchors: z
      .array(
        z
          .object({
            key,
            node_keys: z.array(key).max(20),
            connection_keys: z.array(key).max(20),
          })
          .strict(),
      )
      .max(15),
  })
  .strict();
export const previewOutput = z
  .object({ message: text, graph: scaffoldSchema })
  .strict();
export type Scaffold = z.infer<typeof scaffoldSchema>;
export const saveScopingNote = z
  .object({ note: z.string().max(50000), expected_revision: revisionSchema })
  .strict();
export const scopingRequest = z
  .object({
    action: z.enum(["start", "answer", "notes", "revise", "preview"]),
    body: z.string().trim().max(20000).default(""),
    expected_revision: revisionSchema,
    expected_note_revision: revisionSchema,
    request_key: uuid,
  })
  .strict();
export const scopingApply = z
  .object({
    preview_id: uuid,
    expected_revision: revisionSchema,
    expected_workflow_revision: revisionSchema,
    request_key: uuid,
  })
  .strict();
export interface ScopingSession {
  workflow_id: string;
  note: string;
  note_revision: number;
  revision: number;
  incorporated_note_revision: number | null;
  current_scope_id: string | null;
  current_preview_id: string | null;
  applied_preview_id: string | null;
  applied_content_revision: number | null;
  apply_request_key: string | null;
  applied_at: string | null;
}
export interface ScopingVersion {
  id: string;
  workflow_id: string;
  kind: "scope" | "preview";
  note_revision: number;
  scope_id: string | null;
  data: z.infer<typeof interviewOutput> | z.infer<typeof previewOutput>;
  created_at: string;
}
export interface ScopingMessage {
  id: string;
  author: "expert" | "agent";
  body: string;
  created_at: string;
}
export interface ScopingInput {
  note: string;
  note_revision: number;
  action: z.infer<typeof scopingRequest>["action"];
  messages: Pick<ScopingMessage, "author" | "body">[];
  scope: Scope | null;
  scope_id: string | null;
  preview: Scaffold | null;
  workflow: Workflow;
}
export interface ScopingOperation {
  id: string;
  workflow_id: string;
  kind: "interview" | "preview";
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  session_revision: number;
  input: ScopingInput;
  model: string;
  error_message: string | null;
  deadline_at: string;
}
export interface ScopingState {
  session: ScopingSession;
  messages: ScopingMessage[];
  versions: ScopingVersion[];
  operation: Omit<ScopingOperation, "input"> | null;
  needs_review: boolean;
}

// Stable breadth-first layers keep loops readable and never depend on model coordinates.
export function scaffoldBoard(
  graph: Scaffold,
  workflow: Workflow,
  scope: Scope,
  ids?: Record<string, string>,
): Board {
  const invalid = (message: string): never => {
    throw new DomainError(422, "INVALID_SCAFFOLD", message);
  };
  const nodeKeys = new Set(graph.nodes.map((n) => n.key));
  if (
    nodeKeys.size !== graph.nodes.length ||
    new Set(graph.connections.map((c) => c.key)).size !==
      graph.connections.length
  )
    invalid("Every generated block and connection needs a unique key.");
  const unknowns = new Set(scope.unresolved.map((u) => u.key));
  if (
    unknowns.size !== scope.unresolved.length ||
    graph.unresolved_anchors.length !== unknowns.size ||
    new Set(graph.unresolved_anchors.map((a) => a.key)).size !== unknowns.size
  )
    invalid("The preview must preserve every unresolved scope question.");
  for (const a of graph.unresolved_anchors) {
    if (
      new Set(a.node_keys).size !== a.node_keys.length ||
      new Set(a.connection_keys).size !== a.connection_keys.length
    )
      invalid(
        "An unresolved question must reference each block or connection only once.",
      );
    if (
      !unknowns.has(a.key) ||
      a.node_keys.some((k) => !nodeKeys.has(k)) ||
      a.connection_keys.some((k) => !graph.connections.some((c) => c.key === k))
    )
      invalid(
        "An unresolved question references an unknown block or connection.",
      );
  }
  const depth = new Map<string, number>();
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) depth.set(trigger.key, 0);
  const queue = trigger ? [trigger.key] : [];
  for (let i = 0; i < queue.length; i++) {
    for (const c of graph.connections.filter((c) => c.source === queue[i])) {
      if (!depth.has(c.target)) {
        depth.set(c.target, depth.get(queue[i])! + 1);
        queue.push(c.target);
      }
    }
  }
  const layers = new Map<number, string[]>();
  for (const n of graph.nodes) {
    const d = depth.get(n.key) ?? 0;
    layers.set(d, [...(layers.get(d) || []), n.key]);
  }
  const id = (key: string) =>
    ids ? (ids[key] ?? invalid("Unknown graph reference.")) : key;
  const board: Board = {
    workflow: { ...workflow, desired_outcome: graph.desired_outcome },
    nodes: graph.nodes.map((n) => {
      if (n.join_for_split_key && !nodeKeys.has(n.join_for_split_key))
        invalid("Unknown paired split.");
      const d = depth.get(n.key) ?? 0,
        layer = layers.get(d)!;
      const questions = graph.unresolved_anchors
        .filter(
          (a) =>
            a.node_keys.includes(n.key) ||
            a.connection_keys.some((k) =>
              graph.connections.some((c) => c.key === k && c.source === n.key),
            ),
        )
        .map((a) => scope.unresolved.find((u) => u.key === a.key)!.question);
      const instructions = [
        n.instructions,
        ...questions.map((q) => `Unresolved — requires review: ${q}`),
      ].join("\n\n");
      if (instructions.length > 20000)
        invalid("Generated instructions exceed the block limit.");
      return {
        id: id(n.key),
        workflow_id: workflow.id,
        revision: 1,
        config_version: 1,
        type: n.type,
        title: n.title,
        instructions,
        config: {},
        x: (layer.indexOf(n.key) - (layer.length - 1) / 2) * 290,
        y: d * 220,
        split_mode: n.split_mode,
        join_for_split_id: n.join_for_split_key
          ? id(n.join_for_split_key)
          : null,
      };
    }),
    connections: graph.connections.map((c) => {
      if (!nodeKeys.has(c.source) || !nodeKeys.has(c.target))
        invalid("Unknown connection endpoint.");
      if (c.is_default && c.condition_text.trim())
        invalid("Otherwise paths cannot also have a condition.");
      return {
        id: ids ? id(`edge:${c.key}`) : c.key,
        workflow_id: workflow.id,
        revision: 1,
        source_node_id: id(c.source),
        target_node_id: id(c.target),
        condition_text: c.condition_text.trim(),
        is_default: c.is_default,
      };
    }),
  };
  if (
    graph.nodes.some(
      (n) =>
        graph.connections.filter((c) => c.source === n.key && c.is_default)
          .length > 1,
    )
  )
    invalid("Only one Otherwise path is allowed per block.");
  const issues = validateGraph(board);
  if (issues.length) invalid(issues.map((i) => i.message).join(" "));
  return board;
}
