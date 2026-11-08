import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx, many, one } from "../src/db.js";
import { addGoal } from "../src/goals.js";
import { addTask, updateTask } from "../src/tasks.js";
import {
  acceptSuggestion,
  addRule,
  currentAttribution,
  manualAssign,
  suggestAttribution,
  updateRule,
} from "../src/attribution.js";
import {
  addExclusion,
  importObservations,
  pauseCapture,
  recordObservation,
  resumeCapture,
} from "../src/activity.js";
import { recordSourceFailure, sourceStates } from "../src/activity.js";
import { sessionMetrics } from "../src/metrics.js";
import { startSession } from "../src/sessions.js";
import { display } from "../src/ids.js";
import { zonedToUtc } from "../src/time.js";

function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "day-attr-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
  });
  const goal = addGoal(ctx, { title: "Goal", criteria: ["Criterion"] });
  const first = addTask(ctx, { title: "First" });
  const second = addTask(ctx, { title: "Second" });
  for (const task of [first, second]) {
    updateTask(ctx, task.id, {
      goalRefs: [display("goal", goal.goalId)],
      urgency: "not_urgent",
      importance: "high",
    });
  }
  return { ctx, directory, goal, first, second };
}

function at(time: string): string {
  return zonedToUtc("2026-09-25", time, "Europe/Warsaw").toISOString();
}

