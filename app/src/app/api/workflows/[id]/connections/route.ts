import { service } from "@/server/canvas/service";
import { connectionInput } from "@/domain/canvas";
import { body, respond, parseId } from "@/server/http";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      (await service()).addConnection(
        parseId((await context.params).id),
        await body(request, connectionInput),
      ),
    201,
  );
}
