import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx } from "../src/db.js";
import { addGoal } from "../src/goals.js";
import { addTask, taskContext, updateTask } from "../src/tasks.js";
import { addRule, manualAssign } from "../src/attribution.js";
import { addEvent } from "../src/events.js";
import { recordObservation } from "../src/activity.js";
import { endSession, sessionShow, startSession } from "../src/sessions.js";
import { sessionMetrics } from "../src/metrics.js";
import { evaluateIntentionalDay, goalCheckText } from "../src/evaluations.js";
import { addNote } from "../src/notes.js";
import { addExperiment } from "../src/experiments.js";
import { buildDashboard, dashboardText } from "../src/dashboard.js";
import { report } from "../src/reports.js";
import { display } from "../src/ids.js";
import { zonedToUtc } from "../src/time.js";

function context() {
  const directory = mkdtempSync(resolve(tmpdir(), "day-test-"));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
    timezone: "Europe/Warsaw",
  });
  return { ctx, directory };
}

function at(time: string): string {
  return zonedToUtc("2026-09-25", time, "Europe/Warsaw").toISOString();
}

test("the documented task cycle produces explainable metrics", () => {
  const { ctx, directory } = context();
  try {
    const goal = addGoal(ctx, {
      title: "Publish a post about Day",
      criteria: ["The post is available at a public URL"],
    });
    addEvent(ctx, {
      title: "Team meeting",
      start: zonedToUtc("2026-09-25", "11:00", "Europe/Warsaw"),
      end: zonedToUtc("2026-09-25", "11:30", "Europe/Warsaw"),
      reminderMinutes: 10,
    });
    const task = addTask(ctx, { title: "Write the introduction" });
    updateTask(ctx, task.id, {
      goalRefs: [display("goal", goal.goalId)],
      urgency: "not_urgent",
      importance: "high",
    });
    const session = startSession(ctx, {
      taskId: task.id,
      durationSeconds: 1800,
      start: zonedToUtc("2026-09-25", "09:00", "Europe/Warsaw"),
    });
    addRule(ctx, { taskId: task.id, matchType: "project", pattern: "~/git/blog" });
    recordObservation(ctx, {
      source: "tmux",
      eventId: "one",
      start: at("09:00"),
      end: at("09:24"),
      project: "~/git/blog",
    });
    recordObservation(ctx, {
      source: "browser",
      eventId: "two",
      start: at("09:24"),
      end: at("09:30"),
      url: "https://news.example/",
      app: "firefox",
    });

    const before = sessionMetrics(ctx, session);
    assert.equal(before.planned_seconds, 1800);
    assert.equal(before.accepted_seconds, 1440);
    assert.equal(before.unassigned_seconds, 360);
    assert.equal(before.coverage, 1);
    assert.equal(before.adherence, 0.8);
    assert.equal(before.adherence_status, "met");

    manualAssign(ctx, {
      sessionId: session.id,
      from: zonedToUtc("2026-09-25", "09:24", "Europe/Warsaw"),
      to: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
      taskId: task.id,
      reason: "Read a source for the introduction",
    });
    const after = sessionMetrics(ctx, session);
    assert.equal(after.accepted_seconds, 1800);
    assert.equal(after.adherence, 1);

    const ended = endSession(ctx, session.id, {
      progress: "Drafted the introduction. Next: add an example.",
      artifact: "~/git/blog/posts/day.md",
    });
    assert.equal(ended.session.state, "ended");
    const shown = sessionShow(ctx, session.id);
    assert.equal(shown.progress.length, 1);
    assert.equal(shown.attribution.filter((row) => row.status === "accepted").length, 2);

    const evaluation = evaluateIntentionalDay(ctx, "2026-09-25");
    assert.equal(evaluation.final_status, "pending");
    assert.equal(evaluation.results[0]?.value, 1);
    assert.equal(evaluation.results[1]?.value, 1800);
    assert.equal(evaluation.results[2]?.status, "met");
    assert.match(
      goalCheckText(evaluation, ctx.now(), ctx.timezone).join("\n"),
      /Qualifying tasks: 1 \/ 2/,
    );

    const dashboard = buildDashboard(ctx, "2026-09-25");
    assert.equal(dashboard.current_task, null);
    assert.equal(dashboard.ready_to_continue?.task_ref, display("task", task.id));
    assert.equal(dashboard.next_event?.title, "Team meeting");
    assert.equal(dashboard.task_groups.urgent_high?.length, 0);
    assert.match(dashboardText(dashboard).join("\n"), /Ready to continue: T01/);

    const contextView = taskContext(ctx, task.id);
    assert.equal(contextView.schema_version, 1);
    assert.equal(contextView.progress_entries.length, 1);
    assert.ok(contextView.related_activity.length >= 2);

    const note = addNote(ctx, {
      text: "Calendar visible helped.",
      links: [{ kind: "session", ref: display("session", session.id) }],
    });
    assert.equal(note.ref, "N01");

    const experiment = addExperiment(ctx, {
      title: "Keep the calendar visible",
      hypothesis: "A visible calendar helps return to planned work",
      metric: "session-adherence",
      baseline: "2026-09-18..2026-09-24",
      period: "2026-09-25..2026-10-01",
    });
    assert.equal(experiment.baseline.status, "insufficient_data");
    assert.equal(experiment.period.status, "available");

    const dayReport = report(ctx, "day", "2026-09-25");
    assert.equal(dayReport.totals.accepted_seconds, 1800);
    assert.equal(dayReport.totals.goal_seconds, 1800);
    assert.equal(dayReport.by_task[0]?.ref, "T01");
    assert.equal(dayReport.sessions[0]?.ref, "S01");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two tasks with adequate coverage meet the two-task target", () => {
  const { ctx, directory } = context();
  try {
    const goal = addGoal(ctx, { title: "Goal", criteria: ["Criterion"] });
    const goalRef = display("goal", goal.goalId);
    for (const [index, time] of [
      [1, "08:00"],
      [2, "10:00"],
    ] as const) {
      const task = addTask(ctx, { title: `Task ${index}` });
      updateTask(ctx, task.id, {
        goalRefs: [goalRef],
        urgency: "not_urgent",
        importance: "high",
      });
      const session = startSession(ctx, {
        taskId: task.id,
        durationSeconds: 1800,
        start: zonedToUtc("2026-09-25", time, "Europe/Warsaw"),
      });
      addRule(ctx, {
        taskId: task.id,
        matchType: "project",
        pattern: `/project-${index}`,
      });
      recordObservation(ctx, {
        source: "tmux",
        eventId: `task-${index}`,
        start: at(time),
        end: at(time.replace(":00", ":30")),
        project: `/project-${index}`,
      });
      endSession(ctx, session.id, { progress: `Progress ${index}` });
    }
    const evaluation = evaluateIntentionalDay(ctx, "2026-09-25");
    assert.equal(evaluation.results[0]?.status, "met");
    assert.equal(evaluation.results[0]?.value, 2);
    assert.equal(evaluation.results[1]?.status, "not_met");
    assert.equal(evaluation.results[2]?.status, "met");
    assert.equal(evaluation.final_status, "pending");
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
