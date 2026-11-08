import type { Ctx } from "./db.js";
import { many, one, run } from "./db.js";
import { display } from "./ids.js";

export interface TutorialStep {
  id: string;
  title: string;
  hint: string;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  { id: "service", title: "Open the service", hint: "Run `make start`, then `day tutorial next`." },
  {
    id: "goal",
    title: "Create a goal with a criterion",
    hint: 'Run `day goal add "..." --criterion "..."`.',
  },
  {
    id: "task",
    title: "Create a task and link a goal",
    hint: "Run `day task add ...`, then `day task update ... --goal ...`.",
  },
  {
    id: "block",
    title: "Start a session with a calendar block",
    hint: "Run `day task start T01 --duration 30m`.",
  },
  {
    id: "observation",
    title: "Record a real observation",
    hint: "Run `day activity watch` or `day activity record --source tmux ...`.",
  },
  {
    id: "attribution",
    title: "Connect activity to the task",
    hint: "Add a rule with `day rule add`, or assign the interval.",
  },
  {
    id: "progress",
    title: "Save a progress entry",
    hint: 'Run `day session end S01 --progress "..."`.',
  },
  {
    id: "website",
    title: "See the result on the website",
    hint: "Run `day start`, then open the dashboard.",
  },
];

export function ensureTutorialState(ctx: Ctx): void {
  const timestamp = ctx.now().toISOString();
  for (const step of TUTORIAL_STEPS) {
    run(
      ctx.db,
      "INSERT OR IGNORE INTO tutorial_state (step, status, updated_at) VALUES (?, 'pending', ?)",
      step.id,
      timestamp,
    );
  }
}

export function tutorialStatus(ctx: Ctx) {
  ensureTutorialState(ctx);
  const states = many<{
    step: string;
    status: string;
    evidence: string | null;
    updated_at: string;
  }>(ctx.db, "SELECT * FROM tutorial_state");
  const byStep = new Map(states.map((state) => [state.step, state]));
  return TUTORIAL_STEPS.map((step) => ({
    ...step,
    status: byStep.get(step.id)?.status ?? "pending",
    evidence: byStep.get(step.id)?.evidence ?? null,
  }));
}

type CheckResult = { ok: boolean; evidence: string; hint?: string };
type Check = (ctx: Ctx, baseUrl: string) => CheckResult | Promise<CheckResult>;

const CHECKS: Record<string, Check> = {
  service: async (_ctx, baseUrl) => {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2500) });
      return response.ok
        ? { ok: true, evidence: `${baseUrl}/health returned ${response.status}` }
        : {
            ok: false,
            evidence: `health returned ${response.status}`,
            hint: "Check `day status`.",
          };
    } catch {
      return { ok: false, evidence: "service is not reachable", hint: "Run `make start`." };
    }
  },
  goal: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM goals WHERE (SELECT COUNT(*) FROM goal_criteria WHERE goal_id = goals.id) > 0",
    );
    return row && row.count > 0
      ? { ok: true, evidence: `${row.count} goal(s) with criteria` }
      : { ok: false, evidence: "no goal with a criterion", hint: "Run `day goal add`." };
  },
  task: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM tasks WHERE goal_id IS NOT NULL AND deleted_at IS NULL",
    );
    return row && row.count > 0
      ? { ok: true, evidence: `${row.count} task(s) linked to a goal` }
      : {
          ok: false,
          evidence: "no task linked to a goal",
          hint: "Run `day task update ... --goal ...`.",
        };
  },
  block: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM sessions WHERE event_id IS NOT NULL",
    );
    return row && row.count > 0
      ? { ok: true, evidence: `${row.count} session block(s)` }
      : { ok: false, evidence: "no session with a calendar block", hint: "Run `day task start`." };
  },
  observation: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      `SELECT COUNT(DISTINCT o.id) AS count FROM observations o
       JOIN sessions s ON o.start_utc < s.planned_end AND o.end_utc > s.planned_start
       WHERE o.demo = 0 AND o.invalid_reason IS NULL AND s.actual_start IS NOT NULL`,
    );
    const demo = one<{ count: number }>(
      ctx.db,
      `SELECT COUNT(DISTINCT o.id) AS count FROM observations o
       JOIN sessions s ON o.start_utc < s.planned_end AND o.end_utc > s.planned_start
       WHERE o.demo = 1 AND s.actual_start IS NOT NULL`,
    );
    if (row && row.count > 0) return { ok: true, evidence: `${row.count} real observation(s)` };
    if (demo && demo.count > 0) {
      return {
        ok: false,
        evidence: "only demo observations exist",
        hint: "Demo records cannot complete real tracking. Run `day activity watch`.",
      };
    }
    return {
      ok: false,
      evidence: "no observation overlaps a session",
      hint: "Run `day activity record`.",
    };
  },
  attribution: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      `SELECT COUNT(*) AS count FROM attributions a
       JOIN sessions s ON a.start_utc < s.planned_end AND a.end_utc > s.planned_start
       WHERE a.status = 'accepted' AND a.task_id IS NOT NULL AND a.superseded_by IS NULL`,
    );
    return row && row.count > 0
      ? { ok: true, evidence: `${row.count} accepted attribution(s)` }
      : {
          ok: false,
          evidence: "activity has no accepted task attribution",
          hint: "Run `day rule add --task ... --project ...` and `day activity attribute`.",
        };
  },
  progress: (ctx) => {
    const row = one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM progress_entries WHERE session_id IS NOT NULL",
    );
    return row && row.count > 0
      ? { ok: true, evidence: `${row.count} progress entry(ies)` }
      : {
          ok: false,
          evidence: "no progress entry",
          hint: "Run `day session end ... --progress ...`.",
        };
  },
  website: async (ctx, baseUrl) => {
    try {
      const credentials = Buffer.from(`${ctx.config.user}:${ctx.config.password}`).toString(
        "base64",
      );
      const response = await fetch(baseUrl, {
        headers: { Authorization: `Basic ${credentials}` },
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        return {
          ok: false,
          evidence: `dashboard returned ${response.status}`,
          hint: response.status === 401 ? "Use the credentials from .env" : "Check `day status`.",
        };
      }
      const body = await response.text();
      return body.includes("Current task")
        ? { ok: true, evidence: "authenticated dashboard rendered the task view" }
        : { ok: false, evidence: "dashboard response is missing the task view" };
    } catch {
      return { ok: false, evidence: "dashboard is not reachable", hint: "Run `make start`." };
    }
  },
};

