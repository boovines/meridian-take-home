import { z } from "zod";
import Ajv from "ajv";
import { uuid } from "./validation";
import { DomainError } from "./errors";
import type { Json } from "./runtime";

const segment = z
  .string()
  .min(1)
  .max(200)
  .refine((s) => !["__proto__", "constructor", "prototype"].includes(s));
const fieldPath = z.array(segment).min(1).max(16);
export const extractionRequest = z
  .object({
    kind: z.literal("extract"),
    instructions: z.string().min(1).max(20000),
    data: z.json(),
    document_ids: z.array(uuid).min(1).max(20),
    output_schema: z.record(z.string(), z.json()),
    critical_paths: z.array(fieldPath).min(1).max(100),
  })
  .strict();
export type ExtractionRequest = z.infer<typeof extractionRequest>;
export const EXTRACTION_BATCH_POLICY = { version: 1, max_batches: 5, max_combined_result_bytes: 400000 } as const;
export const extractionBatchRequest = z.object({
  kind: z.literal("extract_batch"),
  batches: z.array(extractionRequest).min(1).max(EXTRACTION_BATCH_POLICY.max_batches),
}).strict();

const scalar = z.union([
  z.string().max(20000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const extractionEnvelope = z
  .object({
    data: z.json(),
    fields: z
      .array(
        z
          .object({
            path: fieldPath,
            raw_value: scalar,
            normalized_value: scalar,
            status: z.enum(["found", "absent", "unresolved", "unreadable"]),
            evidence: z
              .array(
                z
                  .object({
                    artifact_id: uuid,
                    page: z.number().int().positive(),
                    text: z.string().trim().min(1).max(4000).optional(),
                    // Relative page coordinates, independent of provider pixel resolution.
                    bounding_box: z
                      .object({
                        x: z.number().min(0).max(1),
                        y: z.number().min(0).max(1),
                        width: z.number().positive().max(1),
                        height: z.number().positive().max(1),
                      })
                      .strict()
                      .optional(),
                  })
                  .strict(),
              )
              .max(20),
            explanation: z.string().trim().min(1).max(2000).nullable(),
          })
          .strict(),
      )
      .max(2000),
  })
  .strict();
export type ExtractionEnvelope = z.infer<typeof extractionEnvelope>;
export interface EvidenceDocument {
  artifact_id: string;
  page_count: number;
}
export interface ExtractionIssue {
  path: string[];
  reason: string;
}
function invalid(
  issues: ExtractionIssue[],
  code = "EXTRACTION_EVIDENCE_INVALID",
): never {
  throw new DomainError(
    422,
    code,
    `Extraction needs attention: ${issues.length} field evidence issue(s).`,
    { issues: issues.slice(0, 100) },
  );
}
// Generated JSON schemas describe data, never execute code or fetch remote refs.
// Keep this deliberately small; reject recursive references and regex work.
export function validateExtractionSchema(
  schema: ExtractionRequest["output_schema"],
) {
  if (JSON.stringify(schema).length > 40000)
    throw new DomainError(
      422,
      "EXTRACTION_SCHEMA_INVALID",
      "Extraction schema exceeds 40 KB.",
    );
  let nodes = 0;
  function inspect(value: unknown, depth = 0) {
    if (++nodes > 3000 || depth > 24)
      throw new DomainError(
        422,
        "EXTRACTION_SCHEMA_INVALID",
        "Extraction schema exceeds its structural limit.",
      );
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (
          ["$async", "$ref", "$dynamicRef", "pattern", "patternProperties"].includes(key)
        )
          throw new DomainError(
            422,
            "EXTRACTION_SCHEMA_INVALID",
            "Extraction schemas must be synchronous and cannot contain references or regular expressions.",
          );
        inspect(item, depth + 1);
      }
  }
  inspect(schema);
  try {
    return new Ajv({
      strict: true,
      allowUnionTypes: true,
      allErrors: false,
      validateFormats: false,
    }).compile(schema);
  } catch {
    throw new DomainError(
      422,
      "EXTRACTION_SCHEMA_INVALID",
      "Use a valid bounded JSON Schema for extraction output.",
    );
  }
}
function at(data: unknown, path: string[]): unknown {
  let v = data;
  for (const key of path) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, key))
      return undefined;
    v = (v as Record<string, unknown>)[key];
  }
  return v;
}
function expand(data: Json, pattern: string[]): string[][] {
  const paths: string[][] = [];
  function walk(prefix: string[], i: number) {
    if (paths.length > 2000)
      throw new DomainError(
        422,
        "EXTRACTION_EVIDENCE_INVALID",
        "Too many decision-relevant fields.",
      );
    if (i === pattern.length) {
      paths.push(prefix);
      return;
    }
    if (pattern[i] === "*") {
      const array = at(data, prefix);
      if (!Array.isArray(array)) {
        paths.push([...prefix, ...pattern.slice(i)]);
        return;
      }
      array.forEach((_, n) => walk([...prefix, String(n)], i + 1));
    } else walk([...prefix, pattern[i]], i + 1);
  }
  walk([], 0);
  return paths;
}
export function validateExtraction(
  request: ExtractionRequest,
  raw: unknown,
  documents: EvidenceDocument[],
): ExtractionEnvelope {
  if (JSON.stringify(raw)?.length > 512000)
    invalid([{ path: [], reason: "Extraction envelope exceeds 512 KB." }]);
  const parsed = extractionEnvelope.safeParse(raw);
  if (!parsed.success)
    invalid([
      {
        path: [],
        reason:
          "Expected data plus typed field evidence; a bare null is not proof of absence.",
      },
    ]);
  const value = parsed.data;
  const check = validateExtractionSchema(request.output_schema);
  if (!check(value.data))
    invalid([
      {
        path: [],
        reason: `Output does not match the generated schema: ${check.errors?.[0]?.instancePath || "/"}.`,
      },
    ]);
  const issues: ExtractionIssue[] = [],
    pending: ExtractionIssue[] = [];
  const fields = new Map<string, ExtractionEnvelope["fields"][number]>();
  for (const field of value.fields) {
    const key = JSON.stringify(field.path);
    const fail = (reason: string) => issues.push({ path: field.path, reason });
    if (fields.has(key)) fail("Duplicate field evidence.");
    fields.set(key, field);
    if (at(value.data, field.path) !== field.normalized_value)
      fail("Normalized value does not match the data field.");
    if (field.status === "found") {
      if (
        field.raw_value === null ||
        field.normalized_value === null ||
        field.raw_value === "" ||
        field.normalized_value === ""
      )
        fail("Found fields require nonempty raw and normalized values.");
      if (
        !field.evidence.length ||
        field.evidence.some((e) => !e.text && !e.bounding_box)
      )
        fail("Found fields need source text or a bounding box.");
    } else {
      if (field.normalized_value !== null)
        fail("Absent or uncertain fields must not contain a normalized fact.");
      if (!field.explanation)
        fail("Missing or uncertain fields require an explanation.");
      if (
        field.status === "absent" &&
        (!field.evidence.length || field.raw_value !== null)
      )
        fail("Absence needs searched source pages and a null raw value.");
      if (field.status === "unresolved" || field.status === "unreadable")
        pending.push({
          path: field.path,
          reason: field.explanation || field.status,
        });
    }
    for (const e of field.evidence) {
      const doc = documents.find((d) => d.artifact_id === e.artifact_id);
      if (
        !doc ||
        !request.document_ids.includes(e.artifact_id) ||
        e.page > doc.page_count
      )
        fail("Evidence references an unavailable document or page.");
      if (
        e.bounding_box &&
        (e.bounding_box.x + e.bounding_box.width > 1.000001 ||
          e.bounding_box.y + e.bounding_box.height > 1.000001)
      )
        fail("Bounding box extends beyond its page.");
    }
  }
  for (const pattern of request.critical_paths)
    for (const path of expand(value.data, pattern)) {
      if (!fields.has(JSON.stringify(path)))
        issues.push({
          path,
          reason: "Decision-relevant field has no evidence disposition.",
        });
    }
  if (issues.length) invalid(issues);
  if (pending.length) invalid(pending, "EXTRACTION_UNRESOLVED");
  return value;
}

export const extractionInstructions = `Return an object with data and fields. data must match output_schema. For every scalar field selected by critical_paths ("*" means each array item), fields must contain {path: string[], raw_value: string|number|boolean|null, normalized_value: string|number|boolean|null, status: "found"|"absent"|"unresolved"|"unreadable", evidence: [{artifact_id, page: 1-based integer, text?: exact supporting quote, bounding_box?: {x,y,width,height} in 0..1 page coordinates}], explanation: string|null}. normalized_value must equal the value at that path in data. Preserve raw printed identifiers even when normalizing names. Check document headers and shared context when establishing which records a value applies to. Do not guess missing facts. Found requires raw and normalized values plus a source quote or box. Absent requires null values, searched source pages, and an explanation of where you checked. Unresolved/unreadable requires a null normalized value and explanation; distinguish uncertainty from demonstrated absence. Include every relevant record, not just records with complete fields. Never change the supplied output schema or critical paths. Evidence is a source claim, not proof merely because it is structurally valid.`;
