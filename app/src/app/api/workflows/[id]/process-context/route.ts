import { processContextService } from "@/server/process-context/service";
import { saveProcessContext } from "@/domain/process-context";
import { body, respond, parseId } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, context: Context) {
  return respond(async () =>
    (await processContextService()).load(parseId((await context.params).id)),
  );
}
export async function PUT(request: Request, context: Context) {
  return respond(async () =>
    (await processContextService()).save(
      parseId((await context.params).id),
      await body(request, saveProcessContext),
    ),
  );
}
