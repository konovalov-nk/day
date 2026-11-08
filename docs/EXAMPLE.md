# Day — example implementation

This branch contains a runnable, deliberately small implementation of the Day
specification. It is a single Node.js/TypeScript process with SQLite, a CLI, and
a server-rendered read-only dashboard. There is no cloud service, message broker,
or frontend build step.

The product specification remains in [`README.md`](../README.md) and the formal
catalog in `day-specs.jsonl` / `day-goals.jsonl`.

## What is here

| Path       | Contents                                                                |
| ---------- | ----------------------------------------------------------------------- |
| `src/`     | Domain modules, SQLite schema, CLI, HTTP server, HTML rendering         |
| `test/`    | `node:test` unit and integration tests against disposable SQLite stores |
| `e2e/`     | Playwright browser tests and a demo server fixture                      |
| `scripts/` | Repository privacy check and the one-year performance benchmark         |
| `deploy/`  | Example Caddy site                                                      |
| `docs/`    | Architecture, verification evidence, and this guide                     |

## Quick start

```sh
make setup      # install, create .env, migrate data/day.sqlite, import day-goals.jsonl
make demo       # create a labelled synthetic scenario
make start      # start the dashboard in the background
make open       # print the URL
```

The default URL is <http://127.0.0.1:3037>. Credentials are generated into
`.env` by `day setup` (`DAY_USER`, `DAY_PASSWORD`, `DAY_READ_TOKEN`). The file is
mode `0600` and is ignored by Git.

Stop the service without deleting data:

```sh
make stop
make status
```

Run the full quality gate:

```sh
make ci
```

Run only the browser suite or the performance check:

```sh
make e2e
make bench
```

## Demo scenario

`make demo` is idempotent and creates one labelled example:

- goal `G02` “Publish a post about Day” with a criterion;
- tasks in the inbox, non-urgent/high, and urgent/high groups;
- a team meeting and a 30-minute work block;
- one tmux observation attributed by a project rule and one unassigned browser
  observation;
- a progress entry, a private note, and an experiment with an unavailable
  baseline;
- the daily target evaluation.

The observations are labelled `demo` and cannot satisfy the real-tracking
tutorial step.

## CLI surface

```text
day open | today | serve | prepare | setup | ci | start | stop | status | deploy
day calendar add|list|show|update|cancel|import
day goal add|show|list|import|check|history
day task add|update|list|show|start|schedule|complete|cancel|context
day session start|end|show|list|retime|cancel
day rule add|list|update
day activity watch|status|record|import|pause|resume|explain|assign|attribute|exclude|suggest|accept-suggestion
day note add|list|show|update|delete
day experiment add|list|show|conclude
day report --period day|week|month|quarter|year
day tutorial status|next|reset|start
day demo seed|status
day data export|import|delete
```

Data commands support `--json`. JSON results carry `schema_version: 1`.
Diagnostics go to stderr and errors use stable codes and a non-zero exit status.
Commands never wait for input.

## Dashboard

- read-only; no forms or mutating controls;
- Basic authentication for the page and the JSON API;
- `GET /health` is the only unauthenticated endpoint;
- every data route is bounded and paginated where raw records are returned;
- the page refreshes every 30 seconds and keeps the last view with a stale banner
  when the refresh fails;
- widths 390, 768, and 1440 CSS pixels are checked for horizontal scroll;
- activity segments link to the session evidence page.

Read-only API credentials are configured in `.env`. The HTTP server has no write
routes; the CLI is the only mutation surface. The API does not expose
ActivityWatch itself.

## Data and privacy

- SQLite lives in `data/day.sqlite` (override with `DAY_DB_PATH`).
- `.env`, `data/`, logs, and test output are ignored by Git.
- Observations store application, project, tmux context, and URL, never window
  titles, terminal contents, shell history, or command arguments.
- Exclusions are applied before storage; the interval is kept as an
  `excluded` coverage marker without content.
- Pausing capture records a paused coverage interval, not idle time.
- Public export includes only goals, tasks, sessions, progress, and evaluation
  results. Private notes and raw observations are excluded.
- A local backup includes all source records, notes, attributions, goals, and
  evaluation history and can be restored into a separate empty installation.

## Deliberate scope

The specification lists optional Google synchronization and an LLM. This
example keeps both out of the core:

- calendar import accepts a JSON array with source IDs and revisions, so a
  Google adapter can be added without changing the model;
- agent suggestions can be recorded with observation IDs, method, version, and
  uncertainty, but only an explicit acceptance creates an attribution;
- browser URL capture needs a browser extension; until one exists the dashboard
  reports the browser watcher as unsupported rather than guessing;
- the desktop watcher uses `hyprctl`, and the tmux watcher uses attached tmux
  clients. Both report unknown context instead of inventing foreground time.

These limits are visible in the UI and CLI rather than silently ignored.

## Complexity guardrails

The ESLint configuration mirrors the parts of a SonarQube quality gate that are
useful for this size of code: cyclomatic complexity at most 15, nesting at most
4, files at most 600 lines, functions at most 230 lines, and at most 6
parameters. `sonar-project.properties` is included for a real SonarQube run.
The code is intentionally split by domain rather than by framework layer.

## Reading order

1. `src/schema.sql` — tables and invariants.
2. `src/metrics.ts` — adherence, coverage, unassigned, idle, paused, missing.
3. `src/attribution.ts` — rule matching, ambiguity, revisions, manual correction.
4. `src/evaluations.ts` — the daily target snapshot and result statuses.
5. `src/server.ts` + `src/web.ts` — the read-only surface.
6. `test/` and `e2e/` — the behavior the branch claims.
