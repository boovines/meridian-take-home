import { test, expect } from "@playwright/test";
// Sanitized HTTP journey: worker/persistence behavior is covered by grouped-runtime
// and grouped-worker tests. This verifies the UI's requests, labels and recovery views.
for (const ending of ["complete", "cancel"] as const)
  test(`selected-email runs preserve group context through clarification, reload and ${ending}`, async ({
    page,
  }, testInfo) => {
    const w = crypto.randomUUID(),
      spec = crypto.randomUUID(),
      v1 = crypto.randomUUID(),
      v2 = crypto.randomUUID(),
      job = crypto.randomUUID(),
      trigger = crypto.randomUUID(),
      approval = crypto.randomUUID(),
      outcome = crypto.randomUUID(),
      question = crypto.randomUUID(),
      human = crypto.randomUUID();
    const date = "2026-01-01T12:00:00Z";
    let started = false,
      answered = false,
      approved = false,
      stopped = false,
      starts = 0;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const parent = () => ({
      id: job,
      workflow_id: w,
      kind: "grouped",
      status: stopped ? "cancelled" : approved ? "failed" : "waiting_for_human",
      phase: stopped
        ? "cancelled"
        : approved
          ? "partial results"
          : "waiting for clarification",
      created_at: date,
      source_request: { message_ids: ["abcdef01", "abcdef02"] },
      error_message: approved
        ? "One group needs attention. Completed results are retained."
        : null,
    });
    const report = {
      report: {
        subject: "Purchase review summary",
        body: "Purchase A completed. Purchase B requires manual follow-up.",
      },
    };
    const execution = (key: string) => ({
      source_job_id: `job-${key}`,
      source_run_id: `source-${key}`,
      run: {
        id: `run-${key}`,
        job_id: `job-${key}`,
        implementation_version_id: key === "A" ? v2 : v1,
        workflow_id: w,
        kind: "manual",
        execution_mode:
          key === "grouping"
            ? "grouping"
            : key === "aggregate"
              ? "aggregate"
              : "workflow",
        status:
          key === "B"
            ? stopped
              ? "cancelled"
              : approved
                ? "needs_attention"
                : "waiting_for_human"
            : "completed",
        result_step_id: `step-${key}`,
        active_elapsed_ms: 2000,
        failure_message:
          key === "B" && approved
            ? "Required supplier information is unavailable."
            : null,
      },
      version_number: key === "A" ? 2 : 1,
      output:
        key === "aggregate" ? report : { reference: key, decision: "Approved" },
      recovery:
        key === "A"
          ? {
              id: "recovery-A",
              job_id: "repair-A",
              status: "recovered",
              stop_reason: null,
            }
          : null,
      active_job: {
        id: `job-${key}`,
        kind: "execution",
        status:
          key === "B"
            ? stopped
              ? "cancelled"
              : approved
                ? "failed"
                : "waiting_for_human"
            : "succeeded",
        phase: key === "B" ? "waiting for approval" : "completed",
      },
      terminal: key !== "B" || approved || stopped,
      completed: key !== "B",
    });
    const children = () =>
      ["A", "B"].map((key) => ({
        id: `child-${key}`,
        group_key: key,
        label: `Purchase ${key}`,
        job_id: `job-${key}`,
        input_bundle_id: `input-${key}`,
        execution: execution(key),
      }));
    const grouped = () => ({
      job: parent(),
      record: {
        limits: { spend_usd: 5, active_ms: 3600000 },
        active_elapsed_ms: 4000,
      },
      jobs: [],
      executions: [
        "A",
        "B",
        "grouping",
        ...(approved ? ["aggregate"] : []),
      ].map(execution),
      children: children(),
      child_history: children().map((c) => ({
        id: c.id,
        group_key: c.group_key,
        label: c.label,
        job_id: c.job_id,
        input_bundle_id: c.input_bundle_id,
      })),
      decision: {
        id: "decision",
        sequence: 1,
        result: {
          groups: [
            { key: "A", label: "Purchase A" },
            { key: "B", label: "Purchase B" },
          ],
          assignments: [
            {
              source_id: "message:abcdef01",
              targets: [
                {
                  group_key: "A",
                  scope: "Purchase A section",
                  reason: "Explicit reference",
                },
              ],
              unresolved: answered
                ? null
                : {
                    scope: "Delivery address",
                    question: "Which purchase uses the new address?",
                  },
              exclusion_reason: null,
            },
            {
              source_id: "message:abcdef02",
              targets: [
                {
                  group_key: "B",
                  scope: "Purchase B section",
                  reason: "Explicit reference",
                },
              ],
              unresolved: null,
              exclusion_reason: null,
            },
          ],
        },
      },
      grouping: execution("grouping"),
      aggregate: approved ? execution("aggregate") : null,
      questions: [
        {
          id: question,
          status: answered ? "answered" : "open",
          question: "Which purchase uses the new address?",
          scope: "Delivery address",
          answer: answered ? "Purchase B" : null,
        },
      ],
      coverage: {
        source_count: 2,
        assigned_count: 2,
        excluded_count: 0,
        needs_clarification_count: answered ? 0 : 1,
      },
      spent_or_reserved_usd: 0.13,
      completed_groups: 1,
      failed_groups: approved || stopped ? 1 : 0,
    });
    await page.route(`**/api/workflows/${w}/**`, async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname;
      if (p.endsWith("/engineering"))
        return route.fulfill({
          json: {
            workflow: {
              id: w,
              name: "Grouped purchase review",
              desired_outcome: "Review every independent request.",
            },
            specs: [{ id: spec, version_number: 1, created_at: date }],
            spec: {
              id: spec,
              version_number: 1,
              board: {
                workflow: {
                  id: w,
                  name: "Grouped purchase review",
                  desired_outcome: "Review every independent request.",
                },
                nodes: [
                  { id: trigger, type: "trigger", title: "Read requests" },
                  {
                    id: approval,
                    type: "human_approval",
                    title: "Approve purchase",
                  },
                  { id: outcome, type: "outcome", title: "Preview report" },
                ],
                connections: [],
              },
            },
            plans: [],
            steps: [],
            versions: [
              { id: v1, version_number: 1, created_at: date },
              { id: v2, version_number: 2, created_at: date },
            ],
            jobs: started ? [parent()] : [],
          },
        });
      if (p.endsWith("/gmail/messages"))
        return route.fulfill({
          json: {
            messages: ["abcdef01", "abcdef02"].map((id, i) => ({
              id,
              subject: `Purchase request ${i + 1}`,
              sender: "supplier@example.test",
              received_at: date,
            })),
            next_page_token: null,
          },
        });
      if (p.endsWith("/grouped-executions")) {
        if (req.method() === "GET") {
          expect(url.searchParams.get("spec")).toBe(spec);
          return route.fulfill({ json: started ? [parent()] : [] });
        }
        expect(req.postDataJSON()).toMatchObject({
          implementation_version_id: v1,
          message_ids: ["abcdef01", "abcdef02"],
        });
        expect(req.postDataJSON()).not.toHaveProperty("shipment_reference");
        expect(req.postDataJSON().request_key).toBeTruthy();
        started = true;
        starts++;
        return route.fulfill({ status: 202, json: parent() });
      }
      if (p.endsWith(`/grouped-executions/${job}`))
        return route.fulfill({ json: grouped() });
      if (p.endsWith(`/grouping-questions/${question}/answer`)) {
        expect(req.postDataJSON().answer).toBe("Purchase B");
        answered = true;
        return route.fulfill({ json: {} });
      }
      if (p.endsWith(`/human-requests/${human}/answer`)) {
        expect(req.postDataJSON().response).toMatchObject({
          type: "approval",
          approved: true,
          text: "Checked purchase B",
        });
        approved = true;
        return route.fulfill({ json: {} });
      }
      if (p.endsWith(`/jobs/${job}/cancel`)) {
        stopped = true;
        return route.fulfill({ json: parent() });
      }
      if (p.includes("/runs/")) {
        const key = p.split("/").at(-1)!.replace("run-", ""),
          e = execution(key);
        return route.fulfill({
          json: {
            runs: [e.run],
            recovery: null,
            steps: [
              {
                id: `step-${key}`,
                node_id: outcome,
                occurrence_number: 1,
                node_visit_number: 1,
                status: e.run.status,
                output_data: e.output,
                input_step_refs: {},
              },
            ],
            human_requests:
              key === "B" && !approved && !stopped
                ? [
                    {
                      id: human,
                      response_type: "approval",
                      prompt: "Approve Purchase B",
                      status: "pending",
                    },
                  ]
                : [],
          },
        });
      }
      if (p.endsWith("/audit-events")) return route.fulfill({ json: [] });
      if (p.includes("/versions/")) {
        const versionId = p.split("/").at(-1)!;
        return route.fulfill({
          json: {
            version: {
              id: versionId,
              version_number: versionId === v2 ? 2 : 1,
            },
            changes: [{ path: "workflow.js", status: "added" }],
            project: {
              files: { "workflow.js": "// Purchase implementation" },
              node_file_map: {},
              generator: { summary: "Fixture purchase implementation" },
            },
            evaluation: null,
            build_check_status: "passed",
          },
        });
      }
      return route.fulfill({
        status: 404,
        json: { error: { message: `Unexpected fixture route ${p}` } },
      });
    });
    async function open() {
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      await page
        .getByRole("button", { name: "Run workflow", exact: true })
        .click();
    }
    await page.goto(`/workflows/${w}/engineer`);
    await open();
    await expect(page.getByLabel("Implementation to run")).toHaveValue("");
    await page.getByLabel("Implementation to run").selectOption(v1);
    await expect(
      page.getByLabel("Shipment reference", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Search emails", exact: true })
      .click();
    for (const name of ["Purchase request 1", "Purchase request 2"])
      await page.getByRole("checkbox", { name: new RegExp(name) }).check();
    await page
      .getByRole("button", { name: "Run selected emails", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "2 emails · 2 groups" }),
    ).toBeVisible();
    await page.getByRole("button", { name: /Purchase A Code v2/ }).click();
    await expect(
      page
        .getByRole("region", { name: "Inspect Purchase A" })
        .getByText(
          "Code v2 · Execution complete · business results unverified",
          { exact: true },
        ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Inspect code", exact: true })
      .click();
    await expect(page.getByLabel("Code version", { exact: true })).toHaveValue(
      v2,
    );
    await page
      .getByRole("button", { name: "Run workflow", exact: true })
      .click();
    await page.getByLabel("Your answer", { exact: true }).fill("Purchase B");
    await page
      .getByRole("button", { name: "Save answer", exact: true })
      .click();
    await expect(
      page.getByText("Answer saved. The workflow will continue."),
    ).toBeVisible();
    await page.reload();
    await open();
    await expect(
      page.getByRole("heading", { name: "2 emails · 2 groups" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your answer", { exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: /Purchase B Code v1/ }).click();
    await expect(
      page.getByRole("button", { name: "Approve and resume" }),
    ).toBeVisible();
    if (ending === "complete") {
      await page
        .getByLabel("Decision note (optional)")
        .fill("Checked purchase B");
      await page.getByRole("button", { name: "Approve and resume" }).click();
      await expect(
        page.getByText(report.report.body, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: /Purchase B Code v1 Needs attention/,
        }),
      ).toBeVisible();
    } else {
      await page
        .getByRole("button", { name: "Cancel email run", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Cancel email run", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /Purchase A Code v2.*Completed/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Approve and resume" }),
      ).toHaveCount(0);
    }
    await page.getByText("Source coverage and limits", { exact: true }).click();
    await expect(
      page.getByText("$0.13 spent or reserved of $5", { exact: false }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`grouped-${ending}-mobile.png`),
      fullPage: true,
    });
    expect(starts).toBe(1);
    expect(errors).toEqual([]);
  });
