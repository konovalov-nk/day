import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = resolve(ROOT, "src/cli.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runDay(args: string[], env: Record<string, string>): RunResult {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture() {
  const directory = mkdtempSync(resolve(tmpdir(), "day-cli-"));
  const env = {
    DAY_DATA_DIR: directory,
    DAY_DB_PATH: resolve(directory, "day.sqlite"),
    DAY_NOW: "2026-09-25T09:00:00+02:00",
    DAY_PASSWORD: "test",
    DAY_READ_TOKEN: "test-token",
  };
  return { directory, env };
}

test("CLI walkthrough matches the documented outputs", () => {
  const { directory, env } = fixture();
  try {
    assert.equal(runDay(["setup"], env).status, 0);
    const goal = runDay(
      [
        "goal",
        "add",
        "Publish a post about Day",
        "--criterion",
        "The post is available at a public URL",
      ],
      env,
    );
    assert.equal(goal.status, 0);
    assert.match(goal.stdout, /Goal: G02/);
    assert.match(goal.stdout, /Criterion: GC04/);
    const task = runDay(["task", "add", "Write the introduction"], env);
    assert.match(task.stdout, /Created: T01/);
    assert.match(task.stdout, /Category: inbox/);
    const update = runDay(
      ["task", "update", "T01", "--goal", "G02", "--importance", "high", "--urgent", "no"],
      env,
    );
    assert.match(update.stdout, /Category: non-urgent, high priority/);
    assert.match(update.stdout, /State: ready/);
    const list = runDay(["task", "list"], env);
    assert.match(list.stdout, /Non-urgent \+ high priority: +1\s+T01 Write the introduction/);

    const start = runDay(["task", "start", "T01", "--duration", "30m"], env);
    assert.match(start.stdout, /Session: S01/);
    assert.match(start.stdout, /Calendar block: E01, 09:00–09:30/);
    assert.match(start.stdout, /State: running/);

    const rule = runDay(["rule", "add", "--task", "T01", "--project", "~/git/blog"], env);
    assert.match(rule.stdout, /Rule: R01, version 1/);
    assert.match(rule.stdout, /Assign matched activity to: T01/);

    const lateEnv = { ...env, DAY_NOW: "2026-09-25T09:30:00+02:00" };
    const first = runDay(
      [
        "activity",
        "record",
        "--source",
        "tmux",
        "--start",
        "09:00",
        "--end",
        "09:24",
        "--project",
        "~/git/blog",
      ],
      lateEnv,
    );
    assert.match(first.stdout, /Observation: O01/);
    assert.match(first.stdout, /Attribution: A01/);
    const second = runDay(
      [
        "activity",
        "record",
        "--source",
        "browser",
        "--start",
        "09:24",
        "--end",
        "09:30",
        "--url",
        "https://news.example/",
      ],
      lateEnv,
    );
    assert.match(second.stdout, /Attribution: A02/);

    const session = runDay(["session", "show", "S01"], lateEnv);
    assert.match(session.stdout, /Task T01: 24m/);
    assert.match(session.stdout, /Unassigned: 6m/);
    assert.match(session.stdout, /Session adherence: 80% \(24m \/ 30m\)/);

    const explain = runDay(["activity", "explain", "--session", "S01", "--at", "09:10"], lateEnv);
    assert.match(explain.stdout, /Rule: R01, version 1/);
    assert.match(explain.stdout, /Method: project_rule/);

    const assign = runDay(
      [
        "activity",
        "assign",
        "--session",
        "S01",
        "--from",
        "09:24",
        "--to",
        "09:30",
        "--task",
        "T01",
        "--reason",
        "Read a source for the introduction",
      ],
      lateEnv,
    );
    assert.match(assign.stdout, /Method: manual correction/);
    assert.match(assign.stdout, /Session adherence after recalculation: 100%/);

    const end = runDay(
      ["session", "end", "S01", "--progress", "Drafted the introduction. Next: add an example."],
      lateEnv,
    );
    assert.match(end.stdout, /Session S01: ended at 09:30/);
    assert.match(end.stdout, /Progress entry: P01/);
    assert.match(end.stdout, /Task T01: paused, not completed/);

    const check = runDay(["goal", "check", "intentional-day", "--date", "today"], lateEnv);
    assert.match(check.stdout, /Qualifying tasks: 1 \/ 2/);
    assert.match(check.stdout, /Goal time:\s+30m \/ 3h/);
    assert.match(check.stdout, /Progress entries: 1 \/ 1/);
    assert.match(check.stdout, /Final daily result: pending/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("JSON output is versioned and errors use stable codes", () => {
  const { directory, env } = fixture();
  try {
    runDay(["setup"], env);
    const created = runDay(["task", "add", "JSON task", "--json"], env);
    assert.equal(created.status, 0);
    const parsed = JSON.parse(created.stdout) as {
      schema_version: number;
      ref: string;
      state: string;
    };
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.ref, "T01");
    assert.equal(parsed.state, "inbox");
    const missing = runDay(["task", "show", "T99", "--json"], env);
    assert.notEqual(missing.status, 0);
    const error = JSON.parse(missing.stderr) as { error: { code: string } };
    assert.equal(error.error.code, "task_not_found");
    const invalid = runDay(["task", "start", "T01", "--duration", "0m"], env);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid_duration/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("operation IDs make retries idempotent", () => {
  const { directory, env } = fixture();
  try {
    runDay(["setup"], env);
    const first = runDay(["task", "add", "Retry-safe", "--op-id", "op-fixed"], env);
    const second = runDay(["task", "add", "Retry-safe", "--op-id", "op-fixed"], env);
    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.match(second.stdout, /Created: T01/);
    const list = runDay(["task", "list", "--json"], env);
    const body = JSON.parse(list.stdout) as { inbox: unknown[] };
    assert.equal(body.inbox.length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("tutorial resumes after a restart without duplicating records", () => {
  const { directory, env } = fixture();
  try {
    runDay(["setup"], env);
    const status = runDay(["tutorial", "status"], env);
    assert.match(status.stdout, /Open the service/);
    const first = runDay(["tutorial", "next"], env);
    assert.match(first.stdout, /Step pending: service/);
    const again = runDay(["tutorial", "status"], env);
    assert.match(again.stdout, /Open the service/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
