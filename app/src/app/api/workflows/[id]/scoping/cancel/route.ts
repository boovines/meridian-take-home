import { z } from "zod";
import { uuid } from "@/domain/validation";
import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ScopingService } from "@/server/scoping/service";
import { cancelScoping } from "@/server/scoping/dispatch";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const id = parseId((await params).id),
      data = await body(request, z.object({ operation_id: uuid }).strict());
    await cancelScoping(id, data.operation_id);
    return new ScopingService(await getDatabase()).state(id);
  });
}
