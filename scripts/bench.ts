import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx } from "../src/db.js";
import { addGoal } from "../src/goals.js";
import { addRule } from "../src/attribution.js";
import { recordObservation } from "../src/activity.js";
import { startServer } from "../src/server.js";
import { addTask, updateTask } from "../src/tasks.js";
import { endSession, startSession } from "../src/sessions.js";
import { addDays, zonedToUtc } from "../src/time.js";
import { display } from "../src/ids.js";

const directory = mkdtempSync(resolve(tmpdir(), "day-bench-"));
const finalDate = "2026-09-24";
const ctx = createCtx({
  dbPath: resolve(directory, "day.sqlite"),
  dataDir: directory,
  now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
  readToken: "bench-token",
});
const goal = addGoal(ctx, { title: "Benchmark goal", criteria: ["Criterion"] });
const task = addTask(ctx, { title: "Benchmark task" });
updateTask(ctx, task.id, {
  goalRefs: [display("goal", goal.goalId)],
  urgency: "not_urgent",
  importance: "high",
});
addRule(ctx, { taskId: task.id, matchType: "project", pattern: "/bench" });

const started = performance.now();
for (let index = 0; index < 365; index += 1) {
  const date = addDays("2025-09-25", index);
  const start = zonedToUtc(date, "09:00", "Europe/Warsaw");
  const end = zonedToUtc(date, "17:00", "Europe/Warsaw");
  const session = startSession(ctx, {
    taskId: task.id,
    durationSeconds: 8 * 3600,
    start,
    allowOverlap: true,
  });
  recordObservation(ctx, {
    source: "tmux",
    eventId: `bench-${date}`,
    start: start.toISOString(),
    end: end.toISOString(),
    project: "/bench",
  });
  endSession(ctx, session.id, { progress: `Benchmark progress ${date}` });
}
process.stdout.write(`Seeded 365 days in ${Math.round(performance.now() - started)} ms\n`);

const server = await startServer(ctx, { port: 0 });
const port = (server.address() as AddressInfo).port;
const headers = { Authorization: "Bearer bench-token" };

async function measure(url: string): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    await response.arrayBuffer();
    values.push(performance.now() - start);
  }
  return values.sort((a, b) => a - b);
}

function summary(values: number[]): string {
  const p50 = values[Math.floor(values.length * 0.5)] ?? Infinity;
  const p95 = values[Math.floor(values.length * 0.95)] ?? Infinity;
  return `p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${Math.max(...values).toFixed(1)} ms`;
}

const dashboard = await measure(`http://127.0.0.1:${port}/api/v1/dashboard?date=${finalDate}`);
const week = await measure(`http://127.0.0.1:${port}/api/v1/report?period=week&date=${finalDate}`);
process.stdout.write(`Dashboard (100 requests): ${summary(dashboard)}\n`);
process.stdout.write(`Week report (100 requests): ${summary(week)}\n`);
if ((dashboard.at(-1) ?? Infinity) > 500 || (week.at(-1) ?? Infinity) > 500) process.exitCode = 1;

await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
ctx.close();
rmSync(directory, { recursive: true, force: true });
