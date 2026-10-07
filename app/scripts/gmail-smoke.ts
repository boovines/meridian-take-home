import nextEnv from "@next/env";
import { getDatabase } from "../src/server/database";
import { CanvasService } from "../src/server/canvas/service";
import { GmailCaptureService } from "../src/server/inputs/gmail-capture";
import { gmailReader } from "../src/server/integrations/composio-gmail";
import { ArtifactService } from "../src/server/artifacts/service";
import { reasonForStep } from "../src/server/integrations/openai-step";
nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2),
  flag = (name: string) => args[args.indexOf(name) + 1];
if (
  !args.includes("--live") ||
  !args.includes("--message") ||
  !args.includes("--shipment")
)
  throw new Error(
    "Usage: npm run gmail:smoke -- --live --message <message-id> --shipment <reference> [--pdf <filename>]",
  );
const db = await getDatabase();
try {
  const w = await new CanvasService(db).create({
    name: "Live Gmail capture check",
    desired_outcome:
      "Capture a supplied shipment packet without changing the mailbox.",
  });
  const bundle = await new GmailCaptureService(db, gmailReader()).capture(
    w.id,
    {
      message_ids: [flag("--message")],
      shipment_reference: flag("--shipment"),
    },
    AbortSignal.timeout(240000),
  );
  const manifest = bundle.manifest as {
    input: { documents: { artifact_id: string; name: string }[] };
  };
  console.log(
    JSON.stringify({
      workflow_id: w.id,
      bundle_id: bundle.id,
      documents: manifest.input.documents.length,
    }),
  );
  if (args.includes("--pdf")) {
    const doc = manifest.input.documents.find((d) => d.name === flag("--pdf"));
    if (!doc) throw new Error("Selected PDF was not captured.");
    const { artifact, bytes } = await new ArtifactService(db).read(
      w.id,
      doc.artifact_id,
    );
    if (artifact.media_type !== "application/pdf")
      throw new Error("Select a PDF.");
    const result = await reasonForStep(
      "Read the supplied PDF. Return JSON with document_type, invoice_number if present, page_count, and a list of drug descriptions if it is a commercial invoice. Preserve text exactly; use null when absent. This checks document access, not shipment validation.",
      {},
      AbortSignal.timeout(120000),
      [
        {
          artifact_id: artifact.id,
          name: artifact.display_name,
          media_type: artifact.media_type,
          bytes,
        },
      ],
    );
    console.log(JSON.stringify({ document_interpretation: result }));
  }
} finally {
  await db.close();
}
