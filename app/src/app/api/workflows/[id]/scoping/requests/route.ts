import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ScopingService } from "@/server/scoping/service";
import { dispatchScoping } from "@/server/scoping/dispatch";
import { scopingRequest } from "@/domain/scoping";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const id = parseId((await params).id),
      service = new ScopingService(await getDatabase());
    const op = await service.request(id, await body(request, scopingRequest));
    await dispatchScoping(op);
    return service.state(id);
  }, 202);
}
