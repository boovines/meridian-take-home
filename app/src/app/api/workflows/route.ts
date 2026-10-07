import { workflowInput } from "@/domain/canvas";
import { body, respond, service } from "@/server/http";
export const runtime = "nodejs";
export async function GET() {
  return respond(async () => (await service()).list());
}
export async function POST(request: Request) {
  return respond(
    async () => (await service()).create(await body(request, workflowInput)),
    201,
  );
}
