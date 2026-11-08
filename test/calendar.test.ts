import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx } from "../src/db.js";
import { addGoal } from "../src/goals.js";
import { addTask, updateTask } from "../src/tasks.js";
import { addEvent, occurrencesBetween, updateOccurrence, cancelEvent } from "../src/events.js";
import { scheduleSession, startSession, retimeSession, requireSession } from "../src/sessions.js";
import { recordObservation } from "../src/activity.js";
import { importCalendarEvents } from "../src/calendar-import.js";
import { display } from "../src/ids.js";
import { formatDateShort, zonedToUtc } from "../src/time.js";

function setup() {
  const directory = mkdtempSync(resolve(tmpdir(), "day-cal-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
  });
  const goal = addGoal(ctx, { title: "Goal", criteria: ["Criterion"] });
  const task = addTask(ctx, { title: "Task" });
  updateTask(ctx, task.id, {
    goalRefs: [display("goal", goal.goalId)],
    urgency: "not_urgent",
    importance: "high",
  });
  return { ctx, directory, task };
}

function at(date: string, time: string): Date {
  return zonedToUtc(date, time, "Europe/Warsaw");
}

test("recurring events expand and one occurrence can change without the series", () => {
  const { ctx, directory } = setup();
  try {
    const event = addEvent(ctx, {
      title: "Daily review",
      start: at("2026-09-21", "10:00"),
      end: at("2026-09-21", "10:30"),
      recurrence: "FREQ=DAILY",
      recurrenceUntil: "2026-09-27",
    });
    const first = occurrencesBetween(ctx, at("2026-09-21", "00:00"), at("2026-09-24", "00:00"));
    assert.equal(first.length, 3);
    assert.deepEqual(
      first.map((item) => item.local_date),
      ["2026-09-21", "2026-09-22", "2026-09-23"],
    );
    updateOccurrence(ctx, event, "2026-09-22", { title: "Changed occurrence" });
    const second = occurrencesBetween(ctx, at("2026-09-21", "00:00"), at("2026-09-24", "00:00"));
    assert.equal(second[1]?.title, "Changed occurrence");
    assert.equal(second[0]?.title, "Daily review");
    assert.equal(second[2]?.title, "Daily review");
    updateOccurrence(ctx, event, "2026-09-23", { status: "cancelled" });
    const third = occurrencesBetween(ctx, at("2026-09-21", "00:00"), at("2026-09-24", "00:00"));
    assert.equal(third.length, 2);
    assert.equal(cancelEvent(ctx, event.id).status, "cancelled");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("calendar import reconciles unchanged revisions", () => {
  const { ctx, directory } = setup();
  try {
    const file = resolve(directory, "events.json");
    const record = {
      source: "google",
      id: "evt-1",
      title: "Imported",
      start: at("2026-09-25", "12:00").toISOString(),
      end: at("2026-09-25", "12:30").toISOString(),
      external_revision: "rev-1",
    };
    writeFileSync(file, JSON.stringify([record]));
    assert.deepEqual(importCalendarEvents(ctx, file), { imported: 1, updated: 0, unchanged: 0 });
    assert.deepEqual(importCalendarEvents(ctx, file), { imported: 0, updated: 0, unchanged: 1 });
    writeFileSync(
      file,
      JSON.stringify([{ ...record, title: "Imported v2", external_revision: "rev-2" }]),
    );
    assert.deepEqual(importCalendarEvents(ctx, file), { imported: 0, updated: 1, unchanged: 0 });
    const events = occurrencesBetween(ctx, at("2026-09-25", "00:00"), at("2026-09-26", "00:00"));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.title, "Imported v2");
    assert.equal(events[0]?.external_revision, "rev-2");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sessions create blocks, detect collisions, and keep plan revisions", () => {
  const { ctx, directory, task } = setup();
  try {
    addEvent(ctx, {
      title: "Meeting",
      start: at("2026-09-25", "09:00"),
      end: at("2026-09-25", "09:30"),
    });
    assert.throws(
      () =>
        startSession(ctx, {
          taskId: task.id,
          durationSeconds: 1800,
          start: at("2026-09-25", "09:00"),
        }),
      /overlaps/,
    );
    const scheduled = scheduleSession(ctx, {
      taskId: task.id,
      start: at("2026-09-25", "09:30"),
      durationSeconds: 1800,
    });
    assert.equal(scheduled.state, "planned");
    assert.ok(scheduled.event_id);
    recordObservation(ctx, {
      source: "tmux",
      eventId: "cal-1",
      start: at("2026-09-25", "09:30").toISOString(),
      end: at("2026-09-25", "10:00").toISOString(),
      project: "/work",
    });
    const retimed = retimeSession(
      ctx,
      scheduled.id,
      at("2026-09-25", "10:00"),
      at("2026-09-25", "10:30"),
    );
    assert.equal(retimed.plan_revision, 2);
    const plans = ctx.db
      .prepare("SELECT * FROM session_plan_revisions WHERE session_id = ?")
      .all(scheduled.id) as Array<{ revision: number }>;
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.revision, 1);
    assert.equal(
      requireSession(ctx, scheduled.id).planned_start,
      at("2026-09-25", "10:00").toISOString(),
    );
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a task without a goal cannot start", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "day-cal-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
  });
  try {
    const task = addTask(ctx, { title: "No goal" });
    assert.throws(
      () =>
        startSession(ctx, {
          taskId: task.id,
          durationSeconds: 600,
          start: at("2026-09-25", "09:30"),
        }),
      /needs a goal/,
    );
    assert.match(formatDateShort("2026-09-25"), /25/);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
