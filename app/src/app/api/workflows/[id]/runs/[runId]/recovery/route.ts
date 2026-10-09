import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { RunRecoveryService } from "@/server/repairs/run-recovery-service";
import { startRecoveryInput } from "@/domain/run-recovery";
import { dispatchRepair } from "@/server/repairs/dispatch";
type Context = { params: Promise<{ id: string; runId: string }> };
export async function GET(_request: Request, { params }: Context) {
  return respond(async () => {
    const { id, runId } = await params;
    return new RunRecoveryService(await getDatabase()).state(
      parseId(id),
      parseId(runId),
    );
  });
}
export async function POST(request: Request, { params }: Context) {
  return respond(async () => {
    const { id, runId } = await params;
    const result = await new RunRecoveryService(await getDatabase()).start(
      parseId(id),
      parseId(runId),
      await body(request, startRecoveryInput),
    );
    await dispatchRepair(result.job);
    return result;
  }, 202);
}
