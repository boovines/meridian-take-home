import { z } from "zod";
import { uuid } from "./validation";
import { extractionRequest } from "./extraction";

export const generatedSources = z
  .object({
    status: z.enum(["ready", "needs_attention"]),
    explanation: z.string().max(4000),
    steps: z
      .array(
        z
          .object({
            node_id: uuid,
            source_lines: z
              .array(z.string().max(10000))
              .min(1)
              .max(2000)
              .describe(
                "JavaScript source, one actual line per array entry. Do not double-escape line separators or wrap code in markdown.",
              ),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const projectSchema = z
  .object({
    format: z.literal("meridian-project-v1"),
    workflow_id: uuid,
    frozen_spec_id: uuid,
    plan_version_id: uuid,
    entrypoint: z.literal("run-step.mjs"),
    node_file_map: z.record(uuid, z.string().regex(/^steps\/[a-f0-9-]+\.mjs$/)),
    files: z.record(
      z.string().regex(/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+$/),
      z.string().max(2000000),
    ),
    generator: z.object({ model: z.string(), summary: z.string() }).strict(),
  })
  .strict();
export type Project = z.infer<typeof projectSchema>;
export const stepResult = z.discriminatedUnion("kind", [
  extractionRequest,
  z
    .object({
      kind: z.literal("complete"),
      output: z.json(),
      matching_connection_ids: z.array(uuid).max(100),
    })
    .strict(),
  z
    .object({
      kind: z.literal("reason"),
      instructions: z.string().min(1).max(20000),
      data: z.json(),
      document_ids: z.array(uuid).max(20).default([]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("human"),
      question: z.string().min(1).max(20000),
    })
    .strict(),
]);
