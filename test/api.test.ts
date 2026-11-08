import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createCtx } from "../src/db.js";
import { demoSeed } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { zonedToUtc } from "../src/time.js";

const AUTH = { Authorization: "Bearer test-token" };
const BASIC = { Authorization: `Basic ${Buffer.from("day:test").toString("base64")}` };

async function withServer(
  work: (baseUrl: string, close: () => Promise<void>) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(resolve(tmpdir(), "day-api-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
    readToken: "test-token",
    password: "test",
  });
  demoSeed(ctx);
  const server = await startServer(ctx, { port: 0 });
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await work(`http://127.0.0.1:${port}`, close);
  } finally {
    if (server.listening) await close();
  }
}

test("the protected dashboard is read-only", async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/`)).status, 401);
    const page = await fetch(`${baseUrl}/`, { headers: BASIC });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Read-only view/);
    assert.doesNotMatch(html, /<form/i);
    assert.match(html, /Current task/);
    assert.match(html, /Non-urgent \+ high priority/);
    const unauthorized = await fetch(`${baseUrl}/api/v1/dashboard`);
    assert.equal(unauthorized.status, 401);
    const denied = await fetch(`${baseUrl}/api/v1/dashboard`, {
      method: "POST",
      headers: AUTH,
    });
    assert.equal(denied.status, 405);
  });
});

test("dashboard JSON is a consistent snapshot with all groups and sources", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/dashboard?date=2026-09-25`, { headers: AUTH });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.schema_version, 1);
    assert.equal(body.timezone, "Europe/Warsaw");
    assert.equal(body.date, "2026-09-25");
    assert.equal(body.current_task !== null, true);
    assert.deepEqual(Object.keys(body.task_groups as object).sort(), [
      "inbox",
      "nonurgent_high",
      "nonurgent_low",
      "urgent_high",
      "urgent_low",
    ]);
    assert.equal((body.task_groups as Record<string, unknown[]>).inbox?.length, 1);
    assert.equal(body.stale, false);
    assert.ok(Array.isArray(body.activity));
    assert.ok(Array.isArray(body.sources));
    assert.equal((body.evaluation as { final_status: string }).final_status, "pending");
  });
});

test("task context and session drill-down expose evidence", async () => {
  await withServer(async (baseUrl) => {
    const context = await fetch(`${baseUrl}/api/v1/tasks/T01/context`, { headers: AUTH });
    assert.equal(context.status, 200);
    const task = (await context.json()) as { schema_version: number; related_activity: unknown[] };
    assert.equal(task.schema_version, 1);
    assert.ok(task.related_activity.length >= 1);
    const session = await fetch(`${baseUrl}/api/v1/sessions/S01`, { headers: AUTH });
    assert.equal(session.status, 200);
    const body = (await session.json()) as {
      attribution: Array<{ status: string; method: string }>;
    };
    assert.ok(body.attribution.some((row) => row.status === "accepted"));
    const page = await fetch(`${baseUrl}/session/S01`, { headers: BASIC });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Attribution/);
  });
});

test("history queries are bounded and support all requested periods", async () => {
  await withServer(async (baseUrl) => {
    const tooLarge = await fetch(`${baseUrl}/api/v1/observations?from=2026-01-01&to=2026-12-31`, {
      headers: AUTH,
    });
    assert.equal(tooLarge.status, 400);
    const bounded = await fetch(
      `${baseUrl}/api/v1/observations?from=2026-09-25&to=2026-09-25&limit=10&offset=0`,
      { headers: AUTH },
    );
    assert.equal(bounded.status, 200);
    const body = (await bounded.json()) as { total: number; rows: unknown[] };
    assert.equal(body.total, 2);
    assert.equal(body.rows.length, 2);
    for (const period of ["day", "week", "month", "quarter", "year"]) {
      const response = await fetch(`${baseUrl}/api/v1/report?period=${period}&date=2026-09-25`, {
        headers: AUTH,
      });
      assert.equal(response.status, 200, period);
      const report = (await response.json()) as { totals: { planned_seconds: number } };
      assert.equal(report.totals.planned_seconds, 1800);
    }
  });
});

test("API responses stay under the 500 ms target for cached day data", async () => {
  await withServer(async (baseUrl) => {
    const durations: number[] = [];
    for (let index = 0; index < 30; index += 1) {
      const start = performance.now();
      const response = await fetch(`${baseUrl}/api/v1/dashboard?date=2026-09-25`, {
        headers: AUTH,
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      durations.push(performance.now() - start);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? Infinity;
    assert.ok(p95 < 500, `p95 was ${p95.toFixed(1)} ms`);
  });
});
