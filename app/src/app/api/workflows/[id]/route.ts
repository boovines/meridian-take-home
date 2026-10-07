import { service } from "@/server/canvas/service";
import { workflowPatch } from "@/domain/canvas";
import { body, respond, parseId } from "@/server/http";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, context: Context) {
  return respond(async () =>
    (await service()).load(parseId((await context.params).id)),
  );
}
export async function PATCH(request: Request, context: Context) {
  return respond(async () =>
    (await service()).updateWorkflow(
      parseId((await context.params).id),
      await body(request, workflowPatch),
    ),
  );
}
