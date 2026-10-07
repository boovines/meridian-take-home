import { z } from "zod";
import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { JobService } from "@/server/engineering/job-service";
import { dispatchOperation } from "@/server/workflows/dispatch";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  return respond(async () => {
    await body(request, z.object({}).strict());
    const p = await params;
    const job = await new JobService(await getDatabase()).requestCancel(
      parseId(p.id),
      parseId(p.jobId),
    );
    await dispatchOperation(job);
    return job;
  });
}
