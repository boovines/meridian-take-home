import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { RunService } from "@/server/runtime/run-service";
import { startRunInput } from "@/domain/runtime";
import { dispatchExecution } from "@/server/runtime/dispatch";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new RunService(await getDatabase()).state(
      parseId((await params).id),
      undefined,
      new URL(request.url).searchParams.get("kind") === "manual"
        ? "manual"
        : undefined,
      new URL(request.url).searchParams.has("spec")
        ? parseId(new URL(request.url).searchParams.get("spec")!)
        : undefined,
    ),
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const result = await new RunService(await getDatabase()).start(
      parseId((await params).id),
      await body(request, startRunInput),
    );
    await dispatchExecution(result.job);
    return result;
  }, 202);
}
