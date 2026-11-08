import type { DashboardData, DashboardTask } from "./dashboard.js";
import type { ReportResult } from "./reports.js";
import { addDays, formatDuration, formatPercent, localTimeAt } from "./time.js";

export function escapeHtml(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const GROUP_LABELS: Record<string, string> = {
  inbox: "Inbox",
  urgent_high: "Urgent + high priority",
  nonurgent_high: "Non-urgent + high priority",
  urgent_low: "Urgent + low priority",
  nonurgent_low: "Non-urgent + low priority",
};

export function renderDashboardMain(data: DashboardData): string {
  return `
<section class="grid top">
  ${renderCurrent(data)}
  ${renderNext(data)}
</section>
<section class="metrics" aria-label="Day metrics">
  ${metric("Planned", formatDuration(data.metrics.planned_seconds))}
  ${metric("Task time", formatDuration(data.metrics.accepted_seconds))}
  ${metric("Goal time", formatDuration(data.metrics.goal_seconds))}
  ${metric("Coverage", formatPercent(data.metrics.coverage))}
  ${metric("Adherence", formatPercent(data.metrics.adherence))}
  ${metric("Unassigned", formatDuration(data.metrics.unassigned_seconds))}
  ${metric("Idle", formatDuration(data.metrics.idle_seconds))}
  ${metric("Missing", formatDuration(data.metrics.missing_seconds))}
</section>
<section class="card">
  <div class="section-head"><h2>Calendar</h2><span class="muted">${data.calendar.length} events</span></div>
  ${renderCalendar(data)}
</section>
<section class="card">
  <div class="section-head">
    <h2>Tasks</h2>
    <span class="muted">${data.counts.inbox} in inbox</span>
  </div>
  <div class="task-groups">
    ${Object.entries(GROUP_LABELS)
      .map(([key, label]) => renderGroup(key, label, data.task_groups[key] ?? []))
      .join("")}
  </div>
</section>
<section class="card">
  <div class="section-head"><h2>Activity</h2><span class="muted">${data.activity.length} segments</span></div>
  ${renderActivity(data)}
</section>
<section class="card" id="sessions">
  <div class="section-head"><h2>Sessions</h2><span class="muted">${data.sessions.length}</span></div>
  ${renderSessions(data)}
</section>
<section class="card">
  <div class="section-head">
    <h2>Sources</h2>
    <span class="badge ${data.stale ? "warn" : ""}">${data.stale ? "stale" : "fresh"}</span>
  </div>
  ${renderSources(data)}
</section>
<p class="readonly">Read-only view. Changes use the <code>day</code> CLI.</p>`;
}

function renderCurrent(data: DashboardData): string {
  if (!data.current_task) {
    return `<article class="card current"><h2>Current task</h2><p class="big muted">No running session</p>${
      data.ready_to_continue
        ? `<p class="muted">Ready to continue: ${escapeHtml(data.ready_to_continue.task_ref)} · ${escapeHtml(data.ready_to_continue.title)}</p>`
        : ""
    }</article>`;
  }
  const task = data.current_task;
  const end = localTimeAt(task.planned_end, data.timezone);
  const remaining = Math.max(
    0,
    Math.round((new Date(task.planned_end).getTime() - new Date(data.now).getTime()) / 60000),
  );
  return `<article class="card current">
    <h2>Current task</h2>
    <p class="big">${escapeHtml(task.task_ref)} ${escapeHtml(task.title)}</p>
    <p class="muted">${escapeHtml(task.ref)} · ends ${escapeHtml(end)} · ${formatDuration(remaining * 60)} left</p>
    <p>${formatPercent(task.adherence)} adherence · ${formatPercent(task.coverage)} coverage</p>
  </article>`;
}

function renderNext(data: DashboardData): string {
  if (!data.next_event) {
    return `<article class="card"><h2>Next event</h2><p class="big muted">Nothing scheduled</p></article>`;
  }
  const event = data.next_event;
  return `<article class="card">
    <h2>Next event</h2>
    <p class="big">${escapeHtml(event.title)}</p>
    <p class="muted">${escapeHtml(event.time_label)} · in ${formatDuration(event.minutes_until * 60)}</p>
    <p>Free until then: <strong>${data.free_minutes === null ? "—" : formatDuration(data.free_minutes * 60)}</strong></p>
  </article>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><span class="metric-label">${escapeHtml(label)}</span><span class="metric-value">${escapeHtml(value)}</span></div>`;
}

function renderCalendar(data: DashboardData): string {
  if (data.calendar.length === 0) return `<p class="muted">No events on this day.</p>`;
  return `<ul class="calendar">${data.calendar
    .map(
      (event) => `<li class="${event.cancelled ? "cancelled" : ""}">
        <span class="time">${escapeHtml(event.time_label)}</span>
        <span class="title">${escapeHtml(event.title)}</span>
        <span class="kind">${escapeHtml(event.kind)}</span>
        ${event.reminder_minutes === null ? "" : `<span class="muted">reminder ${event.reminder_minutes}m</span>`}
      </li>`,
    )
    .join("")}</ul>`;
}

function renderGroup(key: string, label: string, tasks: DashboardTask[]): string {
  return `<section class="task-group ${key}">
    <h3>${escapeHtml(label)} <span class="count">${tasks.length}</span></h3>
    ${
      tasks.length === 0
        ? `<p class="muted">None</p>`
        : `<ul>${tasks
            .map(
              (task) =>
                `<li><span class="ref">${escapeHtml(task.ref)}</span> ${escapeHtml(task.title)} <span class="state">${escapeHtml(task.state)}</span></li>`,
            )
            .join("")}</ul>`
    }
  </section>`;
}

function renderActivity(data: DashboardData): string {
  if (data.activity.length === 0) {
    return `<p class="muted">No planned sessions with observations yet.</p>`;
  }
  const total = data.activity.reduce((sum, segment) => sum + segment.minutes, 0);
  const bar = data.activity
    .map((segment) => {
      const width = total > 0 ? Math.max(1, (segment.minutes / total) * 100) : 0;
      const title = `${segment.label} ${segment.minutes}m (${segment.kind})`;
      const inner = `<span class="segment ${escapeHtml(segment.kind)}" style="width:${width.toFixed(2)}%" title="${escapeHtml(title)}"></span>`;
      return segment.session_ref
        ? `<a href="/session/${escapeHtml(segment.session_ref)}" title="${escapeHtml(title)}">${inner}</a>`
        : inner;
    })
    .join("");
  const legend = data.activity
    .map(
      (segment) =>
        `<li><span class="dot ${escapeHtml(segment.kind)}"></span>${escapeHtml(segment.label)} · ${formatDuration(segment.minutes * 60)} <span class="muted">${escapeHtml(segment.kind)}</span>${
          segment.session_ref
            ? ` · <a href="/session/${escapeHtml(segment.session_ref)}">${escapeHtml(segment.session_ref)}</a>`
            : ""
        }</li>`,
    )
    .join("");
  return `<div class="activity-bar" id="activity-bar">${bar}</div><ul class="legend">${legend}</ul>`;
}

function renderSessions(data: DashboardData): string {
  if (data.sessions.length === 0) return `<p class="muted">No sessions on this day.</p>`;
  return `<div class="table-wrap"><table>
    <thead><tr><th>Session</th><th>Task</th><th>Planned</th><th>Task time</th><th>Coverage</th><th>Adherence</th><th>Result</th></tr></thead>
    <tbody>${data.sessions
      .map(
        (session) => `<tr>
          <td><a href="/session/${escapeHtml(session.ref)}">${escapeHtml(session.ref)}</a></td>
          <td>${escapeHtml(session.task_ref)} ${escapeHtml(session.title)}</td>
          <td>${formatDuration(session.planned_seconds)}</td>
          <td>${formatDuration(session.accepted_seconds)}</td>
          <td>${formatPercent(session.coverage)}</td>
          <td>${formatPercent(session.adherence)}</td>
          <td><span class="status ${escapeHtml(session.status)}">${escapeHtml(session.status)}</span></td>
        </tr>`,
      )
      .join("")}</tbody>
  </table></div>`;
}

function renderSources(data: DashboardData): string {
  if (data.sources.length === 0) return `<p class="muted">No watcher has reported yet.</p>`;
  return `<ul class="sources">${data.sources
    .map(
      (source) =>
        `<li><strong>${escapeHtml(source.source)}</strong> ${
          source.last_success_at
            ? `last update ${escapeHtml(localTimeAt(source.last_success_at, data.timezone))}`
            : "never"
        } · ${escapeHtml(source.retry_status)}${
          source.consecutive_errors > 0 ? ` · ${source.consecutive_errors} errors` : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

export function renderDashboardPage(data: DashboardData): string {
  const previous = addDays(data.date, -1);
  const next = addDays(data.date, 1);
  return page(
    `Day — ${data.date_label}`,
    `<header class="page-head">
      <div>
        <p class="eyebrow">DAY</p>
        <h1 id="date-label">${escapeHtml(data.date_label)}</h1>
        <p class="muted">${escapeHtml(data.timezone)} · <span id="now-time">${escapeHtml(data.now_time)}</span></p>
      </div>
      <nav class="date-nav" aria-label="Date navigation">
        <a href="/?date=${previous}">← ${previous}</a>
        <a href="/">Today</a>
        <a href="/?date=${next}">${next} →</a>
        <a href="/report?period=week&date=${data.date}">Report</a>
      </nav>
    </header>
    <div id="stale" class="stale" ${data.stale ? "" : "hidden"}>${data.stale ? "A source is stale. Showing the last known view." : ""}</div>
    <main id="dashboard" data-date="${escapeHtml(data.date)}">${renderDashboardMain(data)}</main>
    <script>${dashboardScript}</script>`,
  );
}

const dashboardScript = `
const root = document.getElementById('dashboard');
const stale = document.getElementById('stale');
async function refresh() {
  try {
    const response = await fetch('/partials/dashboard?date=' + encodeURIComponent(root.dataset.date), {credentials: 'same-origin'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    root.innerHTML = await response.text();
    stale.hidden = true;
  } catch (error) {
    stale.hidden = false;
    stale.textContent = 'Connection lost — showing the last view (' + new Date().toLocaleTimeString() + ')';
  }
}
setInterval(refresh, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
`;

type SessionView = ReturnType<typeof import("./sessions.js").sessionShow>;

export function renderSessionPage(view: SessionView): string {
  const timezone = view.event?.timezone ?? "Europe/Warsaw";
  const metrics = view.metrics;
  return page(
    `Session ${view.ref}`,
    `<header class="page-head">
      <div><p class="eyebrow"><a href="/?date=${escapeHtml(view.event?.start_utc?.slice(0, 10) ?? "")}">DAY</a></p>
      <h1>${escapeHtml(view.ref)} · ${escapeHtml(view.task.title)}</h1>
      <p class="muted">${escapeHtml(view.state)} · ${escapeHtml(view.goal?.ref ?? "no goal")} ${escapeHtml(view.goal?.title ?? "")}</p></div>
      <nav class="date-nav"><a href="/">Dashboard</a><a href="/report?period=day&date=${escapeHtml(view.event?.start_utc?.slice(0, 10) ?? "")}">Day report</a></nav>
    </header>
    <main>
      <section class="metrics">
        ${metric("Planned", formatDuration(metrics.planned_seconds))}
        ${metric("Task time", formatDuration(metrics.accepted_seconds))}
        ${metric("Coverage", formatPercent(metrics.coverage))}
        ${metric("Adherence", formatPercent(metrics.adherence))}
        ${metric("Unassigned", formatDuration(metrics.unassigned_seconds))}
        ${metric("Idle", formatDuration(metrics.idle_seconds))}
        ${metric("Paused", formatDuration(metrics.paused_seconds))}
        ${metric("Missing", formatDuration(metrics.missing_seconds))}
      </section>
      <section class="card"><h2>Progress</h2>${sessionProgress(view)}</section>
      <section class="card"><h2>Attribution</h2>${sessionAttribution(view, timezone)}</section>
      <section class="card"><h2>Observations</h2>${sessionObservations(view, timezone)}</section>
      <section class="card"><h2>Plan history</h2>${sessionPlans(view)}</section>
      <p class="readonly">Read-only view. Changes use the <code>day</code> CLI.</p>
    </main>`,
  );
}

function sessionProgress(view: SessionView): string {
  if (view.progress.length === 0) return `<p class="muted">No progress entry yet.</p>`;
  return `<ul>${view.progress
    .map(
      (entry) =>
        `<li><strong>${escapeHtml(entry.ref)}</strong> ${escapeHtml(entry.summary)}${
          entry.artifact ? ` · <code>${escapeHtml(entry.artifact)}</code>` : ""
        }</li>`,
    )
    .join("")}</ul>`;
}

function sessionAttribution(view: SessionView, timezone: string): string {
  if (view.attribution.length === 0) return `<p class="muted">No attributed intervals.</p>`;
  const rows = view.attribution
    .map(
      (row) => `<tr>
        <td>${escapeHtml(`A${String(row.id).padStart(2, "0")}`)}</td>
        <td>${escapeHtml(row.status)}</td>
        <td>${escapeHtml(row.method)}</td>
        <td>${row.task_id ? escapeHtml(`T${String(row.task_id).padStart(2, "0")}`) : "—"}</td>
        <td>${row.rule_id ? escapeHtml(`R${String(row.rule_id).padStart(2, "0")} v${String(row.rule_version)}`) : "—"}</td>
        <td>${escapeHtml(localTimeAt(row.start_utc, timezone))}–${escapeHtml(localTimeAt(row.end_utc, timezone))}</td>
      </tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Revision</th><th>Status</th><th>Method</th><th>Task</th><th>Rule</th><th>Interval</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function sessionObservations(view: SessionView, timezone: string): string {
  if (view.attribution.length === 0) return `<p class="muted">No observations.</p>`;
  const rows = view.attribution
    .map((row) => {
      const parts = [
        `source ${escapeHtml(row.source ?? "unknown")}`,
        row.project ? `project ${escapeHtml(row.project)}` : "",
        row.app ? `app ${escapeHtml(row.app)}` : "",
        row.url ? `url ${escapeHtml(row.url)}` : "",
        row.demo ? "demo" : "real",
      ].filter(Boolean);
      return `<li>${escapeHtml(localTimeAt(row.start_utc, timezone))}–${escapeHtml(localTimeAt(row.end_utc, timezone))}: ${parts.join(" · ")}</li>`;
    })
    .join("");
  return `<ul>${rows}</ul>`;
}

function sessionPlans(view: SessionView): string {
  if (view.plan_revisions.length === 0) return `<p class="muted">Original plan only.</p>`;
  const rows = view.plan_revisions
    .map(
      (revision) =>
        `<li>Revision ${escapeHtml(revision.revision)}: ${escapeHtml(revision.planned_start)}–${escapeHtml(revision.planned_end)}</li>`,
    )
    .join("");
  return `<ul>${rows}</ul>`;
}

export function renderReportPage(view: ReportResult): string {
  const max = Math.max(1, ...view.by_day.map((day) => day.accepted_seconds));
  const bars = view.by_day
    .map(
      (day) => `<li><span class="bar-label">${escapeHtml(day.label)}</span>
        <span class="bar" style="width:${((day.accepted_seconds / max) * 100).toFixed(1)}%"></span>
        <span class="muted">${formatDuration(day.accepted_seconds)}</span></li>`,
    )
    .join("");
  const tasks = view.by_task
    .map(
      (task) =>
        `<tr><td>${escapeHtml(task.ref)}</td><td>${escapeHtml(task.title)}</td><td>${formatDuration(task.accepted_seconds)}</td><td>${formatDuration(task.planned_seconds)}</td><td>${formatPercent(task.coverage)}</td><td>${formatPercent(task.adherence)}</td></tr>`,
    )
    .join("");
  const sessions = view.sessions
    .map(
      (session) =>
        `<tr><td><a href="/session/${escapeHtml(session.ref)}">${escapeHtml(session.ref)}</a></td><td>${escapeHtml(session.task_ref)} ${escapeHtml(session.task_title)}</td><td>${formatDuration(session.accepted_seconds)} / ${formatDuration(session.planned_seconds)}</td><td>${formatPercent(session.coverage)}</td><td>${formatPercent(session.adherence)}</td></tr>`,
    )
    .join("");
  const totals = view.totals;
  return page(
    `Day — ${view.period} report`,
    `<header class="page-head"><div><p class="eyebrow"><a href="/">DAY</a></p><h1>${escapeHtml(view.label)} · ${escapeHtml(view.period)}</h1><p class="muted">${escapeHtml(view.timezone)}</p></div>
      <nav class="date-nav">
        <a href="/report?period=day&date=${view.from_date}">Day</a>
        <a href="/report?period=week&date=${view.from_date}">Week</a>
        <a href="/report?period=month&date=${view.from_date}">Month</a>
        <a href="/report?period=quarter&date=${view.from_date}">Quarter</a>
        <a href="/report?period=year&date=${view.from_date}">Year</a>
      </nav></header>
    <main>
      <section class="metrics">
        ${metric("Planned", formatDuration(totals.planned_seconds))}
        ${metric("Task time", formatDuration(totals.accepted_seconds))}
        ${metric("Goal time", formatDuration(totals.goal_seconds))}
        ${metric("Coverage", formatPercent(totals.coverage))}
        ${metric("Adherence", formatPercent(totals.adherence))}
        ${metric("Unassigned", formatDuration(totals.unassigned_seconds))}
        ${metric("Idle", formatDuration(totals.idle_seconds))}
        ${metric("Missing", formatDuration(totals.missing_seconds))}
      </section>
      <section class="card"><h2>By day</h2><ul class="bars">${bars || `<li class="muted">No sessions.</li>`}</ul></section>
      <section class="card"><h2>By task</h2>${tasks ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Title</th><th>Task time</th><th>Planned</th><th>Coverage</th><th>Adherence</th></tr></thead><tbody>${tasks}</tbody></table></div>` : `<p class="muted">No task time.</p>`}</section>
      <section class="card"><h2>Sessions</h2>${sessions ? `<div class="table-wrap"><table><thead><tr><th>Session</th><th>Task</th><th>Time</th><th>Coverage</th><th>Adherence</th></tr></thead><tbody>${sessions}</tbody></table></div>` : `<p class="muted">No sessions.</p>`}</section>
    </main>`,
  );
}

export function renderNotFound(message: string): string {
  return page(
    "Day — not found",
    `<main><h1>Not found</h1><p>${escapeHtml(message)}</p><p><a href="/">Dashboard</a></p></main>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

const css = `
:root { color-scheme: light dark; --bg:#f6f5f1; --fg:#1c1b18; --muted:#6b6860; --card:#fffdf8;
  --line:#ddd8cc; --accent:#245c4f; --warn:#a33; --accepted:#2f7d66; --unassigned:#c58a2a;
  --ambiguous:#8a5fb0; --idle:#8c9aa6; --missing:#c9c4b8; --paused:#6f7b8a; --excluded:#4f6d9a; }
@media (prefers-color-scheme: dark) { :root { --bg:#171714; --fg:#ece8de; --muted:#a8a397; --card:#211f1b;
  --line:#3a3730; --accent:#8cc9b6; --warn:#ff9a8a; --accepted:#67b89c; --unassigned:#e0ae55;
  --ambiguous:#c39ae0; --idle:#9aa8b5; --missing:#4a463d; --paused:#8b98a8; --excluded:#8aa9d6; } }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 1440px; padding: 24px; background: var(--bg); color: var(--fg);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
a { color: var(--accent); }
h1, h2, h3 { line-height: 1.2; margin: 0 0 8px; }
h1 { font-size: clamp(1.5rem, 4vw, 2.4rem); }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
h3 { font-size: .95rem; }
p { margin: 6px 0; }
.eyebrow { color: var(--muted); letter-spacing: .2em; font-size: .75rem; margin: 0; }
.page-head { display: flex; flex-wrap: wrap; gap: 16px; align-items: end; justify-content: space-between; margin-bottom: 20px; }
.date-nav { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.date-nav a { text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 4px 10px; background: var(--card); }
.muted { color: var(--muted); }
.big { font-size: clamp(1.1rem, 2.5vw, 1.5rem); font-weight: 650; }
.grid { display: grid; gap: 16px; }
.grid.top { grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin: 16px 0; }
.grid.top .card { margin: 0; }
.section-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin: 16px 0; }
.metric { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; }
.metric-label { display: block; color: var(--muted); font-size: .8rem; }
.metric-value { font-weight: 700; font-size: 1.1rem; }
ul { margin: 8px 0; padding-left: 20px; }
li { margin: 4px 0; }
.calendar { list-style: none; padding: 0; }
.calendar li { display: grid; grid-template-columns: 9rem 1fr auto; gap: 4px 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.calendar li:last-child { border-bottom: 0; }
.calendar .time { font-variant-numeric: tabular-nums; color: var(--muted); }
.calendar .kind { color: var(--muted); font-size: .85rem; }
.cancelled { text-decoration: line-through; opacity: .6; }
.task-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
.task-group { border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
.task-group ul { list-style: none; padding: 0; }
.task-group li { padding: 4px 0; }
.task-group .count { color: var(--muted); font-weight: 400; }
.ref { color: var(--muted); font-variant-numeric: tabular-nums; }
.state { color: var(--muted); font-size: .8rem; }
.activity-bar { display: flex; height: 28px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); margin: 10px 0; }
.activity-bar a { display: block; height: 100%; }
.segment { display: block; height: 100%; }
.segment.accepted { background: var(--accepted); }
.segment.unassigned { background: var(--unassigned); }
.segment.ambiguous { background: var(--ambiguous); }
.segment.idle { background: var(--idle); }
.segment.missing { background: var(--missing); }
.segment.paused { background: var(--paused); }
.segment.excluded { background: var(--excluded); }
.legend { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 4px 16px; }
.dot { display: inline-block; width: .7em; height: .7em; border-radius: 50%; margin-right: 6px; }
.dot.accepted { background: var(--accepted); } .dot.unassigned { background: var(--unassigned); }
.dot.ambiguous { background: var(--ambiguous); } .dot.idle { background: var(--idle); }
.dot.missing { background: var(--missing); } .dot.paused { background: var(--paused); }
.dot.excluded { background: var(--excluded); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: .92rem; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; }
.status.met { color: var(--accepted); }
.status.not_met { color: var(--warn); }
.status.insufficient_data { color: var(--unassigned); }
.sources { list-style: none; padding: 0; }
.badge { border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: .8rem; }
.badge.warn { color: var(--warn); border-color: var(--warn); }
.stale { border: 1px solid var(--warn); color: var(--warn); border-radius: 10px; padding: 8px 12px; margin-bottom: 12px; }
.readonly { color: var(--muted); font-size: .85rem; margin-top: 24px; }
.bars { list-style: none; padding: 0; }
.bars li { display: grid; grid-template-columns: 6rem 1fr 5rem; gap: 8px; align-items: center; }
.bar { display: block; height: 12px; background: var(--accepted); border-radius: 999px; min-width: 0; }
@media (min-width: 768px) { body { padding: 32px; } }
@media (max-width: 520px) { .calendar li { grid-template-columns: 1fr; } }
`;

export { css };
