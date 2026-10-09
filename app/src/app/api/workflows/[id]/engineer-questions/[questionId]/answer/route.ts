import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { ClarificationService } from "@/server/repairs/clarification-service";
import { answerClarification } from "@/domain/clarification";
type Context = { params: Promise<{ id: string; questionId: string }> };
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    const { id, questionId } = await params;
    return new ClarificationService(await getDatabase()).answer(
      parseId(id), parseId(questionId), await body(request, answerClarification),
    );
  });
}
