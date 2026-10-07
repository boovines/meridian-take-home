import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { FindingService } from "@/server/reviews/finding-service";
import { noteInput } from "@/domain/review";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new FindingService(await getDatabase()).note(
        parseId((await params).id),
        await body(request, noteInput),
      ),
    201,
  );
}
