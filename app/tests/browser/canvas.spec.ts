import { test, expect, type Page } from "@playwright/test";

async function createWorkflow(page: Page, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await page.getByLabel("Workflow name").fill(name);
  await page
    .getByLabel("What should this workflow accomplish?")
    .fill("Prepare a verified receiving report.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create workflow", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workflows\/[a-f0-9-]+$/);
  await expect(page.getByRole("heading", { name })).toBeVisible();
}
async function addBlock(
  page: Page,
  type: string,
  name: string,
  instructions: string,
) {
  await page.getByRole("button", { name: `Add ${type}`, exact: true }).click();
  await page
    .getByRole("textbox", { name: "Block name", exact: true })
    .fill(name);
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill(instructions);
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator(".process-block strong").filter({ hasText: name }),
  ).toBeVisible();
}
test("create a workflow, save a return loop, and reload its instructions", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await createWorkflow(page, `Receiving ${Date.now()}`);
  await addBlock(
    page,
    "Trigger",
    "Shipment email",
    "Select an existing shipment email.",
  );
  await addBlock(
    page,
    "Check",
    "Check invoice",
    "Check all five required fields on each good.",
  );
  await page
    .getByRole("combobox", { name: "Next block", exact: true })
    .selectOption({ label: "Shipment email" });
  await page
    .getByLabel("When should this path be taken?")
    .fill("Missing information supplied");
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(page.locator(".canvas-footer")).toContainText("1 connections");
  await page
    .locator(".process-block strong")
    .filter({ hasText: "Shipment email" })
    .click();
  await page
    .getByRole("combobox", { name: "Next block", exact: true })
    .selectOption({ label: "Check invoice" });
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(page.locator(".canvas-footer")).toContainText("2 connections");
  await page.reload();
  await expect(page.locator(".canvas-footer")).toContainText("2 blocks");
  await expect(page.locator(".canvas-footer")).toContainText("2 connections");
  await page
    .locator(".process-block strong")
    .filter({ hasText: "Check invoice" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toHaveValue("Check all five required fields on each good.");
  expect(errors).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("whiteboard.png"),
    fullPage: true,
  });
});
test("a stale tab retains its text and can deliberately recover after comparison", async ({
  page,
  context,
}) => {
  await createWorkflow(page, `Conflicts ${Date.now()}`);
  await addBlock(page, "Task", "Read documents", "Initial instructions.");
  const second = await context.newPage();
  await second.goto(page.url());
  await second
    .locator(".process-block strong")
    .filter({ hasText: "Read documents" })
    .click();
  await second
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("My unsaved alternative.");
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Accepted instructions from the other tab.");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
  await second.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    second.getByRole("alert").filter({ hasText: "changed in another tab" }),
  ).toContainText("changed in another tab");
  await expect(
    second.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toHaveValue("My unsaved alternative.");
  await expect(second.locator(".conflict-box")).toContainText(
    "Accepted instructions from the other tab.",
  );
  await second
    .getByRole("button", { name: "Keep my draft and use this saved revision" })
    .click();
  await second.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(
    second.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await page
    .locator(".process-block strong")
    .filter({ hasText: "Read documents" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toHaveValue("My unsaved alternative.");
});

test("moving the selected block preserves its unsaved instructions without a false conflict", async ({
  page,
  request,
}) => {
  await createWorkflow(page, `Move and edit ${Date.now()}`);
  await addBlock(page, "Task", "Read packet", "Initial instructions.");
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Preserve my edited instructions while moving.");
  const block = page
    .locator(".process-block")
    .filter({ hasText: "Read packet" });
  const bounds = await block.boundingBox();
  expect(bounds).not.toBeNull();
  const savedMove = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/nodes/"),
  );
  await page.mouse.move(bounds!.x + 40, bounds!.y + 25);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 130, bounds!.y + 85, { steps: 10 });
  await page.mouse.up();
  expect((await savedMove).ok()).toBe(true);
  await expect(
    page.getByRole("button", { name: "Save block", exact: true }),
  ).toBeEnabled();
  const savedText = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/nodes/"),
  );
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  expect((await savedText).status()).toBe(200);
  const board = await (
    await request.get(`/api/workflows/${page.url().split("/").at(-1)}`)
  ).json();
  expect(board.nodes[0].instructions).toBe(
    "Preserve my edited instructions while moving.",
  );
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("drop a palette block onto a zoomed canvas and preserve its position after reload", async ({
  page,
  request,
}) => {
  await createWorkflow(page, `Palette drop ${Date.now()}`);
  await addBlock(page, "Trigger", "Start", "Select input.");
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
  const stage = page.getByRole("region", { name: "Process canvas" });
  const bounds = (await stage.boundingBox())!;
  const creation = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/nodes"),
  );
  await page
    .getByRole("button", { name: "Add Task", exact: true })
    .dragTo(stage, {
      targetPosition: { x: bounds.width * 0.65, y: bounds.height * 0.65 },
    });
  const response = await creation;
  expect(response.ok()).toBe(true);
  const created = await response.json();
  await expect(
    page.getByRole("textbox", { name: "Block name", exact: true }),
  ).toHaveValue("Task");
  await page.reload();
  const board = await (
    await request.get(`/api/workflows/${page.url().split("/").at(-1)}`)
  ).json();
  const saved = board.nodes.find(
    (node: { id: string }) => node.id === created.id,
  );
  expect(saved.x).toBe(created.x);
  expect(saved.y).toBe(created.y);
  expect(board.nodes).toHaveLength(2);
  await expect(
    page.locator(".process-block strong").filter({ hasText: /^Task$/ }),
  ).toBeVisible();
});

test("saved actions update the mounted canvas without refetching or resetting the viewport", async ({
  page,
  request,
}) => {
  await createWorkflow(page, `Live board ${Date.now()}`);
  await addBlock(page, "Trigger", "Start here", "Initial instructions.");
  await page.getByRole("button", { name: "Zoom Out", exact: true }).click();
  const viewport = page.locator(".react-flow__viewport");
  const transform = await viewport.getAttribute("style");
  const firstBlock = page.locator(".process-block").first();
  // Identity and focus are user state; a matching replacement DOM is insufficient.
  await firstBlock.evaluate((element) =>
    element.setAttribute("data-mounted-marker", "original"),
  );
  const reads: string[] = [];
  page.on("request", (req) => {
    if (
      req.method() === "GET" &&
      /\/api\/workflows\/[^/]+(?:\/reviews)?$/.test(req.url())
    )
      reads.push(req.url());
  });
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Updated in place.");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(firstBlock).toContainText("Updated in place.");
  await expect(firstBlock).toHaveAttribute("data-mounted-marker", "original");
  await expect(viewport).toHaveAttribute("style", transform!);
  await page
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Block details" }),
  ).toHaveCount(0);
  await expect(viewport).toHaveAttribute("style", transform!);
  await addBlock(page, "Task", "Next step", "Keep the view stable.");
  await expect(viewport).toHaveAttribute("style", transform!);
  await page
    .getByRole("combobox", { name: "Next block", exact: true })
    .selectOption({ label: "Start here" });
  await page
    .getByLabel("When should this path be taken?")
    .fill("Return to start");
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await expect(page.locator(".canvas-footer")).toContainText("1 connections");
  await expect(viewport).toHaveAttribute("style", transform!);
  await page
    .getByRole("button", { name: "Workflow details", exact: false })
    .click();
  await page.getByLabel("Workflow name").fill("Updated workflow title");
  await page.getByRole("button", { name: "Save workflow details" }).click();
  await expect(
    page.getByRole("heading", { name: "Updated workflow title" }),
  ).toBeVisible();
  await expect(viewport).toHaveAttribute("style", transform!);
  await page.locator(".react-flow__edge").dispatchEvent("click");
  await page
    .getByRole("textbox", { name: "Condition", exact: true })
    .fill("Try again after clarification");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(page.locator(".react-flow__edge-text")).toHaveText(
    "Try again after clarification",
  );
  await expect(viewport).toHaveAttribute("style", transform!);
  expect(reads).toEqual([]);
  const board = await (
    await request.get(`/api/workflows/${page.url().split("/").at(-1)}`)
  ).json();
  expect(board.workflow.name).toBe("Updated workflow title");
  expect(board.nodes[0].instructions).toBe("Updated in place.");
  expect(board.connections[0].condition_text).toBe(
    "Try again after clarification",
  );
  await page
    .getByRole("button", { name: "Remove connection", exact: true })
    .click();
  await expect(page.locator(".canvas-footer")).toContainText("0 connections");
  await expect(viewport).toHaveAttribute("style", transform!);
  await page
    .locator(".process-block strong")
    .filter({ hasText: "Next step" })
    .click();
  await page.getByRole("button", { name: "Remove block", exact: true }).click();
  await page.getByRole("button", { name: "Remove block", exact: true }).click();
  await expect(page.locator(".canvas-footer")).toContainText("1 blocks");
  await expect(viewport).toHaveAttribute("style", transform!);
});

test("a rejected save preserves the draft and canvas until a successful retry", async ({
  page,
}) => {
  await createWorkflow(page, `Failed save ${Date.now()}`);
  await addBlock(page, "Task", "Saved title", "Saved instructions.");
  await page.route("**/nodes/*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    await route.fulfill({
      status: 503,
      json: {
        error: { code: "UNAVAILABLE", message: "Please retry this save." },
      },
    });
  });
  await page
    .getByRole("textbox", { name: "Instructions", exact: true })
    .fill("Keep this draft.");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "Please retry this save.",
  );
  await expect(
    page.getByRole("textbox", { name: "Instructions", exact: true }),
  ).toHaveValue("Keep this draft.");
  await expect(page.locator(".process-block")).toContainText(
    "Saved instructions.",
  );
  await page.unroute("**/nodes/*");
  await page.getByRole("button", { name: "Save block", exact: true }).click();
  await expect(page.locator(".process-block")).toContainText(
    "Keep this draft.",
  );
  await expect(
    page.getByRole("button", { name: "Saved", exact: true }),
  ).toBeDisabled();
});
