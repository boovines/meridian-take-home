import { DomainError } from "../../domain/canvas";
import type { Method } from "../../domain/engineering";
import { stepResult, type Project } from "../../domain/project";
import type { Json, RuntimeError } from "../../domain/runtime";
export interface StepAdapters {
  invoke(
    project: Project,
    nodeId: string,
    context: Record<string, Json>,
    signal: AbortSignal,
  ): Promise<unknown>;
  reason(instructions: string, data: Json, signal: AbortSignal): Promise<Json>;
}
export async function invokeApprovedStep(
  project: Project,
  nodeId: string,
  method: Method,
  context: Record<string, Json>,
  adapters: StepAdapters,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (method === "human" && !Object.hasOwn(context, "human_response"))
    throw new DomainError(
      422,
      "HUMAN_RESPONSE_REQUIRED",
      "This step requires a fresh human response or verified scripted response.",
    );
  let result = stepResult.parse(
    await adapters.invoke(project, nodeId, context, signal),
  );
  if (result.kind === "reason") {
    if (method !== "agent")
      throw new DomainError(
        422,
        "METHOD_VIOLATION",
        "Only an approved Agent step can request model reasoning.",
      );
    const tool_result = await adapters.reason(
      result.instructions,
      result.data,
      signal,
    );
    result = stepResult.parse(
      await adapters.invoke(
        project,
        nodeId,
        { ...context, tool_result },
        signal,
      ),
    );
  }
  if (result.kind !== "complete")
    throw new DomainError(
      422,
      "METHOD_VIOLATION",
      "The step must complete after its single approved interaction.",
    );
  if (Buffer.byteLength(JSON.stringify(result)) > 128_000)
    throw new DomainError(
      422,
      "STEP_OUTPUT_TOO_LARGE",
      "Keep step output under 128 KB; use document artifacts for large payloads.",
    );
  return result;
}
export function invocationFailure(error: unknown): RuntimeError {
  const known = error instanceof DomainError,
    message =
      error instanceof Error ? error.message : "Step invocation failed.";
  const implementationCodes = [
    "STEP_CRASH",
    "METHOD_VIOLATION",
    "STEP_OUTPUT_TOO_LARGE",
    "STEP_INPUT_TOO_LARGE",
    "AGENT_CONTEXT_TOO_LARGE",
  ];
  const routeCode =
    /^(INVALID_ROUTES|AMBIGUOUS_ROUTE|NO_MATCHING_ROUTE|INVALID_OUTCOME):/.exec(
      message,
    )?.[1];
  const category =
    known && error.code === "HUMAN_RESPONSE_REQUIRED"
      ? "input"
      : routeCode ||
          (known && implementationCodes.includes(error.code)) ||
          (error instanceof Error && error.name === "ZodError")
        ? "implementation"
        : known &&
            ["SANDBOX_UNAVAILABLE", "MODEL_UNAVAILABLE"].includes(error.code)
          ? "infrastructure"
          : "unknown";
  return {
    code: known ? error.code : routeCode || "STEP_EXECUTION_FAILED",
    message: message.slice(0, 2000),
    category,
  };
}
