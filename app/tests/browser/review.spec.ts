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
  await thread.locator(":scope > summary").click();
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

test("review hover and keyboard focus highlight only referenced blocks and connections", async ({
  page,
  request,
}, testInfo) => {
  const workflow = await seededWorkflow(request);
  const board = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  const task = board.nodes.find(
    (node: { type: string }) => node.type === "task",
  );
  const outcome = board.nodes.find(
    (node: { type: string }) => node.type === "outcome",
  );
  const edge = board.connections.find(
    (connection: { source_node_id: string }) =>
      connection.source_node_id === task.id,
  );
  const note = await request.post(`/api/workflows/${workflow.id}/threads`, {
    data: {
      title: "Report these validation results",
      body: "Carry the checked fields into the report.",
      node_ids: [task.id, outcome.id],
      connection_ids: [edge.id],
      request_key: crypto.randomUUID(),
    },
  });
  expect(note.ok()).toBe(true);
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  const finding = page
    .locator(".review-thread")
    .filter({ hasText: "Which invoice fields are required?" });
  const discussion = page
    .locator(".review-thread")
    .filter({ hasText: "Report these validation results" });
  const highlightedBlocks = page.locator(".process-block.review-highlighted");
  const highlightedEdges = page.locator(".react-flow__edge.review-highlighted");
  await finding.hover();
  await expect(highlightedBlocks).toHaveCount(1);
  await expect(highlightedBlocks).toContainText("Validate invoice");
  await expect(highlightedEdges).toHaveCount(0);
  await discussion.hover();
  await expect(highlightedBlocks).toHaveCount(2);
  await expect(highlightedEdges).toHaveCount(1);
  await expect(page.locator(".process-block.selected")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("review-anchor-highlight.png"),
    fullPage: true,
  });
  await page.getByRole("heading", { name: workflow.name }).hover();
  await expect(highlightedBlocks).toHaveCount(0);
  await discussion.locator(":scope > summary").focus();
  await expect(highlightedBlocks).toHaveCount(2);
  await expect(highlightedEdges).toHaveCount(1);
  await discussion.getByRole("textbox").focus();
  await expect(highlightedBlocks).toHaveCount(2);
  await page.getByRole("button", { name: "Close review", exact: true }).focus();
  await expect(highlightedBlocks).toHaveCount(0);
  await discussion.hover();
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  await expect(highlightedBlocks).toHaveCount(0);
  await expect(highlightedEdges).toHaveCount(0);
});


test("an older initial review response cannot erase a completed review", async ({ page, request }) => {
  const workflow = await seededWorkflow(request);
  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  await page.route(`**/api/workflows/${workflow.id}/reviews`, async route => {
    if (!first || route.request().method() !== "GET") return route.continue();
    first = false;
    const response = await route.fetch();
    const snapshot = await response.json();
    captured();
    await held;
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto(`/workflows/${workflow.id}`);
  await ready;
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page.getByRole("button", { name: "Start draft review", exact: true }).click();
  const finding = page.locator(".review-thread").filter({ hasText: "Which invoice fields are required?" });
  await expect(finding).toBeVisible();
  const delivered = page.waitForResponse(response => response.url().endsWith("/reviews") && response.request().method() === "GET");
  release();
  await delivered;
  // Wait for the delivered fetch continuation and React's next paint.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(finding).toBeVisible();
  await expect(page.getByText("1 completed review", { exact: true })).toBeVisible();
});

test("a delayed board refresh cannot roll back an acknowledged block edit", async ({ page, request }) => {
  const workflow = await seededWorkflow(request);
  await page.goto(`/workflows/${workflow.id}`);
  await expect(page.getByRole("heading", { name: workflow.name })).toBeVisible();
  let release!: () => void;
  let captured!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { captured = resolve; });
  let first = true;
  await page.route(`**/api/workflows/${workflow.id}`, async route => {
    if (!first || route.request().method() !== "GET") return route.continue();
    first = false;
    const response = await route.fetch();
    const snapshot = await response.json();
    captured();
    await held;
    await route.fulfill({ response, json: snapshot });
  });
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page.getByRole("button", { name: "Start draft review", exact: true }).click();
  await ready;
  await page.getByRole("button", { name: "Close review", exact: true }).click();
  const block = page.locator(".process-block").filter({ hasText: "Validate invoice" });
  await block.locator("strong").click();
  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Keep this acknowledged edit.");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(block).toContainText("Keep this acknowledged edit.");
  const delivered = page.waitForResponse(response => response.url().endsWith(`/workflows/${workflow.id}`));
  release();
  await delivered;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(block).toContainText("Keep this acknowledged edit.");
  await expect(page.getByRole("button", { name: "Saved", exact: true })).toBeDisabled();
});
