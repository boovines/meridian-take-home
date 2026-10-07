import { BoardClient } from "@/components/canvas/board-client";
export default async function WorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <BoardClient id={id} />;
}
