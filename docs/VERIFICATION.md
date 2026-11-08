# Verification

Evidence collected on branch `example`. Commands run from the repository root.

## Quality gate

```text
$ npm run lint
(no output — pass)

$ npm run typecheck
(no output — pass)

$ npm run format:check
All matched files use Prettier code style!

$ npm test
# tests 34
# pass 34
# fail 0

$ npm run test:e2e
9 passed

$ npm run build
(tsc + schema copy — pass)

$ bash scripts/check-private.sh
repository check: no private runtime files are tracked
```

`make ci` runs the repository check and the five npm checks above.

## One-year performance check

```text
$ npm run bench
Seeded 365 days in 445 ms
Dashboard (100 requests): p50 28.4 ms, p95 46.0 ms, max 77.8 ms
Week report (100 requests): p50 4.4 ms, p95 13.8 ms, max 26.7 ms
```

The script uses a disposable SQLite store with 365 work sessions and 365
observations, one synthetic year, and an in-process server. The 500 ms target
from `AC-C03-03` is met with a wide margin on this machine. Re-run on the
machine used for a formal result.

## Documented CLI walkthrough

```text
$ DAY_NOW=2026-09-25T09:30:00+02:00 ./bin/day setup --demo
Imported goal: G01 (SPEC-G01)
Demo scenario: created

$ DAY_NOW=2026-09-25T09:30:00+02:00 ./bin/day today
Friday, 25 September 2026 — Europe/Warsaw
Now: 09:30
Current task: T01 Write the introduction (S01, ends 09:30)
Next event: Team meeting, 11:00–11:30
Free until next event: 1h 30m
Inbox: 1 task
Activity tracker: running
Last update: 09:30
Goal check: pending (V01)

$ ... ./bin/day session show S01
S01  Write the introduction
State: running
Goal: G02 — Publish a post about Day
Planned: 09:00–09:30  30m
Task T01: 24m
Unassigned: 6m
Missing: 0s
Coverage: 100%
Session adherence: 80% (24m / 30m)
Result: met

$ ... ./bin/day activity assign --session S01 --from 09:24 --to 09:30 \
    --task T01 --reason "Read a source for the introduction"
Attribution revision: A03
Method: manual correction
Previous attribution retained
Session adherence after recalculation: 100%

$ ... ./bin/day goal check intentional-day --date today
As of: 09:30 — day still in progress
Qualifying tasks: 1 / 2       target not reached
Goal time:        24m / 3h    target not reached
Progress entries: 1 / 1       met
Coverage:         100%
Final daily result: pending
```

## Browser checks

Playwright verifies:

1. the dashboard renders the date, current task, next event, five task groups,
   sources, and the read-only notice;
2. no horizontal scroll at 390, 768, and 1440 CSS pixels;
3. activity segments drill into session evidence (attribution, observations,
   progress);
4. `/api/v1/dashboard` returns 401 without credentials and 405 for a write
   method; a bearer read token gets 200;
5. all five report periods render;
6. a failed partial refresh keeps the last view and shows the stale banner;
7. date navigation works across days.

## Behavior covered by `node:test`

- Europe/Warsaw summer and winter conversion, half-open intervals, union,
  subtraction, duration parsing.
- The full goal → task → session → rule → observation → attribution → progress
  cycle, including the 24/6-minute example and 80% adherence.
- Manual correction revision history, retention of the previous decision, and
  recalculation.
- Equal-rank rule ambiguity, rule version capture, and agent suggestions that
  require explicit acceptance.
- Observation upsert by `(source, bucket, event id)`, late import, checkpoints,
  stale sources after three errors.
- Pause, exclusion before storage, invalid negative intervals retained outside
  calculations.
- Session collision detection, scheduling, plan revisions.
- Recurring events and per-occurrence overrides/cancellation.
- Calendar import revision reconciliation.
- Daily target statuses (`met`, `not_met`, `insufficient_data`, `pending`) and
  snapshot reuse.
- Experiment baseline unavailability and available comparison period.
- Private backup restore with matching counts and checksum, public export
  exclusions, deletion effects.
- Tutorial completion gated on a real, non-demo observation; reset keeps records.
- API bounded ranges, all report periods, and a 30-request p95 latency check.

## Known limits

- Google sync is not implemented; the JSON import path preserves source IDs and
  revisions for an adapter.
- Browser tab capture needs an extension. The dashboard reports it as
  unsupported instead of inventing foreground time.
- The desktop watcher supports Hyprland (`hyprctl`). Other desktops need an
  adapter.
- Recurrence supports daily and weekly rules used by local blocks; complex
  RFC 5545 rules are not expanded.
- Reminders are displayed on the dashboard; system notifications are not sent.
- The minimum qualifying task duration is still the open decision from the
  specification.
