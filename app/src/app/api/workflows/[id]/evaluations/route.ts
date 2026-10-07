import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { EvaluationService } from "@/server/evaluations/evaluation-service";
import { startEvaluationInput } from "@/domain/evaluation";
import { dispatchEvaluation } from "@/server/evaluations/dispatch";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new EvaluationService(await getDatabase()).state(
      parseId((await params).id),
    ),
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const result = await new EvaluationService(await getDatabase()).start(
      parseId((await params).id),
      await body(request, startEvaluationInput),
    );
    await dispatchEvaluation(result.job);
    return result;
  }, 202);
}
