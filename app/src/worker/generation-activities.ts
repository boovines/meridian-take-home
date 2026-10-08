import { heartbeat, cancellationSignal } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DomainError } from "../domain/errors";
import { getDatabase } from "../server/database";
import { GenerationService } from "../server/engineering/generation-service";
import { JobService } from "../server/engineering/job-service";
import {
  engineeringModel,
  generateProjectSources,
} from "../server/integrations/openai-engineer";
import { validateInSandbox } from "../server/integrations/sandbox-project";
export async function generateImplementation(id: string) {
  const pulse = setInterval(() => heartbeat(), 5000);
  try {
    heartbeat();
    await new GenerationService(await getDatabase()).run(
      id,
      {
        model: engineeringModel(),
        generate: (context, seed, signal) =>
          generateProjectSources(
            context.spec.board,
            context.steps,
            seed,
            signal,
          ),
        validate: validateInSandbox,
      },
      AbortSignal.any([
        cancellationSignal(),
        AbortSignal.timeout(15 * 60 * 1000),
      ]),
    );
  } catch (error) {
    console.warn("Generation adapter failure", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: error instanceof DomainError ? error.code : "PROVIDER_OR_STORAGE",
    });
    if (error instanceof DomainError) {
      await new JobService(await getDatabase()).finish(
        id,
        error.code === "JOB_CANCELLED" ? "cancelled" : "failed",
        { code: error.code, message: error.message },
      );
    }
    throw ApplicationFailure.create({
      message: "Generation could not complete.",
      type: "GenerationFailure",
      nonRetryable: error instanceof DomainError,
    });
  } finally {
    clearInterval(pulse);
  }
}
export async function endGeneration(
  id: string,
  status: "failed" | "cancelled",
) {
  await new JobService(await getDatabase()).finish(
    id,
    status,
    status === "failed"
      ? {
          code: "GENERATION_FAILED",
          message:
            "The generation worker could not finish. Inspect service access and try a new generation.",
        }
      : undefined,
  );
}
