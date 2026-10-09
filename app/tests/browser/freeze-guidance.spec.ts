import { test, expect } from "@playwright/test";

test("freeze explains a misplaced wait setting and opens each block to fix it", async ({
  page,
  request,
}, testInfo) => {
  const created = await request.post("/api/workflows", {
    data: {
      name: `Parallel guidance ${Date.now()}`,
      desired_outcome: "Preview a shipment report",
    },
  });
  expect(created.ok()).toBe(true);
  const workflow = await created.json();
  const nodes: { id: string; revision: number }[] = [];
  for (const [i, [type, title]] of [
    ["trigger", "Shipment email"],
    ["information", "Read invoices"],
    ["information", "Read certificates"],
    ["check", "Validate goods and batches"],
    ["outcome", "Preview report"],
  ].entries()) {
    const response = await request.post(`/api/workflows/${workflow.id}/nodes`, {
      data: {
        type,
        title,
        instructions: "Process the selected packet",
        x: i * 240,
        y: 160,
      },
    });
    expect(response.ok()).toBe(true);
    nodes.push(await response.json());
  }
  for (const [index, change] of [
    [0, { split_mode: "parallel" }],
    [2, { join_for_split_id: nodes[0].id }],
  ] as const) {
    const response = await request.patch(
      `/api/workflows/${workflow.id}/nodes/${nodes[index].id}`,
      {
        data: { expected_revision: nodes[index].revision, ...change },
      },
    );
    expect(response.ok()).toBe(true);
  }
  for (const [from, to] of [
    [0, 1],
    [0, 2],
    [1, 3],
    [2, 3],
    [3, 4],
  ]) {
    const response = await request.post(
      `/api/workflows/${workflow.id}/connections`,
      {
        data: {
          source_node_id: nodes[from].id,
          target_node_id: nodes[to].id,
        },
      },
    );
    expect(response.ok()).toBe(true);
  }
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(
    "“Read certificates” is set to wait for both paths from “Shipment email”",
  );
  await expect(dialog).toContainText(
    "Both paths already connect to “Validate goods and batches”",
  );
  await expect(dialog).not.toContainText(
    "This parallel step cannot reach its paired merge",
  );
  await expect(
    dialog.getByRole("button", { name: "Freeze and hand off" }),
  ).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("freeze-guidance.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Edit “Read certificates”", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Block name", exact: true }),
  ).toHaveValue("Read certificates");
  await page
    .getByRole("combobox", { name: "Wait for both paths from", exact: true })
    .selectOption("");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await dialog
    .getByRole("button", {
      name: "Edit “Validate goods and batches”",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Block name", exact: true }),
  ).toHaveValue("Validate goods and batches");
  await page
    .getByRole("combobox", { name: "Wait for both paths from", exact: true })
    .selectOption(nodes[0].id);
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(dialog).toContainText("The process has a valid structure");
  await expect(dialog).not.toContainText("Fix these structural issues");
  // A graph fix must not bypass the independent completed-review gate.
  await expect(
    dialog.getByRole("button", { name: "Freeze and hand off" }),
  ).toBeDisabled();
});
