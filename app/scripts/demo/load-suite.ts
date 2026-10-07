import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getDatabase } from "../../src/server/database";
import { SuiteService } from "../../src/server/evaluations/suite-service";
import { caseInput } from "../../src/domain/evaluation";

// Operator input stays local. No shipment identifiers, email IDs, or expected totals are bundled here.
const manifestSchema = z
  .object({
    workflow_id: z.uuid(),
    name: z.string().min(1).max(200),
    cases: z
      .array(
        z
          .object({
            shipment_reference: z.string().min(1).max(200),
            input_bundle_id: z.uuid(),
            expected: z
              .object({
                invoices_processed: z.number().int().nonnegative(),
                invoices_succeeded: z.number().int().nonnegative(),
                invoices_failed: z.number().int().nonnegative(),
                goods_failed: z.number().int().nonnegative(),
                batches_processed: z.number().int().nonnegative(),
                batches_succeeded: z.number().int().nonnegative(),
                batches_failed: z.number().int().nonnegative(),
              })
              .strict()
              .refine(
                (t) =>
                  t.invoices_processed ===
                    t.invoices_succeeded + t.invoices_failed &&
                  t.batches_processed ===
                    t.batches_succeeded + t.batches_failed,
                "Processed totals must equal succeeded plus failed.",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--"))
  throw new Error(
    "Usage: npm run demo:suite -- <local-manifest.json> [--verified-and-lock]. Only use the flag after independently checking every expected answer.",
  );
nextEnv.loadEnvConfig(process.cwd());
const manifest = manifestSchema.parse(
  JSON.parse(await readFile(args[0], "utf8")),
);
if (
  new Set(manifest.cases.map((c) => c.shipment_reference)).size !==
  manifest.cases.length
)
  throw new Error("Each shipment must occur once in this suite.");
const db = await getDatabase();
try {
  const suites = new SuiteService(db);
  const suite = await suites.create(manifest.workflow_id, {
    request_key: randomUUID(),
    name: manifest.name,
    parent_suite_version_id: null,
  });
  for (const [index, row] of manifest.cases.entries()) {
    const item = await suites.addCase(
      manifest.workflow_id,
      suite.id,
      caseInput.parse({
        case_key: `shipment-${index + 1}`,
        name: row.shipment_reference,
        kind: "workflow",
        input_bundle_id: row.input_bundle_id,
        assertions: [
          {
            key: "identity",
            label: "Shipment identity",
            path: ["shipment_reference"],
            expected: row.shipment_reference,
          },
          ...Object.entries(row.expected).map(([key, expected]) => ({
            key,
            label: key.replaceAll("_", " "),
            path: ["totals", key],
            expected,
          })),
        ],
      }),
    );
    if (args.includes("--verified-and-lock"))
      await suites.verifyCase(manifest.workflow_id, suite.id, item.id, {
        expected_revision: item.revision,
      });
  }
  if (args.includes("--verified-and-lock")) {
    const current = (await suites.state(manifest.workflow_id)).suites.find(
      (s) => s.id === suite.id,
    )!;
    await suites.lock(manifest.workflow_id, suite.id, {
      expected_revision: current.revision,
    });
  }
  console.log(
    JSON.stringify({
      workflow_id: manifest.workflow_id,
      suite_id: suite.id,
      cases: manifest.cases.length,
      locked: args.includes("--verified-and-lock"),
    }),
  );
} finally {
  await db.close();
}
