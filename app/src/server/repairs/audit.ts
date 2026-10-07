import { DomainError } from "../../domain/errors";
import type { ExecutionAuditService } from "../runtime/audit-service";
export type ReadRepairAudit = (id: string, path: string[]) => Promise<unknown>;
export class RepairAuditReader {
  private reads = 0;
  readonly inspected: { event_id: string; path: string[] }[] = [];
  constructor(
    private workflowId: string,
    private allowed: Set<string>,
    private audit: Pick<ExecutionAuditService, "read">,
    private signal: AbortSignal,
  ) {}
  read: ReadRepairAudit = async (id, path) => {
    this.signal.throwIfAborted();
    if (!this.allowed.has(id))
      throw new DomainError(
        422,
        "AUDIT_ACCESS_DENIED",
        "Select an audit event supplied with this repair context.",
      );
    if (this.reads++ >= 3)
      throw new DomainError(
        422,
        "AUDIT_READ_LIMIT",
        "At most three audit inspections are available per attempt.",
      );
    const { event, payload } = await this.audit.read(this.workflowId, id);
    this.signal.throwIfAborted();
    let value = payload;
    for (const key of path) {
      if (
        value === null ||
        typeof value !== "object" ||
        !Object.hasOwn(value, key)
      )
        return { event_id: id, path, missing: true };
      value = (value as Record<string, unknown>)[key];
    }
    this.inspected.push({ event_id: id, path: [...path] });
    const text = JSON.stringify(value),
      bytes = Buffer.byteLength(text);
    return {
      event_id: id,
      kind: event.kind,
      path,
      missing: false,
      ...(bytes > 48000
        ? {
            truncated: true,
            original_bytes: bytes,
            json_preview: Buffer.from(text).subarray(0, 48000).toString("utf8"),
          }
        : { truncated: false, value }),
    };
  };
}
