import { test, expect } from "@playwright/test";

test("optional context previews selected moments, persists and can be removed without changing the graph", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workflows", {
    data: {
      name: "Context journey",
      desired_outcome: "Prepare a reviewed report",
    },
  });
  const workflow = await created.json();
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: "Process context Optional" }).click();
  await page.getByText("Paste JSON instead", { exact: true }).click();
  await page.getByLabel("DeepShelves JSON", { exact: true }).fill(
    JSON.stringify([
      {
        id: "fixture-1",
        timestamp: "2026-10-09T14:00:00Z",
        application: "Preview",
        title: "Sanitized invoice",
        text: "One missing product code.",
      },
      {
        id: "fixture-2",
        timestamp: "2026-10-09T14:01:00Z",
        application: "Mail",
        title: "Unrelated window",
        text: "Exclude this moment.",
      },
    ]),
  );
  await page.getByRole("button", { name: "Preview pasted moments" }).click();
  await expect(
    page.getByRole("button", { name: "Save selected context" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", { name: "Include Sanitized invoice", exact: true })
    .check();
  await page.getByLabel("Recording name").fill("Receiving demonstration");
  await page.getByRole("button", { name: "Save selected context" }).click();
  await expect(page.locator(".process-context-dialog").getByRole("status")).toContainText(
    "Context saved for scoping and review",
  );
  await page.reload();
  await page.getByRole("button", { name: "Process context Optional" }).click();
  await expect(page.getByLabel("Recording name")).toHaveValue(
    "Receiving demonstration",
  );
  await expect(
    page.getByRole("checkbox", {
      name: "Include Sanitized invoice",
      exact: true,
    }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", {
      name: "Include Unrelated window",
      exact: true,
    }),
  ).toHaveCount(0);
  const before = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  await page
    .getByRole("button", { name: "Remove context", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Confirm removal", exact: true })
    .click();
  await expect(page.locator(".process-context-dialog").getByRole("status")).toContainText("Context removed");
  const after = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  expect(after.nodes).toEqual(before.nodes);
  expect(after.connections).toEqual(before.connections);
  await page.getByRole("button", { name: "Close process context" }).click();
  await expect(
    page.getByRole("button", { name: "Review & comments" }),
  ).toBeVisible();
});
