import { isDeepStrictEqual } from "node:util";
import { runtimeModelConfiguration } from "../integrations/openai-step";
import { DomainError } from "../../domain/errors";
import { DEMO_LIMITS, type Json } from "../../domain/runtime";
import { openAITokenPreflightPolicy } from "../integrations/openai-preflight";
/** Snapshot non-secret execution settings. Generated prompts/schemas are fixed by the immutable code version. */
export function evaluationConfiguration(): Json {
  return {
    contract_version: 1,
    runtime: runtimeModelConfiguration(),
    extraction: { provider: "openai" },
    limits: { ...DEMO_LIMITS },
    fresh_extraction: true,
    inference_preflight: process.env.INFERENCE_BUDGET_LEDGER || process.env.INFERENCE_BUDGET_USD
      ? JSON.parse(JSON.stringify(openAITokenPreflightPolicy)) : null,
  };
}
export function assertEvaluationConfiguration(recorded: Json) {
  if (!isDeepStrictEqual(recorded, evaluationConfiguration()))
    throw new DomainError(409, "EVALUATION_CONFIGURATION_CHANGED", "Execution settings changed. Stop this sequence and inspect the retained results before evaluating a new configuration.");
}
