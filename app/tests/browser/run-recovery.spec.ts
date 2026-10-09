import { test, expect } from "@playwright/test";
// UI contract with HTTP fixtures; actual persistence/regression behavior is tested
// independently against the services in run-recovery.test.ts.
for (const needsClarification of [false, true]) {
  test(`recovers a failed run ${needsClarification ? "through persisted engineer clarification" : "automatically"}, reloads progress, and shows an unverified default and report`, async ({
    page,
  }, testInfo) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (e) => browserErrors.push(e.message));
    const w = crypto.randomUUID(),
      s = crypto.randomUUID(),
      r = crypto.randomUUID(),
      j = crypto.randomUUID(),
      v1 = crypto.randomUUID(),
      v2 = crypto.randomUUID(),
      b = crypto.randomUUID(),
      n = crypto.randomUUID();
    const date = "2026-01-01T12:00:00Z";
    let started = false,
      done = false,
      starts = 0,
      answered = false;
    const questionId = crypto.randomUUID();
    const job = () => ({
      id: j,
      kind: "repair",
      status: done
        ? "succeeded"
        : needsClarification && !answered
          ? "waiting_for_human"
          : "running",
      phase: done ? "recovered" : "rerunning captured input",
      progress: {},
      created_at: date,
    });
    const source = {
      id: s,
      workflow_id: w,
      job_id: "old",
      implementation_version_id: v1,
      input_bundle_id: b,
      kind: "manual",
      status: "failed",
      failure_category: "implementation",
      failure_message:
        "Evidence path does not resolve to the extracted scalar.",
      created_at: date,
      limits: { step_attempts: 100, active_ms: 900000 },
    };
    const rerun = () => ({
      ...source,
      id: r,
      job_id: j,
      implementation_version_id: v2,
      kind: "recovery",
      status: done ? "completed" : "running",
      failure_message: null,
      failure_category: null,
      rerun_of_id: s,
      result_step_id: "result",
    });
    const recovery = () =>
      started
        ? {
            session: {
              id: "session",
              source_run_id: s,
              status: done ? "recovered" : "running",
              attempt_limit: 3,
              recovery_limits: { max_spend_usd: 5, active_ms: 7200000 },
            },
            job: job(),
            spent_or_reserved_usd: 0.42,
            questions: needsClarification
              ? [
                  {
                    id: questionId,
                    workflow_id: w,
                    session_id: "session",
                    attempt_id: "attempt",
                    question: "Does REG mean registration number?",
                    why_needed:
                      "Clarify the label while preserving the required registration check.",
                    node_ids: [n],
                    source_artifact_ids: [],
                    audit_event_ids: [],
                    status: answered ? "answered" : "open",
                    answer: answered
                      ? "REG means registration number. Inspect the printed label."
                      : null,
                    reuse: false,
                    created_at: date,
                    answered_at: answered ? date : null,
                  },
                ]
              : [],
            attempts: [
              {
                id: "attempt",
                attempt_number: 1,
                status: done ? "accepted" : "running",
                candidate_version_id: v2,
                rerun_id: needsClarification && !answered ? null : r,
                diagnosis: {
                  summary:
                    "The evidence path points to an object. It must point to the extracted scalar.",
                  affected_node_ids: [n],
                  changes: ["Correct the evidence path."],
                },
              },
            ],
          }
        : null;
    const state = (id?: string) => ({
      runs: id
        ? [id === s ? source : rerun()]
        : started
          ? [rerun(), source]
          : [source],
      recovery: recovery(),
      initial_manual_version_id: v1,
      manual_default: done
        ? { implementation_version_id: v2, recovery_session_id: "session" }
        : null,
      human_requests: [],
      steps:
        id !== s && started && done
          ? [
              {
                id: "result",
                node_id: n,
                status: "completed",
                input_step_refs: {},
                selected_connection_ids: [],
                occurrence_number: 1,
                node_visit_number: 1,
                output_data: {
                  report: {
                    recipient: "review@example.test",
                    subject: "Reviewed packet",
                    body: "Two documents processed. One required field remains missing.",
                  },
                },
              },
            ]
          : [],
    });
    await page.route(`**/api/workflows/${w}/**`, async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith("/engineering"))
        return route.fulfill({
          json: {
            workflow: {
              id: w,
              name: "Packet review",
              desired_outcome: "Preview report",
            },
            spec: {
              id: "spec",
              board: {
                nodes: [{ id: n, title: "Read documents" }],
                connections: [],
              },
            },
            plans: [],
            steps: [],
            versions: [
              ...(started
                ? [{ id: v2, version_number: 2, created_at: date }]
                : []),
              { id: v1, version_number: 1, created_at: date },
            ],
            jobs: started ? [job()] : [],
          },
        });
      if (p.endsWith("/input-bundles"))
        return route.fulfill({
          json: [
            {
              id: b,
              source_kind: "fixture",
              shipment_reference: "DEMO-RECOVERY",
              created_at: date,
            },
          ],
        });
      if (p.endsWith("/recovery") && route.request().method() === "POST") {
        expect(p).toContain(s);
        expect(route.request().postDataJSON().request_key).toBeTruthy();
        started = true;
        starts++;
        return route.fulfill({
          status: 202,
          json: { session: recovery()!.session, job: job() },
        });
      }
      if (p.endsWith(`/engineer-questions/${questionId}/answer`)) {
        expect(route.request().postDataJSON()).toMatchObject({
          answer: "REG means registration number. Inspect the printed label.",
          reuse: false,
        });
        expect(route.request().postDataJSON().request_key).toBeTruthy();
        answered = true;
        return route.fulfill({ json: { question_id: questionId, job_id: j } });
      }
      if (p.endsWith("/runs")) return route.fulfill({ json: state() });
      if (p.includes("/runs/"))
        return route.fulfill({ json: state(p.split("/").at(-1)) });
      if (p.endsWith("/audit-events")) return route.fulfill({ json: [] });
      return route.fulfill({
        status: 404,
        json: { error: { message: "Unexpected fixture route" } },
      });
    });
    async function openRun() {
      await page.getByRole("button", { name: "Agent", exact: true }).click();
      await page
        .getByRole("button", { name: "Run workflow", exact: true })
        .click();
    }
    await page.goto(`/workflows/${w}/engineer`);
    await openRun();
    await page.getByRole("button", { name: "Diagnose and recover" }).click();
    await expect(
      page.getByRole("heading", { name: "Recovering this run" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "The evidence path points to an object. It must point to the extracted scalar.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel recovery" }),
    ).toBeEnabled();
    await page.reload({ waitUntil: "domcontentloaded" });
    await openRun();
    await expect(
      page.getByRole("heading", { name: "Recovering this run" }),
    ).toBeVisible();
    await expect(page.getByLabel("Implementation to run")).toHaveValue(v1);
    if (needsClarification) {
      await expect(
        page.getByText("Does REG mean registration number?", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("checkbox", {
          name: "Use for future runs of this workflow",
        }),
      ).not.toBeChecked();
      await page
        .locator(".recovery-question")
        .screenshot({
          path: testInfo.outputPath("engineer-clarification.png"),
        });
      await page
        .getByLabel("Your clarification")
        .fill("REG means registration number. Inspect the printed label.");
      await page.getByRole("button", { name: "Submit and continue" }).click();
      await expect(
        page.getByText("Applies only to this captured input.", { exact: true }),
      ).toBeVisible();
    }
    done = true;
    await expect(
      page.getByRole("heading", { name: "Completed after repair" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Two documents processed. One required field remains missing.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Implementation to run")).toHaveValue(v2);
    await expect(
      page.getByText("Recovered default. Business results remain unverified.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Original failed run" }).click();
    await expect(
      page.getByText(source.failure_message, { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Implementation to run").selectOption(v1);
    await expect(page.getByLabel("Implementation to run")).toHaveValue(v1);
    expect(starts).toBe(1);
    expect(browserErrors).toEqual([]);
  });
}
