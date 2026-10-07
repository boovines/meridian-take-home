import { nodeInput } from "@/domain/canvas";
import { body, respond, service, parseId } from "@/server/http";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      (await service()).addNode(
        parseId((await context.params).id),
        await body(request, nodeInput),
      ),
    201,
  );
}
