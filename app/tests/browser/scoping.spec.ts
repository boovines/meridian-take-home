import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
async function newBoard(request: APIRequestContext) {
  const response = await request.post("/api/workflows", {
    data: { name: "Guided scoping browser test", desired_outcome: "" },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).id as string;
}
const notes =
  "A request comes in. Prepare a response for human approval, then show the approved response. Do not send automatically. Rejection returns to preparation. Retention is unknown.";
async function open(page: Page, id: string) {
  await page.goto(`/workflows/${id}`);
  await page
    .getByRole("button", { name: "Open process note", exact: true })
    .click();
}
async function begin(page: Page, id: string) {
  await open(page, id);
  await page
    .getByRole("textbox", { name: "Process notes", exact: true })
    .fill(notes);
  await page
    .getByRole("button", { name: "Help build workflow", exact: true })
    .click();
  await expect(
    page.getByText(
      "Who approves the response, and what should happen if they request changes?",
      { exact: false },
    ),
  ).toBeVisible();
}
async function makePreview(page: Page) {
  await page
    .getByRole("textbox", { name: "Your reply", exact: true })
    .fill(
      "The process owner approves. If rejected, revise and ask again. Retention can be resolved in review.",
    );
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply workflow", exact: true }),
  ).toBeEnabled();
}
test("notes → interview → preview → apply without reload → mandatory normal review", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await begin(page, id);
  await page
    .getByRole("textbox", { name: "Your reply", exact: true })
    .fill("The owner approves; rework rejected responses.");
  await page
    .getByRole("button", { name: "Expand process note", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Your reply", exact: true }),
  ).toHaveValue("The owner approves; rework rejected responses.");
  await expect(
    page.getByRole("textbox", { name: "Process notes", exact: true }),
  ).toHaveValue(notes);
  await makePreview(page);
  expect(
    (await (await request.get(`/api/workflows/${id}`)).json()).nodes,
  ).toHaveLength(0);
  await page
    .getByRole("combobox", { name: "Inspect a block", exact: true })
    .selectOption({ label: "Preview approved response" });
  await expect(page.locator(".scoping-detail")).toContainText(
    "Unresolved — requires review",
  );
  await page.screenshot({ path: "../work/scoping-final.png", fullPage: true });
  await page.evaluate(() => {
    document.body.dataset.scopingJourney = "stays-mounted";
  });
  await page
    .getByRole("button", { name: "Apply workflow", exact: true })
    .click();
  await expect(page.getByText("Not reviewed", { exact: true })).toBeVisible();
  await expect(page.locator("body")).toHaveAttribute(
    "data-scoping-journey",
    "stays-mounted",
  );
  const board = await (await request.get(`/api/workflows/${id}`)).json();
  expect(board.nodes).toHaveLength(4);
  expect(board.connections).toHaveLength(4);
  expect(
    (
      await request.post(`/api/workflows/${id}/freeze`, {
        data: {
          expected_content_revision: board.workflow.content_revision,
          acknowledge_unreviewed: true,
        },
      })
    ).status(),
  ).toBe(422);
  await page
    .getByRole("button", { name: "Close process note", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Open process note", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Review & comments", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  await expect(
    page
      .getByRole("complementary", { name: "Review and comments" })
      .getByText("How long should the approved response be retained?", {
        exact: false,
      })
      .first(),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Open process note", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Process notes", exact: true }),
  ).toHaveValue(notes);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByLabel("Preview history")).toContainText("Applied");
  expect(errors).toEqual([]);
});
test("hide, reopen, move and expand preserve drafts and focus", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await open(page, id);
  const note = page.getByRole("textbox", {
    name: "Process notes",
    exact: true,
  });
  await note.fill(notes);
  const window = page.getByRole("dialog"),
    start = await window.boundingBox();
  await page
    .getByRole("button", { name: "Move process note", exact: true })
    .press("ArrowRight");
  await expect
    .poll(async () => (await window.boundingBox())!.x)
    .toBeGreaterThan(start!.x);
  const moved = await window.boundingBox();
  await page
    .getByRole("button", { name: "Hide process note", exact: true })
    .click();
  await expect(window).not.toBeVisible();
  await page
    .getByRole("button", { name: "Open process note", exact: true })
    .click();
  await expect(note).toHaveValue(notes);
  expect((await window.boundingBox())!.x).toBe(moved!.x);
  await page
    .getByRole("button", { name: "Expand process note", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Close process note", exact: true })
    .focus();
  await page.keyboard.press("Tab");
  expect(
    await window.evaluate((d) => d.contains(document.activeElement)),
  ).toBeTruthy();
  await page.keyboard.press("Escape");
  await expect(window).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open process note", exact: true }),
  ).toBeFocused();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/workflows/${id}/scoping`)).json())
          .session.note,
    )
    .toBe(notes);
});
test("autosave conflicts keep local text until an explicit recovery choice", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await open(page, id);
  const note = page.getByRole("textbox", {
    name: "Process notes",
    exact: true,
  });
  await note.fill(notes);
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/workflows/${id}/scoping`)).json())
          .session.note,
    )
    .toBe(notes);
  const state = await (
    await request.get(`/api/workflows/${id}/scoping`)
  ).json();
  await request.patch(`/api/workflows/${id}/scoping`, {
    data: {
      note: "Another expert's saved note",
      expected_revision: state.session.note_revision,
    },
  });
  await note.fill("My local changes must survive.");
  await expect(
    page.getByText("This note changed elsewhere", { exact: true }),
  ).toBeVisible();
  await expect(note).toHaveValue("My local changes must survive.");
  await expect(
    page.getByRole("button", { name: "Help build workflow", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Keep my text and save", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/workflows/${id}/scoping`)).json())
          .session.note,
    )
    .toBe("My local changes must survive.");
});
test("manual additions block apply while preserving preview and conversation", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await begin(page, id);
  await makePreview(page);
  await request.post(`/api/workflows/${id}/nodes`, {
    data: { type: "trigger", title: "Manual start" },
  });
  await page
    .getByRole("button", { name: "Apply workflow", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "no longer empty",
  );
  const board = await (await request.get(`/api/workflows/${id}`)).json();
  expect(board.nodes).toHaveLength(1);
  expect(board.nodes[0].title).toBe("Manual start");
  await expect(page.getByLabel("Preview history")).toContainText("Version 1");
});
test("small screens and reduced motion preserve notes", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const id = await newBoard(request);
  await open(page, id);
  await expect(
    page.getByRole("button", { name: "Restore floating note", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Process notes", exact: true })
    .fill(notes);
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.width).toBeLessThanOrEqual(390);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  await page
    .getByRole("button", { name: "Close process note", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open process note", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Process notes", exact: true }),
  ).toHaveValue(notes);
});

