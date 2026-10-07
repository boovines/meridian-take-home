import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { FreezeService } from "@/server/reviews/freeze-service";
import { freezeInput } from "@/domain/review";
type Context = { params: Promise<{ id: string }> };
export async function GET(_: Request, { params }: Context) {
  return respond(async () =>
    new FreezeService(await getDatabase()).readiness(
      parseId((await params).id),
    ),
  );
}
export async function POST(request: Request, { params }: Context) {
  return respond(async () =>
    new FreezeService(await getDatabase()).freeze(
      parseId((await params).id),
      await body(request, freezeInput),
    ),
  );
}
