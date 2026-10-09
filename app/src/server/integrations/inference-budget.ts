import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, open, rename, rmdir, rm } from "node:fs/promises";
import { z } from "zod";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DomainError } from "../../domain/errors";
const chargeSchema = z.object({
  id: z.uuid(),
  provider: z.string().min(1),
  at: z.string().datetime(),
  reserved_usd: z.number().finite().positive(),
  actual_usd: z.number().finite().nonnegative().optional(),
  state: z.enum(["reserved", "settled"]),
  metadata: z.record(z.string(), z.unknown()),
}).strict().refine(c => c.state === "settled" ? c.actual_usd !== undefined : c.actual_usd === undefined);
const ledgerSchema = z.object({
  ceiling_usd: z.number().finite().positive(),
  charges: z.array(chargeSchema),
}).strict().refine(l => new Set(l.charges.map(c => c.id)).size === l.charges.length);
type Ledger = z.infer<typeof ledgerSchema>;
// Optional operator guard, shared by local app and worker processes via an atomic
// file lock. Unknown outcomes retain reservations, including after a restart.
export class InferenceBudget {
  constructor(
    private file: string,
    private ceiling: number,
  ) {
    if (!Number.isFinite(ceiling) || ceiling <= 0)
      throw new DomainError(503, "BUDGET_UNAVAILABLE", "Invalid inference budget ceiling.");
  }
  private async change<T>(
    f: (ledger: Ledger) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const until = Date.now() + 5000;
    while (true) {
      signal?.throwIfAborted();
      try {
        await mkdir(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > until)
          throw new DomainError(
            503,
            "BUDGET_UNAVAILABLE",
            "Inference budget is locked; no request was started.",
          );
        await delay(25, undefined, { signal });
      }
    }
    try {
      let ledger: Ledger;
      try {
        const parsed = ledgerSchema.safeParse(JSON.parse(await readFile(this.file, "utf8")));
        if (!parsed.success)
          throw new DomainError(503, "BUDGET_UNAVAILABLE", "The inference ledger is invalid; inspect it before continuing.");
        ledger = parsed.data;
      } catch (e) {
        if (e instanceof SyntaxError)
          throw new DomainError(503, "BUDGET_UNAVAILABLE", "The inference ledger is not valid JSON; inspect it before continuing.");
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        ledger = { ceiling_usd: this.ceiling, charges: [] };
      }
      if (ledger.ceiling_usd !== this.ceiling)
        throw new DomainError(
          503,
          "BUDGET_UNAVAILABLE",
          "Budget settings disagree with the existing ledger.",
        );
      const result = f(ledger),
        tmp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const file = await open(tmp, "wx", 0o600);
        try {
          await file.writeFile(JSON.stringify(ledger, null, 2));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(tmp, this.file);
        const directory = await open(dirname(this.file), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await rm(tmp, { force: true });
      }
      return result;
    } finally {
      await rmdir(lock);
    }
  }
  async reserve(
    provider: string,
    usd: number,
    metadata: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (!Number.isFinite(usd) || usd <= 0)
      throw new Error("Positive finite reservation required.");
    const id = randomUUID();
    await this.change((ledger) => {
      const used = ledger.charges.reduce(
        (sum, c) =>
          sum + (c.state === "settled" ? c.actual_usd! : c.reserved_usd),
        0,
      );
      if (!Number.isFinite(used) || used + usd > this.ceiling)
        throw new DomainError(
          503,
          "INFERENCE_BUDGET_LIMIT",
          "Reserved and recorded inference spend would exceed the configured ceiling.",
        );
      ledger.charges.push({
        id,
        provider,
        at: new Date().toISOString(),
        reserved_usd: usd,
        state: "reserved",
        metadata,
      });
    }, signal);
    return {
      id,
      settle: async (actual: number, details: Record<string, unknown> = {}) => {
        if (!Number.isFinite(actual) || actual < 0)
          throw new Error("Invalid reported usage.");
        return this.change((ledger) => {
          const charge = ledger.charges.find((c) => c.id === id);
          if (!charge || charge.state !== "reserved")
            throw new Error("Reservation already settled or missing.");
          charge.actual_usd = actual;
          charge.state = "settled";
          Object.assign(charge.metadata, details);
          if (actual > charge.reserved_usd)
            charge.metadata.exceeded_estimate = true;
        });
      },
      annotate: async (details: Record<string, unknown>) =>
        this.change((ledger) => {
          const charge = ledger.charges.find((c) => c.id === id)!;
          Object.assign(charge.metadata, details);
        }),
    };
  }
}
export type InferenceReservation = Awaited<
  ReturnType<InferenceBudget["reserve"]>
>;
export interface InferenceBudgetGuard {
  reserve(
    provider: string,
    usd: number,
    metadata: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<InferenceReservation>;
}
const budgetContext = new AsyncLocalStorage<InferenceBudgetGuard>();
export function withInferenceBudget<T>(
  budget: InferenceBudgetGuard,
  work: () => Promise<T>,
): Promise<T> {
  return budgetContext.run(budget, work);
}
export function configuredInferenceBudget(): InferenceBudgetGuard | null {
  const scoped = budgetContext.getStore();
  const operator = operatorBudget();
  if (!scoped) return operator;
  if (!operator) return scoped;
  return combineInferenceBudgets(scoped, operator);
}
export function combineInferenceBudgets(primary: InferenceBudgetGuard, secondary: InferenceBudgetGuard): InferenceBudgetGuard {
  return {
    async reserve(provider, usd, metadata, signal) {
      const first = await primary.reserve(provider, usd, metadata, signal);
      let second: InferenceReservation;
      try {
        second = await secondary.reserve(provider, usd, metadata, signal);
      } catch (error) {
        // The provider has not been called: release only this known unused hold.
        await first.settle(0, { secondary_reservation_rejected: true });
        throw error;
      }
      return {
        id: first.id,
        async settle(actual, details) {
          // Attempt both writes even if one store is unavailable. A failed write
          // conservatively retains its hold; it never grants more allowance.
          const results = await Promise.allSettled([
            first.settle(actual, details),
            second.settle(actual, details),
          ]);
          for (const result of results)
            if (result.status === "rejected") throw result.reason;
        },
        async annotate(details) {
          const results = await Promise.allSettled([
            first.annotate(details),
            second.annotate(details),
          ]);
          for (const result of results)
            if (result.status === "rejected") throw result.reason;
        },
      };
    },
  };
}
function operatorBudget() {
  const path = process.env.INFERENCE_BUDGET_LEDGER,
    limit = process.env.INFERENCE_BUDGET_USD;
  if (!path && !limit) return null;
  if (!path || !limit || !isAbsolute(path))
    throw new DomainError(
      503,
      "BUDGET_UNAVAILABLE",
      "Configure an absolute inference ledger path and a positive ceiling.",
    );
  return new InferenceBudget(path, Number(limit));
}