test("a failed autosave survives reload with explicit local-draft recovery", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await open(page, id);
  await page.route(`**/api/workflows/${id}/scoping`, (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue(),
  );
  await page
    .getByRole("textbox", { name: "Process notes", exact: true })
    .fill("Recover this unsaved note after a network failure.");
  await expect(page.locator(".scoping-error")).toBeVisible();
  page.on("dialog", (dialog) => void dialog.accept());
  await page.reload();
  await page.unroute(`**/api/workflows/${id}/scoping`);
  await page
    .getByRole("button", { name: "Open process note", exact: true })
    .click();
  await expect(
    page.getByText("Recover your unsaved note", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Process notes", exact: true }),
  ).toHaveValue("Recover this unsaved note after a network failure.");
  await page
    .getByRole("button", { name: "Keep my text and save", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/workflows/${id}/scoping`)).json())
          .session.note,
    )
    .toBe("Recover this unsaved note after a network failure.");
});
test("conversational revisions preserve prior previews but only the current version can apply", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await begin(page, id);
  await makePreview(page);
  await page
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Your reply", exact: true })
    .fill("Keep the approval and loop; make the response wording concise.");
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(page.getByLabel("Preview history")).toContainText("Version 2");
  await page
    .getByLabel("Preview history")
    .selectOption({ label: "Version 1 · Previous" });
  await expect(
    page.getByRole("button", { name: "Apply workflow", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Preview history")
    .selectOption({ label: "Version 2 · Current" });
  await expect(
    page.getByRole("button", { name: "Apply workflow", exact: true }),
  ).toBeEnabled();
});
test("a lost apply response reconciles the saved graph without duplicating blocks", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await begin(page, id);
  await makePreview(page);
  await page.route(`**/api/workflows/${id}/scoping/apply`, async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page
    .getByRole("button", { name: "Apply workflow", exact: true })
    .click();
  await expect(page.getByText("Not reviewed", { exact: true })).toBeVisible();
  expect(
    (await (await request.get(`/api/workflows/${id}`)).json()).nodes,
  ).toHaveLength(4);
});

test("a lost interview reply retries the original turn after session refresh", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await begin(page, id);
  const answer =
    "The owner approves and rejected responses return for revision.";
  await page
    .getByRole("textbox", { name: "Your reply", exact: true })
    .fill(answer);
  const requests: unknown[] = [];
  await page.route(`**/api/workflows/${id}/scoping/requests`, async (route) => {
    requests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    if (requests.length === 1)
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "LOST_RESPONSE",
            message: "Reply saved but response lost. Retry this reply.",
          },
        },
      });
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(page.locator(".scoping-error")).toContainText(
    "Reply saved but response lost",
  );
  await expect(
    page.getByRole("button", { name: "Send reply", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Send reply", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Your reply", exact: true }),
  ).toHaveValue("");
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  const state = await (
    await request.get(`/api/workflows/${id}/scoping`)
  ).json();
  expect(
    state.messages.filter(
      (m: { author: string; body: string }) =>
        m.author === "expert" && m.body === answer,
    ),
  ).toHaveLength(1);
  expect(state.versions).toHaveLength(2);
});

test("preview is available after the first response while gaps remain for review", async ({
  page,
  request,
}) => {
  const id = await newBoard(request);
  await begin(page, id);
  await expect(page.getByText("At most 2 question rounds")).toBeVisible();
  await page
    .getByRole("button", { name: "Generate preview", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Apply workflow", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Apply workflow", exact: true })
    .click();
  const state = await (
    await request.get(`/api/workflows/${id}/scoping`)
  ).json();
  expect(state.needs_review).toBe(true);
  const board = await (await request.get(`/api/workflows/${id}`)).json();
  expect(board.nodes.length).toBeGreaterThan(0);
});
