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
}, testInfo) => {
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
  await expect(
    thread.getByRole("textbox", { name: /^Response to/ }),
  ).toHaveCount(1);
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
  const unchanged = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  expect(
    unchanged.nodes.find((n: { type: string }) => n.type === "task")
      .instructions,
  ).toBe("Check invoice");
  await expect(thread.locator(".reply-proposal")).toContainText(
    "Awaiting your approval",
  );
  await thread
    .getByRole("button", { name: "Accept changes", exact: true })
    .click();
  await expect(thread.locator(".proposal-state")).toHaveText("accepted");
  const updated = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  const task = updated.nodes.find((n: { type: string }) => n.type === "task");
  expect(task.instructions).toContain(
    "The five fields in our SOP are required.",
  );
  await expect(
    page.locator(".process-block").filter({ hasText: "Validate invoice" }),
  ).toContainText("The five fields in our SOP are required.");
  await expect(
    thread.getByRole("button", { name: "Apply and resolve" }),
  ).toHaveCount(0);
  await expect(thread.locator(".instruction-diff")).toContainText(
    "Check invoice",
  );
  await page.screenshot({
    path: testInfo.outputPath("reply-block-update.png"),
    fullPage: true,
  });

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

test("a failed reply update preserves the answer and retries without duplicate messages", async ({
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
  const response = thread.getByRole("textbox", { name: /^Response to/ });
  const initial = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  await page.route("**/threads/*/messages", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: {
          code: "UNAVAILABLE",
          message: "Reply update unavailable. Please retry.",
        },
      },
    }),
  );
  await response.fill("Validate all five required fields.");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread.getByRole("alert")).toContainText(
    "Reply update unavailable",
  );
  await expect(response).toHaveValue("Validate all five required fields.");
  expect(
    (await (await request.get(`/api/workflows/${workflow.id}`)).json()).nodes,
  ).toEqual(initial.nodes);
  await page.unroute("**/threads/*/messages");
  // Simulate a committed request whose response was lost. Retry must reuse its key.
  let lost = false;
  await page.route("**/threads/*/messages", async (route) => {
    const serverResponse = await route.fetch();
    if (!lost) {
      lost = true;
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "LOST_RESPONSE",
            message: "Connection interrupted; retry.",
          },
        },
      });
    } else await route.fulfill({ response: serverResponse });
  });
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread.getByRole("alert")).toContainText(
    "Connection interrupted",
  );
  await expect(response).toHaveValue("Validate all five required fields.");
  // An unrelated note refreshes this thread to its committed revision before
  // retry. The uncertain reply must still reuse its original key and parent.
  await page.getByRole("textbox", { name: "Comment on this workflow", exact: true }).fill("Keep this independent note.");
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await expect(thread.locator(".proposal-state")).toHaveText("Awaiting your approval");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  await expect(thread.locator(".thread-status")).toHaveText("Answered");
  await expect(response).toHaveValue("");
  const state = await (
    await request.get(`/api/workflows/${workflow.id}/reviews`)
  ).json();
  expect(
    state.messages.filter(
      (m: { author_kind: string; body: string }) => m.author_kind === "customer" && m.body === "Validate all five required fields.",
    ),
  ).toHaveLength(1);
  await thread
    .getByRole("button", { name: "Accept changes", exact: true })
    .click();
  await expect(thread.locator(".proposal-state")).toHaveText("accepted");
  await page.reload();
  await page
    .locator(".process-block strong")
    .filter({ hasText: "Validate invoice" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toHaveValue(/Validate all five required fields\./);
});

