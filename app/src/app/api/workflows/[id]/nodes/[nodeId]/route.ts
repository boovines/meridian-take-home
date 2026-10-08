import { service } from "@/server/canvas/service";
import { z } from "zod";
import { nodePatch } from "@/domain/canvas";
import { revisionSchema } from "@/domain/validation";
import { body, respond, parseId } from "@/server/http";
type Context = { params: Promise<{ id: string; nodeId: string }> };
export async function PATCH(request: Request, context: Context) {
  return respond(async () => {
    const { id, nodeId } = await context.params;
    return (await service()).editNode(
      parseId(id),
      parseId(nodeId),
      await body(request, nodePatch),
    );
  });
}
export async function DELETE(request: Request, context: Context) {
  return respond(async () => {
    const { id, nodeId } = await context.params;
    const data = await body(
      request,
      z.object({ expected_revision: revisionSchema }).strict(),
    );
    await (
      await service()
    ).deleteNode(parseId(id), parseId(nodeId), data.expected_revision);
    return { deleted: true };
  });
}
