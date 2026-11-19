import { expect, test } from "@playwright/test";

test("question -> cited recommendation", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("question-input").fill("Does retrieval augmentation reduce hallucination in LLMs?");
  const t0 = Date.now();
  await page.getByTestId("submit").click();

  // latency rule: the user sees an agent working in < 2 s
  await expect(page.getByTestId("activity").locator("li").first()).toBeVisible({ timeout: 2_000 });
  expect(Date.now() - t0).toBeLessThan(2_000);

  await expect(page.getByTestId("status")).toHaveAttribute("data-status", "done", { timeout: 30_000 });
  const rec = page.getByTestId("recommendation");
  await expect(rec).toContainText("retrieval augmentation");

  const citations = page.getByTestId("citations").getByRole("link");
  await expect(citations).toHaveCount(2);
  await expect(citations.first()).toHaveAttribute("href", /arxiv\.org\/abs\//);

  // hallucinated evidence id E99 from the fake model must be stripped by the citation verifier
  await expect(rec).not.toContainText("E99");
  await expect(page.getByTestId("hypothesis")).toBeVisible();
  await expect(page.getByTestId("critique")).toHaveCount(1);

  // live activity log shows every agent's actions, and the pipeline marks all agents done
  const log = page.getByTestId("activity");
  for (const agent of ["planner", "arxiv", "ranker", "reader", "synthesis", "critic", "final", "verifier"]) {
    await expect(log).toContainText(agent);
    await expect(page.locator(`[data-agent="${agent}"]`)).toHaveAttribute("data-state", "done");
  }
  await expect(log).toContainText("1 unverifiable id(s) stripped");

  // stance: 2 supporting vs 1 contradicting (full-text E3), shown as balance + graph node
  await expect(page.getByTestId("balance")).toContainText("2 supporting");
  await expect(page.getByTestId("balance")).toContainText("1 contradicting");
  const graph = page.getByTestId("evidence-graph");
  await expect(graph.locator('[data-node="E3"]')).toBeVisible();
  await expect(graph.locator('[data-node="H"]')).toBeVisible();

  // hover card reveals the passage behind an evidence chip
  const chip = rec.getByTestId("evidence-chip").first();
  await chip.hover();
  await expect(rec.getByTestId("evidence-card").first()).toBeVisible();
  await expect(rec.getByTestId("evidence-card").first()).toContainText("match");
});

test("too-short question shows validation error", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("question-input").fill("short");
  await page.getByTestId("submit").click();
  await expect(page.getByTestId("error")).toContainText("at least 10 characters");
});
