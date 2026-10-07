import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { FindingService } from "@/server/reviews/finding-service";
import { messageInput } from "@/domain/review";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new FindingService(await getDatabase()).reply(
      parseId(p.id),
      parseId(p.threadId),
      await body(request, messageInput),
    );
  }, 201);
}
