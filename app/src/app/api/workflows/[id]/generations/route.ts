import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { JobService } from "@/server/engineering/job-service";
import { dispatchGeneration } from "@/server/engineering/dispatch";
import { generateInput } from "@/domain/engineering";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const job = await new JobService(await getDatabase()).startGeneration(
      parseId((await params).id),
      await body(request, generateInput),
    );
    await dispatchGeneration(job);
    return job;
  }, 202);
}
