import { test, expect } from "@playwright/test";
test("approves a plan, downloads generated source, and keeps previous versions on revision", async ({
  page,
  request,
}, testInfo) => {
  const created = await request.post("/api/workflows", {
      data: {
        name: `Engineering journey ${Date.now()}`,
        desired_outcome: "Ask a human to approve a report preview.",
      },
    }),
    w = await created.json();
  expect(created.ok()).toBe(true);
  const nodes = [];
  for (const [type, title] of [
    ["trigger", "Select shipment"],
    ["human_approval", "Approve report"],
    ["outcome", "Preview report"],
  ]) {
    const r = await request.post(`/api/workflows/${w.id}/nodes`, {
      data: { type, title, instructions: title },
    });
    expect(r.ok()).toBe(true);
    nodes.push(await r.json());
  }
  for (let i = 0; i < 2; i++)
    expect(
      (
        await request.post(`/api/workflows/${w.id}/connections`, {
          data: {
            source_node_id: nodes[i].id,
            target_node_id: nodes[i + 1].id,
          },
        })
      ).ok(),
    ).toBe(true);
  expect(
    (
      await request.post(`/api/workflows/${w.id}/reviews`, {
        data: { request_key: crypto.randomUUID() },
      })
    ).ok(),
  ).toBe(true);
  const board = await (await request.get(`/api/workflows/${w.id}`)).json();
  expect(
    (
      await request.post(`/api/workflows/${w.id}/freeze`, {
        data: {
          expected_content_revision: board.workflow.content_revision,
          acknowledge_unreviewed: false,
        },
      })
    ).ok(),
  ).toBe(true);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/workflows/${w.id}`);
  await page.getByRole("link", { name: "Open engineer workspace" }).click();
  await page
    .getByRole("button", { name: "Create implementation plan" })
    .click();
  await expect(
    page.getByRole("button", { name: "Generate agent", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel("Method for Approve report", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Suggest methods" }).click();
  await expect(
    page.getByText("AI suggests human.", { exact: true }),
  ).toBeVisible();
  for (const title of ["Select shipment", "Approve report", "Preview report"]) {
    await page
      .getByRole("checkbox", { name: `Approve ${title}`, exact: true })
      .click();
    await expect(
      page.getByRole("checkbox", { name: `Approve ${title}`, exact: true }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: `Approve ${title}`, exact: true }),
    ).toBeEnabled();
  }
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Generate agent", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("implementation-plan.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Generate agent", exact: true })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toContainText(
    "nodeId",
  );
  await expect(
    page.getByText("Not yet evaluated", { exact: true }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download project" }).click();
  expect((await downloaded).suggestedFilename()).toBe("meridian-agent-v1.zip");
  await page
    .getByRole("button", { name: "Implementation", exact: true })
    .click();
  await page.getByRole("button", { name: "Revise plan", exact: true }).click();
  await expect(page.getByLabel("Plan version")).toHaveValue(/.+/);
  await expect(
    page.getByRole("checkbox", {
      name: "Approve Select shipment",
      exact: true,
    }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("generated-agent.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
