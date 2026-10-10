import { test, expect } from "@playwright/test";
test("capture progress, unavailable evidence and actionable failure survive reload", async ({
  page,
}) => {
  const w = crypto.randomUUID(),
    spec = crypto.randomUUID(),
    job = crypto.randomUUID(),
    version = crypto.randomUUID(),
    date = "2026-01-01T12:00:00Z";
  let failed = false;
  const parent = () => ({
    id: job,
    workflow_id: w,
    kind: "grouped",
    status: failed ? "failed" : "running",
    phase: failed ? "needs attention" : "capturing email sources",
    created_at: date,
    source_request: { message_ids: ["abcdef0123456789", "abcdef0123456780"] },
    error_message: failed
      ? "Could not capture email abcdef0123456780. Completed downloads are retained. Check Gmail access or try a smaller selection."
      : null,
    progress: {
      capture: {
        messages_total: 2,
        messages_completed: 2,
        attachments_total: 3,
        attachments_completed: 1,
        attachments_unavailable: 1,
        warnings: [
          {
            message_id: "abcdef0123456789",
            name: "order.pdf",
            reason: "Attachment download timed out after two attempts.",
          },
        ],
      },
    },
  });
  await page.route(`**/api/workflows/${w}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith("/engineering"))
      return route.fulfill({
        json: {
          workflow: { id: w, name: "Capture regression" },
          specs: [{ id: spec, version_number: 1, created_at: date }],
          spec: {
            id: spec,
            version_number: 1,
            board: {
              workflow: {
                id: w,
                name: "Capture regression",
                desired_outcome: "Preview purchase orders",
              },
              nodes: [
                { id: "trigger", type: "trigger", title: "Email" },
                { id: "outcome", type: "outcome", title: "Preview" },
              ],
              connections: [],
            },
          },
          plans: [],
          steps: [],
          versions: [{ id: version, version_number: 1, created_at: date }],
          jobs: [parent()],
        },
      });
    if (p.endsWith("/grouped-executions"))
      return route.fulfill({ json: [parent()] });
    if (p.endsWith(`/grouped-executions/${job}`))
      return route.fulfill({
        json: {
          job: parent(),
          record: {
            input_bundle_id: null,
            limits: { spend_usd: 5, active_ms: 3600000 },
            active_elapsed_ms: 45000,
          },
          jobs: [],
          executions: [],
          children: [],
          child_history: [],
          decision: null,
          grouping: null,
          aggregate: null,
          questions: [],
          coverage: null,
          spent_or_reserved_usd: 0,
          completed_groups: 0,
          failed_groups: 0,
        },
      });
    if (p.includes("/versions/"))
      return route.fulfill({
        json: {
          version: { id: version, version_number: 1 },
          changes: [],
          project: {
            files: { "workflow.js": "// Fixture" },
            node_file_map: {},
            generator: { summary: "Fixture" },
          },
          evaluation: null,
          build_check_status: "passed",
        },
      });
    return route.fulfill({ json: [] });
  });
  async function open() {
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page
      .getByRole("button", { name: "Run workflow", exact: true })
      .click();
  }
  await page.goto(`/workflows/${w}/engineer`);
  await open();
  const progress = page.getByRole("status", { name: "Email capture progress" });
  await expect(progress).toContainText(
    "2 of 2 emails captured · 1 of 3 attachments downloaded · 1 unavailable",
  );
  await expect(progress).toContainText(
    "order.pdf: Attachment download timed out after two attempts.",
  );
  await expect(progress).toContainText(
    "Completed downloads are saved across automatic retries",
  );
  failed = true;
  await page.reload();
  await open();
  await expect(progress).toContainText("1 unavailable");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Could not capture email" })
      .first(),
  ).toBeVisible();
});
