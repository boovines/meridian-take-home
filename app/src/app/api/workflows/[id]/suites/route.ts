import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { SuiteService } from "@/server/evaluations/suite-service";
import { createSuiteInput } from "@/domain/evaluation";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const suite = new URL(request.url).searchParams.get("suite");
    return new SuiteService(await getDatabase()).state(
      parseId((await params).id),
      suite ? parseId(suite) : undefined,
    );
  });
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(
    async () =>
      new SuiteService(await getDatabase()).create(
        parseId((await params).id),
        await body(request, createSuiteInput),
      ),
    201,
  );
}