test("observations upsert by source, bucket, and event ID", () => {
  const { ctx, directory, first } = setup();
  try {
    addRule(ctx, { taskId: first.id, matchType: "project", pattern: "/work" });
    recordObservation(ctx, {
      source: "tmux",
      bucket: "b",
      eventId: "same",
      start: at("09:00"),
      end: at("09:10"),
      project: "/work",
    });
    recordObservation(ctx, {
      source: "tmux",
      bucket: "b",
      eventId: "same",
      start: at("09:00"),
      end: at("09:15"),
      project: "/work",
    });
    const rows = many<{ id: number; end_utc: string; revision: number }>(
      ctx.db,
      "SELECT * FROM observations",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.end_utc, at("09:15"));
    assert.equal(rows[0]?.revision, 2);
    const state = sourceStates(ctx).find((row) => row.source === "tmux");
    assert.equal(state?.last_checkpoint, at("09:15"));
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("late import keeps the latest checkpoint", () => {
  const { ctx, directory } = setup();
  try {
    importObservations(ctx, "activitywatch", [
      { event_id: "late", start: at("08:00"), end: at("08:10"), project: "/work" },
      { event_id: "later", start: at("09:00"), end: at("09:10"), project: "/work" },
    ]);
    importObservations(ctx, "activitywatch", [
      { event_id: "late", start: at("08:00"), end: at("08:20"), project: "/work" },
    ]);
    const rows = many<{ event_id: string; end_utc: string }>(
      ctx.db,
      "SELECT event_id, end_utc FROM observations",
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.event_id === "late")?.end_utc, at("08:20"));
    const state = sourceStates(ctx).find((row) => row.source === "activitywatch");
    assert.equal(state?.last_checkpoint, at("09:10"));
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("three adapter errors mark a source stale and keep its checkpoint", () => {
  const { ctx, directory } = setup();
  try {
    importObservations(ctx, "activitywatch", [
      { event_id: "ok", start: at("09:00"), end: at("09:10"), project: "/work" },
    ]);
    recordSourceFailure(ctx, "activitywatch", "timeout");
    recordSourceFailure(ctx, "activitywatch", "timeout");
    recordSourceFailure(ctx, "activitywatch", "timeout");
    const state = sourceStates(ctx).find((row) => row.source === "activitywatch");
    assert.equal(state?.stale, 1);
    assert.equal(state?.last_checkpoint, at("09:10"));
    assert.equal(state?.consecutive_errors, 3);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("equal-rank rule conflicts stay ambiguous", () => {
  const { ctx, directory, first, second } = setup();
  try {
    addRule(ctx, { taskId: first.id, matchType: "project", pattern: "/work", rank: 1 });
    addRule(ctx, { taskId: second.id, matchType: "project", pattern: "/work", rank: 1 });
    const result = recordObservation(ctx, {
      source: "tmux",
      eventId: "conflict",
      start: at("09:00"),
      end: at("09:10"),
      project: "/work",
    });
    assert.ok(result.observation);
    const attribution = currentAttribution(ctx, result.observation.id);
    assert.equal(attribution?.status, "ambiguous");
    assert.equal(attribution?.task_id, null);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rule revisions are recorded on attributions", () => {
  const { ctx, directory, first } = setup();
  try {
    const rule = addRule(ctx, { taskId: first.id, matchType: "project", pattern: "/work" });
    updateRule(ctx, rule.id, { pattern: "/work-v2" });
    const result = recordObservation(ctx, {
      source: "tmux",
      eventId: "revision",
      start: at("09:00"),
      end: at("09:10"),
      project: "/work-v2",
    });
    assert.ok(result.observation);
    const attribution = currentAttribution(ctx, result.observation.id);
    assert.equal(attribution?.rule_id, rule.id);
    assert.equal(attribution?.rule_version, 2);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("pause, exclusion, and invalid intervals stay visible without content", () => {
  const { ctx, directory } = setup();
  try {
    addExclusion(ctx, "app", "vault");
    const excluded = recordObservation(ctx, {
      source: "desktop",
      eventId: "secret",
      start: at("09:00"),
      end: at("09:10"),
      app: "Vault",
    });
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.observation, null);
    const coverage = one<{ status: string }>(
      ctx.db,
      "SELECT status FROM coverage_intervals WHERE status = 'excluded'",
    );
    assert.equal(coverage?.status, "excluded");

    const invalid = recordObservation(ctx, {
      source: "tmux",
      eventId: "invalid",
      start: at("09:20"),
      end: at("09:10"),
      project: "/work",
    });
    assert.equal(invalid.invalidReason, "negative_duration");
    assert.ok(invalid.observation);
    assert.equal(invalid.observation.demo, 0);

    const impossible = recordObservation(ctx, {
      source: "tmux",
      eventId: "impossible",
      start: "1960-01-01T00:00:00.000Z",
      end: "1960-01-01T00:10:00.000Z",
      project: "/work",
    });
    assert.equal(impossible.invalidReason, "impossible_timestamp");
    assert.ok(impossible.observation);

    const idle = recordObservation(ctx, {
      source: "desktop",
      eventId: "idle",
      start: at("09:40"),
      end: at("09:50"),
      project: "/work",
      idle: true,
    });
    assert.equal(idle.attributionRef, null);
    assert.equal(currentAttribution(ctx, idle.observation?.id ?? 0), undefined);

    pauseCapture(ctx, "private call");
    assert.throws(
      () =>
        recordObservation(ctx, {
          source: "tmux",
          eventId: "paused",
          start: at("09:30"),
          end: at("09:40"),
          project: "/work",
        }),
      /paused/,
    );
    resumeCapture(ctx);
    const paused = one<{ status: string }>(
      ctx.db,
      "SELECT status FROM coverage_intervals WHERE status = 'paused'",
    );
    assert.equal(paused?.status, "paused");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("manual correction preserves the previous attribution revision", () => {
  const { ctx, directory, first, second } = setup();
  try {
    const session = startSession(ctx, {
      taskId: first.id,
      durationSeconds: 1800,
      start: zonedToUtc("2026-09-25", "09:00", "Europe/Warsaw"),
    });
    addRule(ctx, { taskId: first.id, matchType: "project", pattern: "/work" });
    const result = recordObservation(ctx, {
      source: "tmux",
      eventId: "manual",
      start: at("09:00"),
      end: at("09:30"),
      project: "/work",
    });
    assert.ok(result.observation);
    manualAssign(ctx, {
      sessionId: session.id,
      from: zonedToUtc("2026-09-25", "09:00", "Europe/Warsaw"),
      to: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
      taskId: second.id,
      reason: "Actually this was the second task",
    });
    const history = many<{
      id: number;
      revision: number;
      superseded_by: number | null;
      task_id: number;
    }>(
      ctx.db,
      "SELECT id, revision, superseded_by, task_id FROM attributions WHERE observation_id = ? ORDER BY revision",
      result.observation.id,
    );
    assert.equal(history.length, 2);
    assert.equal(history[0]?.task_id, first.id);
    assert.equal(history[0]?.superseded_by, history[1]?.id);
    assert.equal(history[1]?.task_id, second.id);
    const metrics = sessionMetrics(ctx, session);
    assert.equal(metrics.accepted_seconds, 0);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("agent suggestions require an explicit acceptance", () => {
  const { ctx, directory, first } = setup();
  try {
    const result = recordObservation(ctx, {
      source: "browser",
      eventId: "suggest",
      start: at("09:00"),
      end: at("09:10"),
      url: "https://example.com/",
    });
    assert.ok(result.observation);
    const suggestion = suggestAttribution(ctx, {
      observationId: result.observation.id,
      taskId: first.id,
      method: "llm",
      modelVersion: "demo-1",
      uncertainty: 0.4,
    });
    assert.equal(suggestion.status, "proposed");
    assert.equal(currentAttribution(ctx, result.observation.id)?.status, "unassigned");
    const accepted = acceptSuggestion(ctx, suggestion.id, "Checked the page");
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.method, "agent_accepted");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
