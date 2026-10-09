import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { selectedEmailExecution } from "@/domain/grouped-execution";
import { GroupedExecutionService } from "@/server/grouped-execution/service";
import { dispatchGrouped } from "@/server/grouped-execution/dispatch";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context) {
  return respond(async () => {
    const spec = new URL(request.url).searchParams.get("spec");
    return new GroupedExecutionService(await getDatabase()).list(
      parseId((await params).id),
      spec ? parseId(spec) : undefined,
    );
  });
}
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    const job = await new GroupedExecutionService(await getDatabase()).start(
      parseId((await params).id),
      await body(request, selectedEmailExecution),
    );
    await dispatchGrouped(job);
    return job;
  }, 202);
}
