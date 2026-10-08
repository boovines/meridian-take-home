import { it, expect, vi } from "vitest";
import { RepairAuditReader } from "../src/server/repairs/audit";
import type { AuditEvent } from "../src/domain/execution-audit";
it("authorizes exact evidence, supports narrow JSON paths and bounds concurrent inspections", async () => {
  const read = vi.fn(async () => ({
    event: { kind: "model_response" } as AuditEvent,
    payload: { records: [{ value: "original" }], large: "x".repeat(49000) },
  }));
  const reader = new RepairAuditReader(
    "workflow",
    new Set(["allowed"]),
    { read },
    AbortSignal.timeout(10000),
  );
  await expect(reader.read("foreign", [])).rejects.toMatchObject({
    code: "AUDIT_ACCESS_DENIED",
  });
  expect(read).not.toHaveBeenCalled();
  expect(await reader.read("allowed", ["records", "0"])).toMatchObject({
    value: { value: "original" },
    truncated: false,
  });
  expect(await reader.read("allowed", ["large"])).toMatchObject({
    truncated: true,
    original_bytes: 49002,
  });
  const attempts = await Promise.allSettled([
    reader.read("allowed", ["__proto__"]),
    reader.read("allowed", []),
  ]);
  expect(attempts[0]).toMatchObject({
    status: "fulfilled",
    value: { missing: true },
  });
  expect(attempts[1]).toMatchObject({
    status: "rejected",
    reason: { code: "AUDIT_READ_LIMIT" },
  });
  expect(read).toHaveBeenCalledWith("workflow", "allowed");
  expect(reader.inspected).toEqual([
    { event_id: "allowed", path: ["records", "0"] },
    { event_id: "allowed", path: ["large"] },
  ]);
});
