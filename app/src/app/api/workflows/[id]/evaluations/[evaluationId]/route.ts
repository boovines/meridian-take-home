import { parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { EvaluationService } from "@/server/evaluations/evaluation-service";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; evaluationId: string }> },
) {
  return respond(async () => {
    const p = await params;
    return new EvaluationService(await getDatabase()).state(
      parseId(p.id),
      parseId(p.evaluationId),
    );
  });
}
