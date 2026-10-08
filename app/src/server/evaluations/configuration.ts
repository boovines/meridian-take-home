import { isDeepStrictEqual } from "node:util";
import { runtimeModelConfiguration } from "../integrations/openai-step";
import { DomainError } from "../../domain/errors";
import { DEMO_LIMITS, type Json } from "../../domain/runtime";
/** Snapshot non-secret execution settings. Generated prompts/schemas are fixed by the immutable code version. */
export function evaluationConfiguration(): Json {
  return {
    contract_version: 1,
    runtime: runtimeModelConfiguration(),
    extraction: {
      provider: process.env.EXTRACTION_PROVIDER || "openai",
      reinspection: process.env.EXTRACTION_REINSPECTION === "1",
      llama_configuration: "agentic-2.5-parse-agentic-disable-extract-cache-v1",
    },
    limits: { ...DEMO_LIMITS },
    fresh_extraction: true,
  };
}
export function assertEvaluationConfiguration(recorded: Json) {
  if (!isDeepStrictEqual(recorded, evaluationConfiguration()))
    throw new DomainError(409, "EVALUATION_CONFIGURATION_CHANGED", "Execution settings changed. Stop this sequence and inspect the retained results before evaluating a new configuration.");
}
