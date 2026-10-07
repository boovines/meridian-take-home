import { body, parseId, respond } from "@/server/http";
import { getDatabase } from "@/server/database";
import { RepairService } from "@/server/repairs/service";
import { startRepairInput } from "@/domain/repair";
import { dispatchRepair } from "@/server/repairs/dispatch";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () =>
    new RepairService(await getDatabase()).state(parseId((await params).id)),
  );
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(async () => {
    const result = await new RepairService(await getDatabase()).start(
      parseId((await params).id),
      await body(request, startRepairInput),
    );
    await dispatchRepair(result.job);
    return result;
  }, 202);
}
