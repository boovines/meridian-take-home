import { test, expect } from "@playwright/test";
// UI journey with sanitized HTTP fixtures. Runtime persistence, routing and human gates
// are exercised independently in runtime.test.ts and live Temporal/Sandbox checks.
test("captures a packet, records a human decision, previews a report, and retries with fresh approval", async ({
  page,
}, testInfo) => {
  const workflowId = crypto.randomUUID(),
    versionId = crypto.randomUUID(),
    bundleId = crypto.randomUUID(),
    nodeId = crypto.randomUUID(),
    jobId = crypto.randomUUID();
  const date = "2026-01-01T12:00:00Z",
    report = {
      recipient: "receiving@example.test",
      subject: "Shipment DEMO-100",
      body: "One invoice checked. Review complete.",
    };
  let captured = false,
    runs: Record<string, unknown>[] = [],
    answered = false,
    requestId = crypto.randomUUID();
  const state = () => ({
    runs,
    steps: runs.length
      ? [
          {
            id: "outcome",
            run_id: runs[0].id,
            node_id: nodeId,
            occurrence_number: 1,
            node_visit_number: 1,
            status: answered ? "completed" : "waiting_for_human",
            input_step_refs: {},
            output_data: answered
              ? { totals: { invoices_processed: 1 }, report }
              : null,
          },
        ]
      : [],
    human_requests: runs.length
      ? [
          {
            id: requestId,
            run_id: runs[0].id,
            step_execution_id: "outcome",
            response_type: "approval",
            prompt: "Review this packet before continuing.",
            status: answered ? "answered" : "pending",
            response: answered
              ? { type: "approval", approved: true, text: "Reviewed" }
              : null,
            response_source: answered ? "human" : null,
          },
        ]
      : [],
  });
  await page.route(`**/api/workflows/${workflowId}/**`, async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path.endsWith("/engineering"))
      return route.fulfill({
        json: {
          workflow: {
            id: workflowId,
            name: "Shipment review",
            desired_outcome: "Inspect and preview a shipment report.",
          },
          spec: {
            id: crypto.randomUUID(),
            board: {
              nodes: [{ id: nodeId, title: "Review shipment" }],
              connections: [],
            },
          },
          plans: [],
          steps: [],
          versions: [{ id: versionId, version_number: 1, created_at: date }],
          jobs:
            runs.length && !answered
              ? [
                  {
                    id: jobId,
                    kind: "execution",
                    status: "waiting_for_human",
                    phase: "waiting for a response",
                    created_at: date,
                  },
                ]
              : [],
        },
      });
    if (path.endsWith("/input-bundles"))
      return route.fulfill({
        json: captured
          ? [
              {
                id: bundleId,
                shipment_reference: "DEMO-100",
                source_kind: "gmail",
                created_at: date,
              },
            ]
          : [],
      });
    if (path.endsWith("/gmail/messages"))
      return route.fulfill({
        json: {
          messages: [
            {
              id: "1234567890abcdef",
              thread_id: "thread",
              subject: "Documents for DEMO-100",
              sender: "supplier@example.test",
              received_at: date,
            },
          ],
          next_page_token: null,
        },
      });
    if (path.endsWith("/gmail/capture")) {
      expect(request.postDataJSON()).toEqual({
        message_ids: ["1234567890abcdef"],
        shipment_reference: "DEMO-100",
      });
      captured = true;
      return route.fulfill({ json: { id: bundleId } });
    }
    if (path.endsWith("/runs") && request.method() === "POST") {
      const data = request.postDataJSON();
      expect(data.input_bundle_id).toBe(bundleId);
      expect(data.implementation_version_id).toBe(versionId);
      expect(data.rerun_of_id).toBe(runs[0]?.id || null);
      const old = runs;
      answered = false;
      requestId = crypto.randomUUID();
      runs = [
        {
          id: crypto.randomUUID(),
          workflow_id: workflowId,
          job_id: jobId,
          implementation_version_id: versionId,
          input_bundle_id: bundleId,
          kind: "manual",
          status: "waiting_for_human",
          rerun_of_id: old[0]?.id || null,
          limits: { step_attempts: 100, active_ms: 900000 },
          created_at: date,
          active_elapsed_ms: 0,
        },
        ...old,
      ];
      return route.fulfill({ status: 202, json: { run: runs[0] } });
    }
    if (path.includes("/human-requests/") && path.endsWith("/answer")) {
      expect(path).toContain(requestId);
      expect(request.postDataJSON().response).toEqual({
        type: "approval",
        approved: true,
        text: "Reviewed",
      });
      answered = true;
      runs[0] = { ...runs[0], status: "completed", result_step_id: "outcome" };
      return route.fulfill({ json: { status: "answered" } });
    }
    if (path.endsWith("/runs")) {
      expect(url.searchParams.get("kind")).toBe("manual");
      return route.fulfill({ json: state() });
    }
    if (path.includes("/runs/")) return route.fulfill({ json: state() });
    return route.fulfill({
      status: 404,
      json: {
        error: { code: "NOT_FOUND", message: "Fixture has no source preview." },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/workflows/${workflowId}/engineer`);
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await page.getByRole("button", { name: "Run workflow", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeDisabled();
  await page.getByText("Capture from Gmail", { exact: true }).click();
  await page
    .getByRole("textbox", {
      name: "Shipment number or Gmail search",
      exact: true,
    })
    .fill("DEMO-100");
  await page
    .getByRole("button", { name: "Search emails", exact: true })
    .click();
  await page.getByRole("checkbox", { name: /Documents for DEMO-100/ }).check();
  await page
    .getByRole("textbox", { name: "Shipment reference", exact: true })
    .fill("DEMO-100");
  await page
    .getByRole("button", { name: "Capture 1 email", exact: true })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Captured input", exact: true })
      .locator("option:checked"),
  ).toContainText("DEMO-100");
  await page.getByRole("button", { name: "Start run", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Human response required", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start run", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Decision note (optional)", exact: true })
    .fill("Reviewed");
  await page
    .getByRole("button", { name: "Approve and resume", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Report preview", exact: true }),
  ).toContainText("Not sent");
  await expect(
    page.getByRole("region", { name: "Report preview", exact: true }),
  ).toContainText(report.body);
  await expect(page.getByRole("button", { name: /Send report/ })).toHaveCount(
    0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page
      .locator(".run-sidebar-grid")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("run-report-narrow.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Retry same inputs", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Human response required", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", {
      name: "Decision note (optional)",
      exact: true,
    }),
  ).toHaveValue("");
  expect(runs).toHaveLength(2);
  expect(errors).toEqual([]);
});
