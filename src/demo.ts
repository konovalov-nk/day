import type { Ctx } from "./db.js";
import { getMeta, one, run, setMeta } from "./db.js";
import { display } from "./ids.js";
import { addGoal } from "./goals.js";
import { addTask, updateTask } from "./tasks.js";
import { addEvent } from "./events.js";
import { startSession } from "./sessions.js";
import { addRule } from "./attribution.js";
import { recordObservation } from "./activity.js";
import { addNote } from "./notes.js";
import { addExperiment } from "./experiments.js";
import { evaluateIntentionalDay } from "./evaluations.js";
import { addDays, localDateAt, zonedToUtc } from "./time.js";

export interface DemoResult {
  goal: string;
  tasks: string[];
  event: string;
  session: string;
  rules: string[];
  observations: string[];
  progress: string;
  note: string;
  experiment: string;
  evaluation: string;
}

export function demoSeed(ctx: Ctx): { seeded: boolean; result: DemoResult } {
  const existing = getMeta(ctx.db, "demo_seed");
  if (existing) {
    return { seeded: false, result: JSON.parse(existing) as DemoResult };
  }
  const today = localDateAt(ctx.now(), ctx.timezone);
  const goal = addGoal(ctx, {
    title: "Publish a post about Day",
    criteria: ["The post is available at a public URL"],
    catalog: "personal",
  });
  const goalRef = display("goal", goal.goalId);
  const task = addTask(ctx, { title: "Write the introduction" });
  updateTask(ctx, task.id, {
    goalRefs: [goalRef],
    urgency: "not_urgent",
    importance: "high",
  });
  const groceries = addTask(ctx, { title: "Buy groceries" });
  const urgent = addTask(ctx, { title: "Reply to the editor" });
  updateTask(ctx, urgent.id, { urgency: "urgent", importance: "high" });
  const meeting = addEvent(ctx, {
    title: "Team meeting",
    start: zonedToUtc(today, "11:00", ctx.timezone),
    end: zonedToUtc(today, "11:30", ctx.timezone),
    reminderMinutes: 10,
  });
  const session = startSession(ctx, {
    taskId: task.id,
    durationSeconds: 30 * 60,
    start: zonedToUtc(today, "09:00", ctx.timezone),
    allowOverlap: true,
  });
  const ruleProject = addRule(ctx, {
    taskId: task.id,
    matchType: "project",
    pattern: "~/git/blog",
  });
  const ruleUrl = addRule(ctx, {
    taskId: task.id,
    matchType: "url",
    pattern: "https://activitywatch.net/",
  });
  const first = recordObservation(ctx, {
    source: "tmux",
    bucket: "demo",
    eventId: "demo-1",
    start: zonedToUtc(today, "09:00", ctx.timezone).toISOString(),
    end: zonedToUtc(today, "09:24", ctx.timezone).toISOString(),
    project: "~/git/blog",
    tmuxSession: "work",
    tmuxWindow: "1",
    tmuxPane: "0",
    demo: true,
  });
  const second = recordObservation(ctx, {
    source: "browser",
    bucket: "demo",
    eventId: "demo-2",
    start: zonedToUtc(today, "09:24", ctx.timezone).toISOString(),
    end: zonedToUtc(today, "09:30", ctx.timezone).toISOString(),
    app: "firefox",
    url: "https://news.example/",
    demo: true,
  });
  const progress = run(
    ctx.db,
    `INSERT INTO progress_entries (task_id, session_id, status, summary, created_at)
     VALUES (?, ?, 'progress', ?, ?)`,
    task.id,
    session.id,
    "Drafted the introduction. Next: add an example.",
    zonedToUtc(today, "09:20", ctx.timezone).toISOString(),
  );
  const note = addNote(ctx, {
    text: "Keeping the calendar visible helped me return after checking messages.",
    links: [{ kind: "session", ref: display("session", session.id) }],
  });
  const experiment = addExperiment(ctx, {
    title: "Keep the calendar visible",
    hypothesis: "A visible calendar helps me return to planned work",
    change: "Keep the daily dashboard on the second screen",
    metric: "session-adherence",
    baseline: `${addDays(today, -7)}..${addDays(today, -1)}`,
    period: `${today}..${addDays(today, 6)}`,
    noteIds: [note.id],
  });
  const evaluation = evaluateIntentionalDay(ctx, today);
  const result: DemoResult = {
    goal: goalRef,
    tasks: [display("task", task.id), display("task", groceries.id), display("task", urgent.id)],
    event: display("event", meeting.id),
    session: display("session", session.id),
    rules: [display("rule", ruleProject.id), display("rule", ruleUrl.id)],
    observations: [
      first.observation ? display("observation", first.observation.id) : "none",
      second.observation ? display("observation", second.observation.id) : "none",
    ],
    progress: display("progress", Number(progress.lastInsertRowid)),
    note: display("note", note.id),
    experiment: experiment.ref,
    evaluation: evaluation.ref,
  };
  setMeta(ctx.db, "demo_seed", JSON.stringify(result));
  return { seeded: true, result };
}

export function demoStatus(ctx: Ctx): boolean {
  return (
    Boolean(getMeta(ctx.db, "demo_seed")) &&
    Boolean(one<{ id: number }>(ctx.db, "SELECT id FROM sessions LIMIT 1"))
  );
}
