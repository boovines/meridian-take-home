import { test, expect } from "@playwright/test";

test("suggestions populate methods, persist after refresh, and require approval for changed choices", async ({
  page,
  request,
}) => {
  const created = await request.post("/api/workflows", {
    data: {
      name: `Method suggestions ${Date.now()}`,
      desired_outcome: "Read an attachment, ask a person and preview a report.",
    },
  });
  expect(created.ok()).toBe(true);
  const workflow = await created.json();
  const nodes = [];
  for (const [type, title] of [
    ["trigger", "Select packet"],
    ["information", "Read attachment"],
    ["human_approval", "Human decision"],
    ["outcome", "Preview report"],
  ]) {
    const response = await request.post(`/api/workflows/${workflow.id}/nodes`, {
      data: { type, title, instructions: title },
    });
    expect(response.ok()).toBe(true);
    nodes.push(await response.json());
  }
  for (let i = 0; i < nodes.length - 1; i++) {
    expect(
      (
        await request.post(`/api/workflows/${workflow.id}/connections`, {
          data: {
            source_node_id: nodes[i].id,
            target_node_id: nodes[i + 1].id,
          },
        })
      ).ok(),
    ).toBe(true);
  }
  expect(
    (
      await request.post(`/api/workflows/${workflow.id}/reviews`, {
        data: { request_key: crypto.randomUUID() },
      })
    ).ok(),
  ).toBe(true);
  const board = await (
    await request.get(`/api/workflows/${workflow.id}`)
  ).json();
  expect(
    (
      await request.post(`/api/workflows/${workflow.id}/freeze`, {
        data: {
          expected_content_revision: board.workflow.content_revision,
          acknowledge_unreviewed: false,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/workflows/${workflow.id}/engineer`);
  await page
    .getByRole("button", { name: "Create implementation plan" })
    .click();
  const reader = page.getByRole("combobox", {
    name: "Method for Read attachment",
    exact: true,
  });
  const readerApproval = page.getByRole("checkbox", {
    name: "Approve Read attachment",
    exact: true,
  });
  const human = page.getByRole("combobox", {
    name: "Method for Human decision",
    exact: true,
  });
  await expect(reader).toHaveValue("code");
  await readerApproval.click();
  await expect(readerApproval).toBeChecked();
  await expect(readerApproval).toBeEnabled();
  await page.getByRole("button", { name: "Suggest methods" }).click();
  await expect(reader).toHaveValue("agent");
  await expect(readerApproval).not.toBeChecked();
  await expect(human).toHaveValue("human");
  await expect(human).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Generate agent", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(reader).toHaveValue("agent");
  await expect(readerApproval).not.toBeChecked();
  await reader.selectOption("code");
  await expect(reader).toHaveValue("code");
  await expect(readerApproval).not.toBeChecked();
});
