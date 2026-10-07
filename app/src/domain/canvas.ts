import { z } from "zod";

export const nodeTypes = [
  "trigger",
  "information",
  "task",
  "check",
  "human_handoff",
  "human_approval",
  "outcome",
] as const;
export const nodeLabels: Record<NodeType, string> = {
  trigger: "Trigger",
  information: "Information",
  task: "Task",
  check: "Check",
  human_handoff: "Human handoff",
  human_approval: "Human approval",
  outcome: "Outcome",
};
export type NodeType = (typeof nodeTypes)[number];
export const uuid = z.uuid();
export const revisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const workflowInput = z
  .object({
    name: z.string().trim().min(1).max(200),
    desired_outcome: z.string().max(10000).default(""),
  })
  .strict();
export const nodeInput = z
  .object({
    type: z.enum(nodeTypes),
    title: z.string().max(200).default(""),
    instructions: z.string().max(20000).default(""),
    config: z.record(z.string(), z.json()).default({}),
    x: z.number().min(-100000).max(100000).default(0),
    y: z.number().min(-100000).max(100000).default(0),
    split_mode: z.enum(["exclusive", "parallel"]).nullable().default(null),
    join_for_split_id: uuid.nullable().default(null),
  })
  .strict();
// Zod 4 preserves nested defaults inside partial(). A PATCH must never populate
// an omitted field: doing so resets positions/instructions during unrelated edits.
export const nodePatch = z.object({
  type:nodeInput.shape.type.optional(),
  title:nodeInput.shape.title.removeDefault().optional(),
  instructions:nodeInput.shape.instructions.removeDefault().optional(),
  config:nodeInput.shape.config.removeDefault().optional(),
  x:nodeInput.shape.x.removeDefault().optional(),
  y:nodeInput.shape.y.removeDefault().optional(),
  split_mode:nodeInput.shape.split_mode.removeDefault().optional(),
  join_for_split_id:nodeInput.shape.join_for_split_id.removeDefault().optional(),
  expected_revision:revisionSchema,
}).strict();
export const connectionInput = z
  .object({
    source_node_id: uuid,
    target_node_id: uuid,
    condition_text: z.string().max(5000).default(""),
    is_default: z.boolean().default(false),
  })
  .strict();
export const connectionPatch = z.object({
  source_node_id:uuid.optional(),target_node_id:uuid.optional(),
  condition_text:connectionInput.shape.condition_text.removeDefault().optional(),
  is_default:connectionInput.shape.is_default.removeDefault().optional(),
  expected_revision:revisionSchema,
}).strict();
export const workflowPatch = z.object({
  name:workflowInput.shape.name.optional(),
  desired_outcome:workflowInput.shape.desired_outcome.removeDefault().optional(),
  expected_revision:revisionSchema,
}).strict();

export interface Workflow {
  id: string;
  name: string;
  desired_outcome: string;
  state: "draft" | "reviewing" | "frozen";
  revision: number;
  content_revision: number;
  created_at: string;
  updated_at: string;
}
export interface CanvasNode extends z.infer<typeof nodeInput> {
  id: string;
  workflow_id: string;
  revision: number;
  config_version: number;
}
export interface Connection extends z.infer<typeof connectionInput> {
  id: string;
  workflow_id: string;
  revision: number;
}
export interface Board {
  workflow: Workflow;
  nodes: CanvasNode[];
  connections: Connection[];
}

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function validateDraftConnection(
  nodes: CanvasNode[],
  data: z.infer<typeof connectionInput>,
) {
  if (
    !nodes.some((n) => n.id === data.source_node_id) ||
    !nodes.some((n) => n.id === data.target_node_id)
  ) {
    throw new DomainError(
      422,
      "INVALID_ENDPOINT",
      "Both ends of a connection must be active blocks on this workflow.",
    );
  }
  if (data.is_default && data.condition_text.trim()) {
    throw new DomainError(
      422,
      "INVALID_DEFAULT",
      "An Otherwise connection cannot also have a condition.",
    );
  }
}