test("expanded conversation preserves drafts, traps focus, rejects changes and works on narrow screens", async ({
  page,
  request,
}, testInfo) => {
  const workflow = await seededWorkflow(request);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  const thread = page
    .locator(".review-thread")
    .filter({ hasText: "Which invoice fields are required?" });
  const expand = thread.getByRole("button", { name: /Expand conversation:/ });
  await thread
    .getByRole("textbox")
    .fill("Keep the existing required fields, and flag unreadable invoices.");
  for (let i = 0; i < 3; i++) {
    await expand.click();
    await expect(
      page.getByRole("dialog").getByRole("textbox", { name: /^Response to/ }),
    ).toHaveValue(/Keep the existing/);
    await expect(
      thread.getByRole("textbox", { name: /^Response to/ }),
    ).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(expand).toBeFocused();
  }
  await expand.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Accept changes", exact: true }),
  ).toBeEnabled();
  await expect(dialog.locator(".conversation-message.assistant")).toHaveCount(
    2,
  );
  await expect(dialog.locator(".conversation-message.owner")).toHaveCount(1);
  await dialog
    .getByRole("button", { name: "Close conversation", exact: true })
    .focus();
  await page.keyboard.press("Shift+Tab");
  expect(
    await dialog.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("conversation-expanded.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: testInfo.outputPath("conversation-mobile.png"),
    fullPage: true,
  });
  await dialog
    .getByRole("button", { name: "Reject changes", exact: true })
    .click();
  await expect(dialog.locator(".proposal-state")).toHaveText("rejected");
  const board = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  expect(
    board.nodes.find((n: { type: string }) => n.type === "task").instructions,
  ).toBe("Check invoice");
  await dialog
    .getByRole("button", { name: "Close conversation", exact: true })
    .click();
  await expect(expand).toBeFocused();
  await page.reload();
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await expand.click();
  await expect(page.getByRole("dialog").locator(".proposal-state")).toHaveText(
    "rejected",
  );
});

