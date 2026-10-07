import { NoObjectGeneratedError, NoOutputGeneratedError } from "ai";
import { DomainError } from "../../domain/canvas";

interface OutputMetadata {
  finishReason?: string;
  usage?: {
    outputTokens?: number;
    outputTokenDetails?: { reasoningTokens?: number; textTokens?: number };
  };
}
function incomplete(operation: string, metadata: OutputMetadata) {
  const limited = metadata.finishReason === "length";
  return new DomainError(
    422,
    limited ? "MODEL_OUTPUT_LIMIT" : "MODEL_OUTPUT_INVALID",
    limited
      ? `${operation} reached the model response limit before completing. No partial output was accepted. Reduce the requested output or adjust the model settings before retrying.`
      : `${operation} did not return a complete response in the required format. No partial output was accepted. Inspect the request and retry.`,
    {
      finish_reason: metadata.finishReason || "unknown",
      output_tokens: metadata.usage?.outputTokens ?? null,
      reasoning_tokens: metadata.usage?.outputTokenDetails?.reasoningTokens ?? null,
    },
  );
}

// The SDK can return a result whose output getter throws, or reject while parsing.
// Preserve only bounded diagnostics; errors may otherwise contain source or documents.
export async function modelOutput<T>(
  call: () => Promise<OutputMetadata & { output: T }>,
  operation: string,
): Promise<T> {
  let metadata: OutputMetadata = {};
  try {
    const result = await call();
    metadata = result;
    if (result.finishReason !== "stop") throw incomplete(operation, result);
    return result.output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error))
      throw incomplete(operation, error);
    if (NoOutputGeneratedError.isInstance(error))
      throw incomplete(operation, metadata);
    throw error;
  }
}
