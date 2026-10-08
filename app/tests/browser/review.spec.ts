import { test, expect, type APIRequestContext } from "@playwright/test";
async function seededWorkflow(request: APIRequestContext) {
  const response = await request.post("/api/workflows", {
    data: {
      name: `Review handoff ${Date.now()}`,
      desired_outcome: "Produce a validated receiving report",
    },
  });
  expect(response.ok()).toBe(true);
  const w = await response.json();
  const nodes = [];
  for (const [i, type, title, instructions] of [
    [0, "trigger", "Shipment email", "Select a packet"],
    [1, "task", "Validate invoice", "Check invoice"],
    [2, "outcome", "Receiving report", "Preview the findings"],
  ] as const) {
    const r = await request.post(`/api/workflows/${w.id}/nodes`, {
      data: { type, title, instructions, x: 80 + i * 270, y: 130 },
    });
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
  return w;
}
test("review twice, inspect and approve a detail edit, then freeze the handoff", async ({
  page,
  request,
}, testInfo) => {
  const w = await seededWorkflow(request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/workflows/${w.id}`);
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Complete at least one draft review first.",
  );
  await expect(
    page.getByRole("button", { name: "Freeze and hand off", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Keep editing" }).click();
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  await expect(
    page.getByText("Which invoice fields are required?", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "1 review findings on Validate invoice" }),
  ).toBeVisible();
  await expect(page.locator(".proposal")).toContainText(
    "Require HTS, ANDA, FDA, REG, and NDC",
  );
  await page.screenshot({
    path: testInfo.outputPath("review-finding.png"),
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Apply and resolve", exact: true })
    .click();
  await expect(
    page.getByText("All findings resolved", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Review draft again", exact: true })
    .click();
  await expect(
    page.getByText("2 completed reviews", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await page
    .getByRole("button", { name: "Freeze and hand off", exact: true })
    .click();
  await expect(page.locator(".state-banner")).toContainText(
    "Frozen for engineer handoff",
  );
  await expect(
    page.getByRole("button", { name: "Add Task", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.locator(".status-pill")).toHaveText("frozen");
  expect(errors).toEqual([]);
});
test("clarifies an empty outcome and can cancel to resume editing", async ({
  page,
  request,
}) => {
  const r = await request.post("/api/workflows", {
    data: { name: `Clarification ${Date.now()}`, desired_outcome: "" },
  });
  const w = await r.json();
  await page.goto(`/workflows/${w.id}`);
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  await expect(
    page.getByText("First, clarify the outcome", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add Task", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Cancel review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add Task", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Review draft again", exact: true })
    .click();
  await page
    .getByRole("textbox", {
      name: "What should this workflow accomplish?",
      exact: true,
    })
    .fill("Prepare the receiving report");
  await page
    .getByRole("button", { name: "Confirm outcome and continue", exact: true })
    .click();
  await expect(
    page.getByText("1 completed review", { exact: true }),
  ).toBeVisible();
});

test("one response composer replies, resolves, reopens and rejects with matching status", async ({
  page,
  request,
}) => {
  const workflow = await seededWorkflow(request);
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  const thread = page
    .locator(".review-thread")
    .filter({ hasText: "Which invoice fields are required?" });
  await expect(thread.locator(".thread-status")).toHaveText("Open");
  await expect(thread.getByRole("textbox")).toHaveCount(1);
  const response = thread.getByRole("textbox", {
    name: "Response to Which invoice fields are required?",
    exact: true,
  });
  const type = thread.getByRole("combobox", {
    name: "Response type for Which invoice fields are required?",
    exact: true,
  });
  await response.fill("The five fields in our SOP are required.");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread.locator(".thread-status")).toHaveText("Answered");
  await response.fill(
    "This wording is already specified in the process; no change needed.",
  );
  await type.selectOption("resolve");
  await expect(response).toHaveValue(
    "This wording is already specified in the process; no change needed.",
  );
  await thread
    .getByRole("button", { name: "Resolve finding", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show resolved findings and review history" })
    .click();
  await expect(thread.locator(".thread-status")).toHaveText("Resolved");
  await thread.locator("summary").click();
  await expect(thread).toContainText(
    "This wording is already specified in the process; no change needed.",
  );
  await thread.getByRole("button", { name: "Reopen finding" }).click();
  await expect(thread.locator(".thread-status")).toHaveText("Open");
  await type.selectOption("reject");
  await response.fill("This requirement belongs to another team's workflow.");
  await thread.getByRole("button", { name: "Reject suggestion" }).click();
  await expect(thread.locator(".thread-status")).toHaveText("Rejected");
  await page.reload();
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Show resolved findings and review history" })
    .click();
  await expect(thread.locator(".thread-status")).toHaveText("Rejected");
});