test("edits and decides each proposed block independently while preserving unsaved wording", async ({
  page,
  request,
}, testInfo) => {
  const workflow = await seededWorkflow(request);
  await request.post(`/api/workflows/${workflow.id}/nodes`, {
    data: {
      type: "task",
      title: "Check certificates",
      instructions: "Check invoice",
      x: 400,
      y: 400,
    },
  });
  await page.goto(`/workflows/${workflow.id}`);
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  const thread = page
    .locator(".review-thread")
    .filter({ hasText: "Which invoice fields are required?" });
  await thread
    .getByRole("textbox", { name: /^Response to/ })
    .fill("Include the required identifiers.");
  await thread.getByRole("button", { name: "Send", exact: true }).click();
  const first = thread.locator(".block-diff").filter({
    has: page.getByRole("textbox", {
      name: "Proposed instructions for Validate invoice",
      exact: true,
    }),
  });
  const second = thread.locator(".block-diff").filter({
    has: page.getByRole("textbox", {
      name: "Proposed instructions for Check certificates",
      exact: true,
    }),
  });
  await expect(first.locator(".instruction-diff")).toBeVisible();
  expect(
    (await first.locator(".instruction-diff ins").allTextContents()).join(""),
  ).toContain("Include the required identifiers.");
  await first.getByRole("textbox").fill("Check invoice");
  await expect(
    first.locator(".instruction-diff ins, .instruction-diff del"),
  ).toHaveCount(0);
  await first
    .getByRole("textbox")
    .fill(
      "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
    );
  await second.getByRole("textbox").fill("Keep this draft until I decide.");
  await thread.getByRole("button", { name: /Expand conversation:/ }).click();
  await expect(first.getByRole("textbox")).toHaveValue(
    "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
  );
  await expect(first.locator(".instruction-diff")).toBeVisible();
  await expect(first.locator(".instruction-diff del")).toContainText("Check");
  expect(
    (await first.locator(".instruction-diff ins").allTextContents()).join(""),
  ).toContain("Include the required identifiers.");
  expect(
    await first.locator(".instruction-diff ins").allTextContents(),
  ).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Preserve source references."),
    ]),
  );
  const proposedText = (locator: ReturnType<typeof page.locator>) =>
    locator.locator(".instruction-diff p").evaluate((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("del, .sr-only").forEach((node) => node.remove());
      return copy.textContent;
    });
  expect(await proposedText(first)).toBe(
    "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
  );
  const editorPane = await first.locator(".proposal-text-editor").boundingBox();
  const diffPane = await first.locator(".proposal-diff-preview").boundingBox();
  expect(Math.abs(editorPane!.height - diffPane!.height)).toBeLessThan(1);
  expect(Math.abs(editorPane!.width - diffPane!.width)).toBeLessThan(1);
  expect(Math.abs(editorPane!.y - diffPane!.y)).toBeLessThan(1);
  expect(diffPane!.x).toBeGreaterThan(editorPane!.x + editorPane!.width);
  // Fixed-height comparison panes must remain readable without a pointer.
  const acceptedWording = await first.getByRole("textbox").inputValue();
  await first.getByRole("textbox").fill("Review this requirement carefully. ".repeat(100));
  await first.getByRole("textbox").focus();
  await page.keyboard.press("Tab");
  const diffRegion = first.getByRole("region", { name: "Instruction changes", exact: true });
  await expect(diffRegion).toBeFocused();
  await page.keyboard.press("PageDown");
  await expect.poll(() => diffRegion.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await first.getByRole("textbox").fill(acceptedWording);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowEditor = (await first.locator(".proposal-text-editor").boundingBox())!;
  const narrowDiff = (await first.locator(".proposal-diff-preview").boundingBox())!;
  expect(narrowDiff.y).toBeGreaterThanOrEqual(narrowEditor.y + narrowEditor.height);
  expect(Math.abs(narrowEditor.width - narrowDiff.width)).toBeLessThan(1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await first.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath("editable-block-proposals.png"),
    fullPage: true,
  });
  await page.route("**/proposals/*", (route) =>
    route.fulfill({
      status: 503,
      json: {
        error: { code: "UNAVAILABLE", message: "Please retry this decision." },
      },
    }),
  );
  await first
    .getByRole("button", { name: "Accept changes", exact: true })
    .click();
  await expect(thread.getByRole("alert")).toContainText(
    "Please retry this decision.",
  );
  await expect(first.getByRole("textbox")).toHaveValue(
    "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
  );
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this draft until I decide.",
  );
  await page.unroute("**/proposals/*");
  const decisions: unknown[] = [];
  await page.route("**/proposals/*", async route => {
    decisions.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (decisions.length === 1) {
      expect(response.ok()).toBe(true);
      await route.fulfill({ status: 503, json: { error: { code: "LOST_RESPONSE", message: "Decision saved but response interrupted." } } });
    } else await route.fulfill({ response });
  });
  await first.getByRole("button", { name: "Accept changes", exact: true }).click();
  await expect(thread.getByRole("alert")).toContainText("Decision saved but response interrupted.");
  await expect(second.getByRole("textbox")).toHaveValue("Keep this draft until I decide.");
  await first
    .getByRole("button", { name: "Accept changes", exact: true })
    .click();
  await expect.poll(() => decisions.length).toBe(2);
  expect(decisions[1]).toEqual(decisions[0]);
  await expect(thread.locator(".proposal-state").first()).toHaveText(
    "accepted",
  );
  await page.unroute("**/proposals/*");
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this draft until I decide.",
  );
  await expect(
    second.getByRole("button", { name: "Accept changes", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Close conversation", exact: true })
    .click();
  await expect(second.getByRole("textbox")).toHaveValue(
    "Keep this draft until I decide.",
  );
  await second
    .getByRole("button", { name: "Reject changes", exact: true })
    .click();
  await expect(thread.locator(".proposal-state").last()).toHaveText("rejected");
  const board = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  expect(
    board.nodes.find((n: { title: string }) => n.title === "Validate invoice")
      .instructions,
  ).toBe(
    "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
  );
  expect(
    board.nodes.find((n: { title: string }) => n.title === "Check certificates")
      .instructions,
  ).toBe("Check invoice");
  await page.reload();
  await page.getByRole("button", { name: /Review & comments/ }).click();
  await expect(thread.locator(".proposal-state")).toHaveText([
    "accepted",
    "rejected",
  ]);
  expect(await proposedText(thread.locator(".block-diff").first())).toBe(
    "Require the five approved invoice identifiers. Include the required identifiers. Preserve source references.",
  );
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
