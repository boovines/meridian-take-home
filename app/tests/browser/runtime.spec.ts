import { test, expect } from "@playwright/test";
// UI journey with sanitized HTTP fixtures. Runtime persistence, routing and human gates
// are exercised independently in runtime.test.ts and live Temporal/Sandbox checks.
for (const interruptedAudit of [false, true])
  test(`captures a packet, records a human decision, previews a report, and retries with fresh approval (audit interrupted: ${interruptedAudit})`, async ({
    page,
  }, testInfo) => {
    const workflowId = crypto.randomUUID(),
      versionId = crypto.randomUUID(),
      specId = crypto.randomUUID(),
      bundleId = crypto.randomUUID(),
      nodeId = crypto.randomUUID(),
      jobId = crypto.randomUUID();
    const date = "2026-01-01T12:00:00Z",
      report = {
        recipient: interruptedAudit ? "" : "receiving@example.test",
        subject: "Shipment DEMO-100",
        body: "One invoice checked. Review complete.",
      };
    let draftsEnabled=false, draftCreates=0;
    let savedDraft: Record<string,unknown> | null=null;
    let captured = false,
      runs: Record<string, unknown>[] = [],
      answered = false,
      requestId = crypto.randomUUID();
    const auditId = crypto.randomUUID(),
      secondAuditId = crypto.randomUUID();
    let detailReads = 0,
      releaseFirst: () => void = () => {};
    const secondOpened = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let auditReads = 0,
      traceInterrupted = false;
    const state = () => ({
      initial_manual_version_id: versionId,
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
                ? { totals: { invoices_processed: 1 }, ...(interruptedAudit ? {preview:report} : {report}) }
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
      if (path.endsWith("/gmail-draft-settings")) {
        expect(request.postDataJSON()).toEqual({enabled:true});draftsEnabled=true;
        return route.fulfill({json:{enabled:true}});
      }
      if (path.endsWith("/gmail-draft")) {
        if(request.method()==="POST") {
          expect(request.postDataJSON()).toEqual({recipient:report.recipient});draftCreates++;
          savedDraft={state:"created",draft_id:"fixture-draft",recipient:report.recipient,subject:report.subject,body:report.body};
          return route.fulfill({json:savedDraft});
        }
        return route.fulfill({json:{eligible:true,enabled:draftsEnabled,reason:null,draft:savedDraft}});
      }
      if (path.endsWith("/engineering"))
        return route.fulfill({
          json: {
            workflow: {
              id: workflowId,
              name: "Shipment review",
              desired_outcome: "Inspect and preview a shipment report.",
            },
            specs: [{ id: specId, version_number: 1, created_at: date }],
            spec: {
              id: specId,
              version_number: 1,
              board: {
                workflow: {
                  id: workflowId,
                  name: "Shipment review",
                  desired_outcome: "Inspect and preview a shipment report.",
                },
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
        runs[0] = {
          ...runs[0],
          status: "completed",
          result_step_id: "outcome",
        };
        return route.fulfill({ json: { status: "answered" } });
      }
      if (path.endsWith("/runs")) {
        expect(url.searchParams.get("kind")).toBe("manual");
        return route.fulfill({ json: state() });
      }
      if (path.includes("/runs/")) {
        if (interruptedAudit && answered && !traceInterrupted) {
          traceInterrupted = true;
          return route.abort("internetdisconnected");
        }
        return route.fulfill({ json: state() });
      }
      if (path.endsWith("/audit-events")) {
        auditReads++;
        if (interruptedAudit && auditReads === 1)
          return route.abort("internetdisconnected");
        return route.fulfill({
          json: {
            events: [
              {
                id: auditId,
                kind: "model_response",
                attempt_token: "12345678-test",
                sequence: 3,
                summary: { elapsed_ms: 1200 },
              },
              {
                id: secondAuditId,
                kind: "final_output",
                attempt_token: "12345678-test",
                sequence: 4,
                summary: { elapsed_ms: 1300 },
              },
            ],
          },
        });
      }
      if (path.endsWith(`/audit-events/${secondAuditId}`)) {
        releaseFirst();
        return route.fulfill({
          json: { payload: { postprocessing: "complete" } },
        });
      }
      if (path.endsWith(`/audit-events/${auditId}`)) {
        detailReads++;
        if (interruptedAudit && detailReads === 1)
          return route.abort("internetdisconnected");
        await secondOpened;
        return route.fulfill({
          json: {
            payload: { delivery_date: "2026-10-09", source: "schedule.pdf" },
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: {
          error: {
            code: "NOT_FOUND",
            message: "Fixture has no source preview.",
          },
        },
      });
    });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`/workflows/${workflowId}/engineer`);
    await page.getByRole("button", { name: "Agent", exact: true }).click();
    await page
      .getByRole("button", { name: "Run workflow", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Saved input", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start run", exact: true }),
    ).toBeDisabled();
    await page.getByText("Capture from Gmail", { exact: true }).click();
    await page
      .getByRole("textbox", {
        name: "Search Gmail",
        exact: true,
      })
      .fill("DEMO-100");
    await page
      .getByRole("button", { name: "Search emails", exact: true })
      .click();
    await page
      .getByRole("checkbox", { name: /Documents for DEMO-100/ })
      .check();
    await page.getByText("Enter a reference manually", { exact: true }).click();
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
      page.getByRole("region", {
        name: "Human response required",
        exact: true,
      }),
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
    await page.getByRole("button",{name:"Enable Gmail drafts for this workflow",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"Recipient (optional)",exact:true})).toHaveValue(report.recipient);
    await page.getByRole("button",{name:"Create Gmail draft",exact:true}).click();
    await expect(page.getByText("Saved in Gmail Drafts. Repeating this action will not create another draft.")).toBeVisible();
    await expect(page.getByRole("button",{name:"Create Gmail draft",exact:true})).toHaveCount(0);
    expect(draftCreates).toBe(1);
    expect(auditReads).toBe(0);
    await page.getByText("Step history · 1 visits", { exact: true }).click();
    if (interruptedAudit) {
      await page
        .getByRole("button", { name: "Retry loading trace", exact: true })
        .click({ timeout: 5000 });
    }
    await page.getByText(/1\. Review shipment · visit 1 · completed/).click();
    await page.getByText("Execution audit", { exact: true }).click();
    if (interruptedAudit) {
      await expect(page.locator(".run-trace").getByRole("alert")).toBeVisible();
      await page
        .getByRole("button", { name: "Retry loading audit", exact: true })
        .click();
      await expect(page.locator(".run-trace").getByRole("alert")).toHaveCount(
        0,
      );
    }
    await page
      .getByText("Model response before postprocessing · 1200 ms", {
        exact: true,
      })
      .click();
    if (interruptedAudit) {
      await page
        .getByRole("button", {
          name: "Retry loading event details",
          exact: true,
        })
        .click();
    }
    await page
      .getByText("Generated postprocessing output · 1300 ms", { exact: true })
      .click();
    await expect(
      page.locator("pre").filter({ hasText: '"postprocessing"' }),
    ).toContainText("complete");
    await expect(
      page.locator("pre").filter({ hasText: "schedule.pdf" }),
    ).toContainText("2026-10-09");
    expect(auditReads).toBe(interruptedAudit ? 2 : 1);
    await page
      .locator(".run-trace")
      .screenshot({ path: testInfo.outputPath("execution-audit.png") });
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
      page.getByRole("region", {
        name: "Human response required",
        exact: true,
      }),
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
