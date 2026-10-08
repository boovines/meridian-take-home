import type { ExtractionRequest } from "../../domain/extraction";
import type { ReasoningDocument } from "../runtime/documents";
import { extractWithReinspection } from "../runtime/extraction-provider";
import { extractForStep as openAIExtract } from "./openai-step";
import { llamaExtract } from "./llama-extract";
import { DomainError } from "../../domain/errors";
export async function extractForStep(
  request: ExtractionRequest,
  documents: ReasoningDocument[],
  signal: AbortSignal,
) {
  const choice = process.env.EXTRACTION_PROVIDER || "openai";
  if (!["openai", "llamacloud"].includes(choice))
    throw new DomainError(
      503,
      "EXTRACTION_UNAVAILABLE",
      "Unsupported extraction provider.",
    );
  const provider = choice === "llamacloud" ? llamaExtract : openAIExtract;
  return process.env.EXTRACTION_REINSPECTION === "1"
    ? extractWithReinspection(request, documents, signal, provider)
    : provider(request, documents, signal);
}