export interface TutorialNextResult {
  complete: boolean;
  completed_step: string | null;
  check: { step: string; ok: boolean; evidence: string; hint?: string };
  next_step: TutorialStep | null;
  tomorrow: {
    website: string;
    last_progress: string | null;
    command: string | null;
  };
  steps: ReturnType<typeof tutorialStatus>;
}

export async function tutorialNext(ctx: Ctx, baseUrl: string): Promise<TutorialNextResult> {
  ensureTutorialState(ctx);
  const status = tutorialStatus(ctx);
  const pending = status.find((step) => step.status !== "done");
  if (!pending) {
    return {
      complete: true,
      completed_step: null,
      check: { step: "complete", ok: true, evidence: "all steps done" },
      next_step: null,
      tomorrow: tomorrow(ctx),
      steps: status,
    };
  }
  const check = CHECKS[pending.id];
  if (!check) throw new Error(`Missing tutorial check for ${pending.id}`);
  const result = await check(ctx, baseUrl);
  if (result.ok) {
    run(
      ctx.db,
      "UPDATE tutorial_state SET status = 'done', evidence = ?, updated_at = ? WHERE step = ?",
      result.evidence,
      ctx.now().toISOString(),
      pending.id,
    );
  }
  const updated = tutorialStatus(ctx);
  const next = updated.find((step) => step.status !== "done") ?? null;
  return {
    complete: !next,
    completed_step: result.ok ? pending.id : null,
    check: { step: pending.id, ...result },
    next_step: next,
    tomorrow: tomorrow(ctx),
    steps: updated,
  };
}

function tomorrow(ctx: Ctx) {
  const progress = one<{ summary: string; task_id: number }>(
    ctx.db,
    "SELECT summary, task_id FROM progress_entries WHERE session_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  return {
    website: ctx.config.baseUrl,
    last_progress: progress?.summary ?? null,
    command: progress ? `day task start ${display("task", progress.task_id)} --duration 30m` : null,
  };
}

export function tutorialReset(ctx: Ctx): void {
  run(ctx.db, "DELETE FROM tutorial_state");
  ensureTutorialState(ctx);
}

export function tutorialText(steps: ReturnType<typeof tutorialStatus>): string[] {
  return steps.map((step) => {
    const mark = step.status === "done" ? "✓" : "·";
    return `${mark} ${step.title}${step.evidence ? ` — ${step.evidence}` : ""}`;
  });
}
