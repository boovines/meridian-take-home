import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { answerGroupingQuestion } from "@/domain/grouped-execution";
import { GroupedExecutionService } from "@/server/grouped-execution/service";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; questionId: string }> },
) {
  return respond(async () => {
    const { id, questionId } = await params;
    return new GroupedExecutionService(await getDatabase()).answerQuestion(
      parseId(id),
      parseId(questionId),
      await body(request, answerGroupingQuestion),
    );
  });
}
