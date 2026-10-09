import { jsonSchema, Output } from "ai";
import { extractionEnvelope, validateExtractionSchema, type ExtractionRequest } from "../../domain/extraction";
import { DomainError } from "../../domain/errors";
import type { Json } from "../../domain/runtime";

export const EXTRACTION_RESPONSE_FORMAT_VERSION = 1;

/** The host owns the evidence envelope; generated code owns the data schema. */
export function extractionOutput(dataSchema: ExtractionRequest["output_schema"]) {
  const checkData = validateExtractionSchema(dataSchema);
  function checkObjects(schema: unknown) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
    const node = schema as Record<string, unknown>;
    if (node.type === "object" || (Array.isArray(node.type) && node.type.includes("object")) || node.properties) {
      const keys = Object.keys((node.properties ?? {}) as object);
      if (node.additionalProperties !== false || !Array.isArray(node.required) || keys.some(key => !(node.required as unknown[]).includes(key)))
        throw new DomainError(422, "EXTRACTION_SCHEMA_INVALID", "Structured extraction requires closed objects (additionalProperties: false) with every property required. Represent missing values with nullable types; do not remove required business facts.");
    }
    for (const value of Object.values((node.properties ?? {}) as object)) checkObjects(value);
    checkObjects(node.items);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[keyword])) node[keyword].forEach(checkObjects);
  }
  checkObjects(dataSchema);
  const scalar = { type: ["string", "number", "boolean", "null"] };
  const schema = {
    type: "object", additionalProperties: false, required: ["data", "fields"],
    properties: {
      data: dataSchema,
      fields: { type: "array", items: {
        type: "object", additionalProperties: false,
        required: ["path", "raw_value", "normalized_value", "status", "evidence", "explanation"],
        properties: {
          path: { type: "array", items: { type: "string" } },
          raw_value: scalar, normalized_value: scalar,
          status: { type: "string", enum: ["found", "absent", "unresolved", "unreadable"] },
          explanation: { type: ["string", "null"] },
          evidence: { type: "array", items: {
            type: "object", additionalProperties: false,
            required: ["artifact_id", "page", "text", "bounding_box"],
            properties: {
              artifact_id: { type: "string" }, page: { type: "integer" },
              text: { type: ["string", "null"] },
              bounding_box: { type: ["object", "null"], additionalProperties: false,
                required: ["x", "y", "width", "height"], properties: {
                  x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" },
                } },
            },
          } },
        },
      } },
    },
  };
  return Output.object({ schema: jsonSchema<Json>(schema as Parameters<typeof jsonSchema>[0], {
    validate(value) {
      const envelope = extractionEnvelope.safeParse(value);
      if (!envelope.success || !checkData(envelope.data.data))
        return { success: false, error: new Error("Response does not match the extraction envelope and data schema.") };
      // Validate here without applying Zod normalization: the model-response audit
      // must retain the provider value. Runtime validation normalizes its own copy.
      return { success: true, value: value as Json };
    },
  }) });
}
