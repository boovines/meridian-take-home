import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ReplyService } from "@/server/reviews/reply-service";
import { messageInput } from "@/domain/review";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; threadId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new ReplyService(await getDatabase()).reply(
      parseId(p.id),
      parseId(p.threadId),
      await body(request, messageInput),
      AbortSignal.any([request.signal, AbortSignal.timeout(90000)]),
    );
  }, 201);
}

export const maxDuration = 120;
