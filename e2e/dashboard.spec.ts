import { test, expect } from "@playwright/test";

const BASE = "http://127.0.0.1:3139";

test("the dashboard shows the day and is read-only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Friday, 25 September 2026/ })).toBeVisible();
  await expect(page.locator(".current").getByText("T01 Write the introduction")).toBeVisible();
  await expect(page.locator(".calendar").getByText("Team meeting")).toBeVisible();
  await expect(page.getByText("Non-urgent + high priority")).toBeVisible();
  await expect(page.getByText("Read-only view.")).toBeVisible();
  await expect(page.locator("form")).toHaveCount(0);
  await expect(page.locator("button")).toHaveCount(0);
  await expect(page.getByText("Sources")).toBeVisible();
});

for (const width of [390, 768, 1440]) {
  test(`no horizontal scroll at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Current task")).toBeVisible();
    await expect(page.getByText("Next event")).toBeVisible();
    const scroll = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth);
  });
}

test("activity drill-down shows evidence and progress", async ({ page }) => {
  await page.goto("/");
  await page.locator('.legend a[href="/session/S01"]').first().click();
  await expect(page.getByRole("heading", { name: /S01 · Write the introduction/ })).toBeVisible();
  await expect(page.getByText("Attribution", { exact: true })).toBeVisible();
  await expect(page.getByText("Observations", { exact: true })).toBeVisible();
  await expect(page.getByText("Drafted the introduction. Next: add an example.")).toBeVisible();
  await expect(page.getByText("Method", { exact: true })).toBeVisible();
});

test("the dashboard is protected and read-only over HTTP", async () => {
  const anonymous = await fetch(`${BASE}/api/v1/dashboard`);
  expect(anonymous.status).toBe(401);
  const token = await fetch(`${BASE}/api/v1/dashboard?date=2026-09-25`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(token.status).toBe(200);
  const body = (await token.json()) as Record<string, unknown>;
  expect(body.schema_version).toBe(1);
  expect(Object.keys(body.task_groups as object)).toHaveLength(5);
  const write = await fetch(`${BASE}/api/v1/dashboard`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
  expect(write.status).toBe(405);
  const bounded = await fetch(`${BASE}/api/v1/observations?from=2026-01-01&to=2026-12-31`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(bounded.status).toBe(400);
});

test("all report periods render", async ({ page }) => {
  for (const period of ["day", "week", "month", "quarter", "year"]) {
    await page.goto(`/report?period=${period}&date=2026-09-25`);
    await expect(page.getByText("By task")).toBeVisible();
    await expect(page.getByRole("link", { name: "Week" })).toBeVisible();
  }
});

test("a failed refresh keeps the last view and marks it stale", async ({ page }) => {
  await page.goto("/");
  await page.route("**/partials/dashboard*", (route) => route.abort());
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.locator("#stale")).toBeVisible();
  await expect(page.locator(".current").getByText("T01 Write the introduction")).toBeVisible();
});

test("calendar navigation stays usable", async ({ page }) => {
  await page.goto("/");
  const next = page.getByRole("link", { name: /→/ });
  await expect(next).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading", { name: /Saturday, 26 September 2026/ })).toBeVisible();
  await page.getByRole("link", { name: "Today" }).click();
  await expect(page.getByRole("heading", { name: /Friday, 25 September 2026/ })).toBeVisible();
});
