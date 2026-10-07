import type { z } from "zod";
import { DomainError, type Board } from "../../domain/canvas";
import type { Plan, PlanStep } from "../../domain/engineering";
import {
  generatedSources,
  projectSchema,
  type Project,
} from "../../domain/project";

// These instructions are both the coding-agent contract and the downloaded project's documentation.
export const moduleContract = `Every generated file is a Node.js ES module (.mjs). Use the exact declaration export async function run(context) { ... }. Do not use CommonJS exports, module.exports, or require.
context.input is the immutable original input bundle, context.steps is a map from frozen node ID to its most recent output, and context.tool_result is present only on the second call after an Agent request. context.human_response is supplied only after a fresh human response.
For example, if node A returns {kind:"complete",output:{items:[...]},matching_connection_ids:[...]}, node B reads context.steps[A].items, NOT context.steps[A].output.items. The host stores only the output value in context.steps.
Return exactly one JSON object:
  {kind:"complete", output:<JSON>, matching_connection_ids:[...]} for a completed step.
  {kind:"reason", instructions:<string>, data:<JSON>, document_ids:[<captured artifact UUID>,...]} to request one bounded model call (Agent method only). On the second call, consume context.tool_result and return complete. No recursive tool requests.
For Human methods, context.human_response is always supplied to your generated module after the platform obtains a fresh response. Return complete with that response and matching outgoing routes. The host wraps it with a mandatory human gate; do not implement or bypass that gate.
matching_connection_ids contains only non-default outgoing connections whose conditions match. Return all matches, never choose the first matching path. For a single unconditional connection include its ID; the trusted runtime owns parallel branches, Otherwise fallback, and exact-one routing validation.
Keep workflow-specific records in output; downstream nodes read context.steps[upstreamNodeId]. Preserve identifiers and missing-field details. Do not hardcode sample answers. Throw a descriptive Error for unreadable or unsupported inputs. Do not invent missing business rules.
Use Node.js 24 JavaScript with no external packages. No network, environment secrets, subprocesses, dynamic evaluation, or filesystem access. No side effects: email is a report preview only. Modules do not control the workflow scheduler, human authorization, limits, or grading.
The bundle input can contain shipment_reference, messages (id, subject, sender, received_at, text), and documents (artifact_id, name, media_type, byte_size, sha256, message_id). A Trigger reading Gmail uses these captured messages; it never fetches Gmail itself. Document bytes are not embedded in context. An Agent can request up to 20 captured documents (20 MB total) through document_ids; the host reads the immutable artifacts and supplies PDF, PNG/JPEG/WebP, plain text, or CSV contents to the model. Unsupported formats are preserved in capture but must not be silently treated as verified. Pass only relevant document IDs, never URLs, paths, or base64. The generated code never receives service keys.
An Agent request must specify the exact JSON shape needed by its downstream consumers, including all required field names and how absent values are represented. Validate context.tool_result before returning it; do not silently turn missing arrays into empty successful results. Select supported relevant documents using their metadata; never blindly take the first 20 documents or silently omit required evidence to fit the limit. If the required evidence cannot be read within this contract, report the limitation.
All modules must agree on the shapes they exchange. The frozen graph and approved methods are fixed.`;

const launcher = `import { readFile } from 'node:fs/promises';
const [nodeId, inputFile] = process.argv.slice(2);
const plan = JSON.parse(await readFile(new URL('./plan.json', import.meta.url), 'utf8'));
const step = plan.steps.find(s => s.node_id === nodeId);
if (!step || !inputFile) throw new Error('Usage: node run-step.mjs <node-id> <context.json>');
const context = JSON.parse(await readFile(inputFile, 'utf8'));
const mod = await import(new URL('./steps/' + nodeId + '.mjs', import.meta.url));
const result = await mod.run(context);
if (step.selected_method === 'code' && result.kind !== 'complete') throw new Error('Code steps cannot request agent or human tools.');
process.stdout.write(JSON.stringify(result));
`;

export function assembleProject(
  board: Board,
  specId: string,
  plan: Plan,
  steps: PlanStep[],
  generated: z.infer<typeof generatedSources>,
  model: string,
): Project {
  if (generated.status !== "ready")
    throw new DomainError(
      422,
      "GENERATION_NEEDS_ATTENTION",
      generated.explanation || "The approved plan needs an engineer decision.",
    );
  const required = steps;
  if (
    generated.steps.length !== required.length ||
    new Set(generated.steps.map((s) => s.node_id)).size !== required.length ||
    required.some((s) => !generated.steps.some((g) => g.node_id === s.node_id))
  )
    throw new DomainError(
      422,
      "INCOMPLETE_PROJECT",
      "Generated source must cover every approved step exactly once.",
    );
  const files: Record<string, string> = {
    "run-step.mjs": launcher,
    "graph.json": JSON.stringify(board, null, 2),
    "plan.json": JSON.stringify({ plan, steps }, null, 2),
    "package.json": JSON.stringify(
      {
        name: "meridian-generated-workflow",
        private: true,
        type: "module",
        engines: { node: ">=24" },
      },
      null,
      2,
    ),
    "README.md": `# ${board.workflow.name}\n\n${generated.explanation}\n\n## Running a step\n\nExtract the project download, provide a JSON context, and run:\n\n\`node run-step.mjs <node-id> <context.json>\`\n\n${moduleContract}\n\nThe Meridian worker supplies input capture, routing, human pauses, agent requests, and evaluations. This CLI invokes one step and returns any tool request for the host to handle; it does not silently auto-approve human work. Do not execute generated code outside an isolated environment.\n\nBuild validation checks syntax; it does not establish business correctness.\n`,
  };
  const nodeFileMap: Record<string, string> = {};
  for (const step of steps) {
    const node = board.nodes.find((n) => n.id === step.node_id)!;
    const file = `steps/${node.id}.mjs`;
    const source = generated.steps
      .find((s) => s.node_id === node.id)!
      .source_lines.join("\n");
    nodeFileMap[node.id] = file;
    // Human behavior is platform-owned, never generated or optimized away.
    files[file] =
      step.selected_method === "human"
        ? `export async function run(context) {\n  if (!Object.hasOwn(context, 'human_response')) return {kind:'human', question:${JSON.stringify(node.instructions || node.title)}};\n  const implementation = await import('../human/${node.id}.mjs');\n  const result = await implementation.run(context);\n  if (result.kind !== 'complete') throw new Error('Human response handling must complete without requesting tools.');\n  return result;\n}\n`
        : source;
    if (step.selected_method === "human")
      files[`human/${node.id}.mjs`] = source;
  }
  return validateProject({
    format: "meridian-project-v1",
    workflow_id: board.workflow.id,
    frozen_spec_id: specId,
    plan_version_id: plan.id,
    entrypoint: "run-step.mjs",
    node_file_map: nodeFileMap,
    files,
    generator: { model, summary: generated.explanation },
  });
}

export function validateProject(value: unknown): Project {
  const project = projectSchema.parse(value);
  if (
    Object.keys(project.files).length > 210 ||
    Buffer.byteLength(JSON.stringify(project)) > 4 * 1024 * 1024 ||
    Object.keys(project.files).some((p) =>
      p.split("/").some((s) => s === "." || s === ".."),
    ) ||
    !project.files[project.entrypoint] ||
    Object.values(project.node_file_map).some((p) => !project.files[p])
  )
    throw new DomainError(
      422,
      "INVALID_PROJECT",
      "The project has invalid paths, missing files, or exceeds the demo size limit.",
    );
  return project;
}
