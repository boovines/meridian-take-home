import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { HumanService } from "@/server/runtime/human-service";
import { answerInput } from "@/domain/runtime";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; requestId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new HumanService(await getDatabase()).answer(
      parseId(p.id),
      parseId(p.requestId),
      await body(request, answerInput),
    );
  });
}
