import { test, expect } from "@playwright/test";
test("engineer request becomes an expert-approved v2 without replacing the v1 handoff", async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const w = await (
    await request.post("/api/workflows", {
      data: {
        name: `Revision journey ${Date.now()}`,
        desired_outcome: "Approve purchase requests and record the result.",
      },
    })
  ).json();
  const nodes = [];
  for (const [type, title] of [
    ["trigger", "Read purchase request"],
    ["task", "Validate purchase"],
    ["outcome", "Record decision"],
  ]) {
    const res = await request.post(`/api/workflows/${w.id}/nodes`, {
      data: { type, title, instructions: title },
    });
    expect(res.ok()).toBe(true);
    nodes.push(await res.json());
  }
  for (let i = 1; i < nodes.length; i++)
    expect(
      (
        await request.post(`/api/workflows/${w.id}/connections`, {
          data: {
            source_node_id: nodes[i - 1].id,
            target_node_id: nodes[i].id,
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
  const v1 = await (
    await request.post(`/api/workflows/${w.id}/freeze`, {
      data: { expected_content_revision: board.workflow.content_revision },
    })
  ).json();
  await page.goto(`/workflows/${w.id}/engineer`);
  await page
    .getByRole("button", { name: "Create implementation plan", exact: true })
    .click();
  for (const n of nodes) {
    const box = page.getByRole("checkbox", {
      name: `Approve ${n.title}`,
      exact: true,
    });
    await box.click();
    await expect(box).toBeChecked();
  }
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate agent", exact: true })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Implementation", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Request changes", exact: true })
    .click();
  const requestDialog = page.getByRole("dialog", {
    name: "Request process changes",
  });
  await requestDialog
    .getByLabel("What needs to change?")
    .fill("Clarify the approval threshold and responsible owner.");
  await requestDialog
    .getByRole("checkbox", { name: "Validate purchase", exact: true })
    .check();
  await requestDialog
    .getByRole("button", { name: "Send request", exact: true })
    .click();
  await expect(page.getByText("Request sent.", { exact: false })).toBeVisible();
  expect(
    (await (await request.get(`/api/workflows/${w.id}`)).json()).workflow.state,
  ).toBe("frozen");
  await page
    .getByRole("link", { name: "Open the whiteboard conversation" })
    .click();
  const conversation = page.getByRole("dialog", {
    name: "Engineer requested changes",
    exact: true,
  });
  await expect(conversation).toBeVisible();
  await expect(
    conversation.getByText(
      "Clarify the approval threshold and responsible owner.",
      { exact: true },
    ),
  ).toBeVisible();
  await conversation
    .getByLabel("Response to Engineer requested changes", { exact: true })
    .fill("Requests above $5,000 require approval from the operations owner.");
  await conversation.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    conversation.getByRole("button", { name: "Accept changes", exact: true }),
  ).toBeDisabled();
  await conversation
    .getByRole("button", { name: "Start revision", exact: true })
    .click();
  await expect(
    conversation.getByRole("button", { name: "Accept changes", exact: true }),
  ).toBeEnabled();
  await conversation
    .getByLabel("Proposed name for Validate purchase", { exact: true })
    .fill("Validate purchase approval");
  await conversation
    .getByRole("button", { name: "Accept changes", exact: true })
    .click();
  await expect(
    conversation.getByText("Your accepted wording was saved to this block.", {
      exact: true,
    }),
  ).toBeVisible();
  await conversation
    .getByLabel("Response type for Engineer requested changes", { exact: true })
    .selectOption("resolve");
  await conversation
    .getByLabel("Response to Engineer requested changes", { exact: true })
    .fill("Saved the threshold and owner in the validation block.");
  await conversation
    .getByRole("button", { name: "Resolve request", exact: true })
    .click();
  await expect(
    conversation.getByText(
      "Saved the threshold and owner in the validation block.",
      { exact: true },
    ),
  ).toBeVisible();
  await conversation
    .getByRole("button", { name: "Close conversation", exact: true })
    .click();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(
    page.getByText("Complete at least one draft review first.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Keep editing", exact: true }).click();
  await page
    .getByRole("button", { name: "Start draft review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review draft again", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await page
    .getByRole("button", { name: "Freeze and hand off", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open engineer workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open engineer workspace" }).click();
  await expect(page.getByLabel("Frozen process version")).toHaveValue(/.+/);
  await expect(
    page.getByRole("checkbox", {
      name: "Approve Validate purchase approval",
      exact: true,
    }),
  ).not.toBeChecked();
  const latest = await (
    await request.get(`/api/workflows/${w.id}/engineering`)
  ).json();
  expect(latest.spec.version_number).toBe(2);
  expect(latest.versions).toHaveLength(0);
  const historical = await (
    await request.get(`/api/workflows/${w.id}/engineering?spec=${v1.id}`)
  ).json();
  expect(historical.spec.board).toEqual(v1.graph);
  expect(historical.versions).toHaveLength(1);
  await page.getByLabel("Frozen process version").selectOption(v1.id);
  await expect(
    page.getByRole("button", { name: "Revise plan", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Agent", exact: true }).click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  await page.getByLabel("Frozen process version").selectOption(latest.spec.id);
  await page
    .getByRole("button", { name: "Implementation", exact: true })
    .click();
  const changedNames = [
    "Read purchase request",
    "Validate purchase approval",
    "Record decision",
  ];
  for (const name of changedNames) {
    const box = page.getByRole("checkbox", {
      name: `Approve ${name}`,
      exact: true,
    });
    await box.click();
    await expect(box).toBeChecked();
  }
  await page.getByRole("button", { name: "Approve plan", exact: true }).click();
  await page
    .getByRole("button", { name: "Generate agent", exact: true })
    .click();
  await expect(page.getByLabel("Source code", { exact: true })).toBeVisible();
  const generated = await (
    await request.get(`/api/workflows/${w.id}/engineering`)
  ).json();
  expect(generated.versions).toHaveLength(1);
  expect(generated.versions[0].plan_version_id).toBe(latest.plans[0].id);
});
