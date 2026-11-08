# Architecture

## Shape

```text
                 CLI (src/cli.ts)                 HTTP (src/server.ts)
                        |                                  |
                        +-------- domain modules ----------+
                        |  tasks, sessions, events, goals   |
                        |  activity, attribution, metrics   |
                        |  reports, evaluations, notes      |
                        +----------------+------------------+
                                         |
                                  SQLite (src/schema.sql)
```

Domain modules open a `Ctx` (database, clock, timezone, configuration). The CLI
and HTTP server are two adapters over the same modules. The HTTP adapter has no
mutation routes, so read-only credentials cannot change records. The CLI wraps
mutations in `withOperation`, which stores an operation ID and the JSON result
for idempotent retries.

## Modules

| Module                       | Responsibility                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `config.ts`                  | Environment, paths, thresholds, generated `.env`                   |
| `db.ts`                      | SQLite connection, schema, typed query helpers, `Ctx`              |
| `time.ts`                    | UTC storage, IANA timezone conversion, half-open intervals, unions |
| `goals.ts`                   | Personal/software/test catalogs, criteria, imports                 |
| `tasks.ts`                   | Inbox capture, five categories, goal links, states                 |
| `events.ts`                  | Local calendar, recurrence, occurrence overrides, reminders        |
| `sessions.ts`                | Planned/running/ended sessions, calendar blocks, progress          |
| `activity.ts`                | Observations, checkpoints, pause, exclusions, imports              |
| `attribution.ts`             | Rules, ranking, ambiguity, manual revisions, suggestions           |
| `metrics.ts`                 | Session and task-day adherence, coverage, segments                 |
| `reports.ts`                 | Day/week/month/quarter/year totals and buckets                     |
| `evaluations.ts`             | Daily target snapshots, result statuses, history                   |
| `notes.ts`, `experiments.ts` | Private notes and comparisons                                      |
| `dashboard.ts`               | One consistent read model for the website                          |
| `server.ts`, `web.ts`        | Authenticated read-only JSON and HTML                              |
| `service.ts`                 | Prepare, setup, start/stop/status, CI, deploy checks               |
| `tutorial.ts`                | Reality-gated tutorial steps stored in SQLite                      |
| `data.ts`                    | Private/public export, restore, deletion, privacy effects          |

## Model notes

- All times are stored as UTC ISO strings. User-facing boundaries are computed in
  the configured IANA timezone (default `Europe/Warsaw`).
- Intervals are half-open: `[start, end)`.
- Durations are always unions of intervals. Overlapping observations, devices,
  or goal links cannot increase elapsed time.
- Task categories are derived only from urgency and importance. Missing either
  field keeps the task in the inbox.
- A session requires a primary goal. A calendar block alone does not assign
  concurrent activity; only a rule or an explicit correction does.
- Attribution rows are append-only revisions. `superseded_by` identifies the
  current revision; raw observations never change on correction.
- Rule changes increment the rule version. An attribution stores the version
  that produced it.
- Equal top-rank rule matches remain `ambiguous`. No task is guessed.
- Coverage counts known active, idle, and excluded time. Paused time is reported
  separately. Missing time is the remainder inside a planned session.
- Session adherence counts only accepted time for the session's task. A manual
  correction to another task does not inflate the original session.
- Goal checks store the goal revision, thresholds, calculation version, input
  snapshot, hash, coverage, and evidence. Repeating identical inputs returns the
  same revision; changed inputs create a new one.

## Calculation definitions

```text
planned          = clipped planned session duration
accepted         = union of current accepted attributions for the session task
observed         = union of healthy observations/coverage plus idle/excluded
coverage         = observed / planned
adherence        = accepted / planned
unassigned       = observed non-idle - accepted - ambiguous
missing          = planned - observed - paused
qualifying task  = coverage >= 0.90 and adherence >= 0.80 and planned > 0
goal time        = union of accepted attributions connected to a current goal
```

The thresholds live in configuration (`DAY_COVERAGE_THRESHOLD`,
`DAY_ADHERENCE_THRESHOLD`, `DAY_GOAL_HOURS`).

## Read model

`buildDashboard` returns one object with timezone, date, current task, next
event, free time, calendar, five task groups, sessions, metrics, activity
segments, evaluation revision, source freshness, capture state, and counts. The
HTML page is rendered from the same object; the 30-second refresh fetches the
HTML partial, so the server and client do not duplicate formatting rules.

## HTTP surface

```text
GET  /health                          no auth
GET  /                                dashboard (Basic)
GET  /partials/dashboard              refresh fragment (Basic)
GET  /session/:ref                    evidence page (Basic)
GET  /report?period=&date=            report page (Basic)
GET  /api/v1/dashboard?date=          snapshot (Bearer or Basic)
GET  /api/v1/report?period=&date=     report (Bearer or Basic)
GET  /api/v1/sessions/:ref            session evidence (Bearer or Basic)
GET  /api/v1/tasks/:ref/context       agent context (Bearer or Basic)
GET  /api/v1/calendar?from=&to=       bounded calendar query
GET  /api/v1/observations?from=&to=   bounded raw query, limit/offset
GET  /api/v1/notes                    private notes
GET  /api/v1/sources                  freshness and capture state
```

Anything other than `GET`/`HEAD` returns `405`. Responses are `no-store` and
include `X-Content-Type-Options: nosniff`.

## Specification map

| Spec | Implementation                                                      |
| ---- | ------------------------------------------------------------------- |
| C01  | `activity.importObservations`, `calendar-import.ts`, `source_state` |
| C02  | `watcher.ts` tmux client/pane selection, no content fields          |
| C03  | `server.ts` bounded queries, `dashboard.ts` snapshot, bench script  |
| F01  | `time.ts`, interval unions, UTC storage, DST conversion             |
| F02  | `metrics.ts` definitions and `insufficient_data` gate               |
| F03  | revisions, `data.ts` export/restore/delete, privacy check           |
| M01  | `events.ts`, recurrence and occurrence overrides, reminders         |
| M02  | `tasks.ts`, five categories, stable IDs, goal links                 |
| M03  | `goals.ts` catalogs, imports, unavailable-goal block                |
| M04  | `activity.ts`, `watcher.ts`, pause/exclusion/coverage               |
| M05  | `attribution.ts`, ranks, ambiguity, revisions, suggestions          |
| M06  | `reports.ts`, `dashboard.ts`, report HTML/JSON                      |
| M07  | `notes.ts`, `experiments.ts`                                        |
| M08  | `cli.ts` one tree, `--json`, operation IDs, context                 |
| M09  | `service.ts`, `Makefile`, Caddy example                             |
| M10  | `tutorial.ts` stored steps and reality checks                       |
| P01  | dashboard segments → session evidence page                          |
| P02  | experiment baseline/period comparison and conclusions               |
| P03  | tutorial first cycle and next-day command                           |
| S01  | dashboard, three widths, 30s refresh, stale marker, read-only       |
| S02  | sessions, blocks, collisions, progress, operation retry             |
| S03  | `evaluations.ts` snapshot, statuses, history                        |
| S04  | local-only operation, public export exclusions, auth                |
