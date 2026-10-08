import { test, expect, type APIRequestContext } from "@playwright/test";
async function post(request: APIRequestContext, url: string, data: unknown) {
  const r = await request.post(url, { data });
  expect(r.ok()).toBe(true);
  return r.json();
}
test("verifies a suite, runs comparisons, and preserves results when expectations are revised", async ({
  page,
  request,
}, testInfo) => {
  const w = await post(request, "/api/workflows", {
      name: `Evaluation journey ${Date.now()}`,
      desired_outcome: "Preview a packet result.",
    }),
    base = `/api/workflows/${w.id}`;
  const trigger = await post(request, `${base}/nodes`, {
    type: "trigger",
    title: "Select packet",
    instructions: "Read the selected packet.",
  });
  const outcome = await post(request, `${base}/nodes`, {
    type: "outcome",
    title: "Preview packet",
    instructions: "Return the input packet.",
  });
  await post(request, `${base}/connections`, {
    source_node_id: trigger.id,
    target_node_id: outcome.id,
  });
  await post(request, `${base}/reviews`, { request_key: crypto.randomUUID() });
  const board = await (await request.get(base)).json();
  await post(request, `${base}/freeze`, {
    expected_content_revision: board.workflow.content_revision,
    acknowledge_unreviewed: false,
  });
  const plan = await post(request, `${base}/plans`, {
    request_key: crypto.randomUUID(),
    parent_plan_version_id: null,
  });
  let engineering = await (await request.get(`${base}/engineering`)).json();
  for (const s of engineering.steps)
    expect(
      (
        await request.patch(`${base}/plans/${plan.id}/steps/${s.node_id}`, {
          data: { expected_revision: s.revision, approved: true },
        })
      ).ok(),
    ).toBe(true);
  engineering = await (await request.get(`${base}/engineering`)).json();
  await post(request, `${base}/plans/${plan.id}/approve`, {
    expected_revision: engineering.plans[0].revision,
  });
  await post(request, `${base}/generations`, {
    request_key: crypto.randomUUID(),
    plan_version_id: plan.id,
    input_version_id: null,
  });
  await post(request, `${base}/input-bundles`, {
    source_kind: "fixture",
    shipment_reference: "SYNTHETIC-001",
    manifest: {
      input: {
        goods_failed: 1,
        records: [
          { id: "RAW-9", source: "source-b" },
          { id: "RAW-7", source: "source-a", page: 2 },
        ],
      },
      message_ids: [],
      artifacts: [],
    },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/workflows/${w.id}/engineer`);
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page.getByLabel("Suite name").fill("Verified packet counts");
  await page
    .getByRole("button", { name: "Create test suite", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Run full suite", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Add case", exact: true }).click();
  await page
    .getByLabel("Case name", { exact: true })
    .fill("Two missing fields on one good");
  await page.getByLabel("Check label", { exact: true }).fill("One failed good");
  await page
    .getByLabel("Output path (JSON array)", { exact: true })
    .fill('["goods_failed"]');
  await page
    .getByRole("textbox", { name: "Expected value (JSON)", exact: true })
    .fill("2");
  for (const [operator, label, expected] of [
    [
      "contains_record",
      "Preserve source identifier",
      { id: "RAW-7", source: "source-a" },
    ],
    ["excludes_record", "Do not invent a suffix", { id: "RAW-7A" }],
  ] as const) {
    await page.getByRole("button", { name: "Add check", exact: true }).click();
    const check = page.locator(".assertion-editor").last();
    await check.getByLabel("Check label", { exact: true }).fill(label);
    await check
      .getByLabel("Output path (JSON array)", { exact: true })
      .fill('["records"]');
    await check
      .getByRole("combobox", { name: "Comparison", exact: true })
      .selectOption(operator);
    await check
      .getByRole("textbox", { name: "Expected value (JSON)", exact: true })
      .fill(JSON.stringify(expected));
  }
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Lock verified suite", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Verify inputs & answers", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lock verified suite", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Run full suite", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: /Two missing fields on one good Full workflow failed/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("1 / 1 cases passed", { exact: false }),
  ).not.toBeVisible();
  const statistics = page.getByRole("region", {
    name: "Selected evaluation statistics",
  });
  await expect(statistics).toContainText("Assertions passed2 / 3");
  await expect(statistics).toContainText("1 failed · 0 unscored");
  await expect(
    page.getByRole("region", { name: "Recent evaluation outcomes" }),
  ).toContainText("1 failed");
  await expect(
    page.getByText("Required record", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Forbidden record", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".assertion-result")
      .filter({ hasText: "Preserve source identifier" })
      .getByText("Pass", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".assertion-result")
      .filter({ hasText: "Do not invent a suffix" })
      .getByText("Pass", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Inspect step trace", exact: true })
    .click();
  await expect(
    page.getByText("2. Preview packet · visit 1 · completed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("evaluation-failure.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Repair and rerun", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Repair attempt history" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "The three-attempt limit was reached. Inspect the remaining failures before starting another session.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.locator(".repair-attempt")).toHaveCount(3);
  await page
    .getByRole("button", { name: "Inspect code v2", exact: true })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Code version", exact: true })
      .locator("option:checked"),
  ).toHaveText(/^v2 ·/);
  await expect(
    page.getByRole("link", { name: "Download project", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Evaluation", exact: true }).click();
  await page
    .getByRole("button", { name: "Repair history", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".repair-sidebar")).toBeVisible();
  expect(
    await page
      .locator(".repair-sidebar")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath("repair-history-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page
    .getByRole("button", { name: "Test cases · 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create suite revision", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock verified suite", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Edit case", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Comparison", exact: true }).nth(1),
  ).toHaveValue("contains_record");
  await expect(
    page.getByRole("combobox", { name: "Comparison", exact: true }).nth(2),
  ).toHaveValue("excludes_record");
  await page
    .getByRole("textbox", { name: "Expected value (JSON)", exact: true })
    .first()
    .fill("1");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
  await page
    .getByRole("button", { name: "Verify inputs & answers", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Lock verified suite", exact: true })
    .click();
  const initialCode = await page
    .getByRole("combobox", { name: "Code to evaluate", exact: true })
    .locator("option")
    .filter({ hasText: /^v1 ·/ })
    .getAttribute("value");
  await page
    .getByRole("combobox", { name: "Code to evaluate", exact: true })
    .selectOption(initialCode!);
  await page
    .getByRole("button", { name: "Run full suite", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: /Two missing fields on one good Full workflow passed/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Code v1 · suite v2 · 1 / 1 cases passed", { exact: false }),
  ).toBeVisible();
  await expect(statistics).toContainText("Assertions passed3 / 3");
  const historyChart = page.getByRole("region", {
    name: "Recent evaluation outcomes",
  });
  const firstRun = historyChart.getByRole("button", {
    name: /Inspect code v1, suite v1,/,
  });
  await firstRun.focus();
  await page.keyboard.press("Enter");
  await expect(firstRun).toHaveAttribute("aria-pressed", "true");
  await expect(statistics).toContainText("Assertions passed2 / 3");
  // A delayed historical fetch must never show the previous run's counts as the new run.
  await page.route("**/evaluations/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await historyChart
    .getByRole("button", { name: /Inspect code v1, suite v2,/ })
    .click();
  await expect(
    page.getByText("Loading evaluation statistics…", { exact: true }),
  ).toBeVisible();
  await expect(statistics).toHaveCount(0);
  await expect(statistics).toContainText("Assertions passed3 / 3");
  await page.unroute("**/evaluations/*");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await firstRun.click();
  await historyChart
    .getByRole("button", { name: /Inspect code v1, suite v2,/ })
    .click();
  await firstRun.click();
  await expect(statistics).toContainText("Assertions passed2 / 3");
  const old = await page
    .getByLabel("Evaluation history")
    .locator("option")
    .last()
    .getAttribute("value");
  await page.getByLabel("Evaluation history").selectOption(old!);
  await expect(
    page.getByRole("button", {
      name: /Two missing fields on one good Full workflow failed/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Code v1 · suite v1 · 0 / 1 cases passed", { exact: false }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".evaluation-split")).toBeVisible();
  expect(
    await page
      .locator(".evaluation-split")
      .evaluate((el) => el.getBoundingClientRect().width),
  ).toBeLessThanOrEqual(390);
  await expect(statistics).toBeVisible();
  expect(
    await page
      .locator(".eval-statistics")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  expect(
    await page
      .locator(".eval-history-chart")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("evaluation-narrow.png"),
    fullPage: true,
  });
  await page.getByRole("button", {name: "Run these versions again", exact:true}).click();
  await expect(historyChart.locator(".eval-history-row")).toHaveCount(5);
  await page.getByRole("button", {name:"Show all 6 loaded runs",exact:true}).click();
  await expect(historyChart.locator(".eval-history-row")).toHaveCount(6);
  await page.getByRole("button", {name:"Show latest 5",exact:true}).click();
  await expect(historyChart.locator(".eval-history-row")).toHaveCount(5);
  expect(errors).toEqual([]);
});
