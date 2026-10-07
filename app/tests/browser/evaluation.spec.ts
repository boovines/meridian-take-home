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
    manifest: { input: { goods_failed: 1 }, message_ids: [], artifacts: [] },
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
    .getByRole("button", { name: "Test cases · 1", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Create suite revision", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock verified suite", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Edit case", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Expected value (JSON)", exact: true })
    .fill("1");
  await page.getByRole("button", { name: "Save case", exact: true }).click();
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
      name: /Two missing fields on one good Full workflow passed/,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Code v1 · suite v2 · 1 / 1 cases passed", { exact: false }),
  ).toBeVisible();
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
  await page.screenshot({
    path: testInfo.outputPath("evaluation-narrow.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
