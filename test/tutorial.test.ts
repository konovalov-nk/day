import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx } from "../src/db.js";
import { demoSeed } from "../src/demo.js";
import { recordObservation } from "../src/activity.js";
import { startServer } from "../src/server.js";
import { tutorialNext, tutorialReset, tutorialStatus } from "../src/tutorial.js";
import { zonedToUtc } from "../src/time.js";

test("the tutorial completes only with a real observation and resumes safely", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "day-tutorial-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
    password: "test",
    readToken: "test-token",
  });
  const server = await startServer(ctx, { port: 0 });
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    demoSeed(ctx);
    let result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "service");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "goal");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "task");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "block");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, null);
    assert.match(result.check.hint ?? "", /demo/i);

    recordObservation(ctx, {
      source: "tmux",
      eventId: "real-tutorial",
      start: zonedToUtc("2026-09-25", "09:00", "Europe/Warsaw").toISOString(),
      end: zonedToUtc("2026-09-25", "09:10", "Europe/Warsaw").toISOString(),
      project: "~/git/blog",
      tmuxSession: "work",
    });
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "observation");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "attribution");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "progress");
    result = await tutorialNext(ctx, baseUrl);
    assert.equal(result.completed_step, "website");
    assert.equal(result.complete, true);
    assert.equal(result.tomorrow.command, "day task start T01 --duration 30m");

    tutorialReset(ctx);
    assert.equal(
      tutorialStatus(ctx).every((step) => step.status === "pending"),
      true,
    );
    const taskCount = ctx.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as {
      count: number;
    };
    assert.equal(taskCount.count, 3);
  } finally {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
