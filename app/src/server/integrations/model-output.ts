import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
} from "ai";
import { DomainError } from "../../domain/errors";

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

function quotaFailure(error: unknown, operation: string) {
  if (RetryError.isInstance(error) && error.reason === "abort") return null;
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (!APICallError.isInstance(last) || last.statusCode !== 429) return null;
  let payload = last.data;
  if (!payload && last.responseBody && last.responseBody.length <= 64000) {
    try {
      payload = JSON.parse(last.responseBody);
    } catch {
      return null;
    }
  }
  const detail =
    payload && typeof payload === "object" && "error" in payload
      ? payload.error
      : null;
  if (!detail || typeof detail !== "object") return null;
  const code = "code" in detail ? detail.code : null;
  const type = "type" in detail ? detail.type : null;
  // Copy no provider message, request body, response body or nested error into
  // durable state. These known quota failures need an account change, not repair.
  if (code === "project_spend_limit_exceeded")
    return new DomainError(
      503,
      "MODEL_PROJECT_SPEND_LIMIT",
      `${operation} cannot continue because the OpenAI project's spending limit was reached. Check that project's limit; adding account credit alone may not resolve it. Start a new operation after the limit is updated.`,
    );
  if (code === "insufficient_quota" || type === "insufficient_quota")
    return new DomainError(
      503,
      "MODEL_QUOTA_EXCEEDED",
      `${operation} cannot continue because OpenAI reports exhausted quota. Check account credit and project spending limits, then start a new operation.`,
    );
  return null;
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
    const quota = quotaFailure(error, operation);
    if (quota) throw quota;
    throw error;
  }
}
