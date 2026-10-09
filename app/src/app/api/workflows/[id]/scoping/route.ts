import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ScopingService } from "@/server/scoping/service";
import { saveScopingNote } from "@/domain/scoping";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Context) {
  return respond(async () =>
    new ScopingService(await getDatabase()).state(parseId((await params).id)),
  );
}
export async function PATCH(request: Request, { params }: Context) {
  return respond(async () =>
    new ScopingService(await getDatabase()).saveNote(
      parseId((await params).id),
      await body(request, saveScopingNote),
    ),
  );
}
