import { BoardClient } from "@/components/canvas/board-client";
export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ review?: string }>;
}) {
  const { id } = await params;
  return (
    <BoardClient
      id={id}
      openRequests={(await searchParams).review === "requests"}
    />
  );
}
