import { service } from "@/server/canvas/service";
import { z } from "zod";
import { connectionPatch } from "@/domain/canvas";
import { revisionSchema } from "@/domain/validation";
import { body, respond, parseId } from "@/server/http";
type Context = { params: Promise<{ id: string; connectionId: string }> };
export async function PATCH(request: Request, context: Context) {
  return respond(async () => {
    const { id, connectionId } = await context.params;
    return (await service()).editConnection(
      parseId(id),
      parseId(connectionId),
      await body(request, connectionPatch),
    );
  });
}
export async function DELETE(request: Request, context: Context) {
  return respond(async () => {
    const { id, connectionId } = await context.params;
    const data = await body(
      request,
      z.object({ expected_revision: revisionSchema }).strict(),
    );
    await (
      await service()
    ).deleteConnection(
      parseId(id),
      parseId(connectionId),
      data.expected_revision,
    );
    return { deleted: true };
  });
}
