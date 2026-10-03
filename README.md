# Day — system specification

Prepared 2026-09-25.

## Purpose

https://x.com/br11k_dev/status/2103316945932042622?s=20

So I came to conclusion I also want to start doing telemetry on myself but stored locally.

I am trying to set up my own CBT (cognitive behavioral therapy) and I  realized how important it is to have metrics on everything you are doing. I'm spending 16 hours a day in front of a monitor but I don't know where exactly.

Hypothesis about what is going on with me, after some time spent observing my own behavior:

> the moment I look at something during the day it immediately captures my attention, no matter what it is

> when I know there are meeting events on the calendar (interviews, 1:1, appointments), I am very aware of that fact no matter what I'm doing at the moment, and if I forget there is always a notification that I ensure exists on that event unless it's not important

> ADHD meds don't make me focused but they keep my energy levels up during the day, so I can be productive or procrastinate for 16 hours straight; energy during the day is somewhat solved for me with a $1 pill a day

> the moment I started tracking my calorie expenditure, sleep, and weight was the best decision, because I managed to save money and I lost 17 kg over the course of 16 months, I was able to log food every day even though it was exhausting to enter nutrients myself [1]; this means if I have a goal set I can commit to it every day no matter what, and I started doing it even before I had meds: May 2025 -> September 2025, that's 4 months; the reason it worked is because I conditioned myself to recording food every time I eat, and while doing so, I also saw the charts and my progress, which I believe helped a lot; I think it took me few weeks or months for me to develop the "which food I wanna eat today that is easy to track?" and "I got some fruit snacks, lets record it before I eat them" unconditionally

> when I synthesize work from my thoughts it helps me to keep myself focused on it: e.g. writing a blog post if I started it — most likely I will finish that because it has clear start and end conditions: I open nvim while having idea about what to write, and I push final post to blog. This means that the most important moment is starting, and I specifically have trouble starting meaningful work that I should prioritize doing first; the "synthesized work" is something I can save: text, picture, audio file, state of my room (the other day I decided to do cleanup and I just spent 4 hours and completely re-arranged furniture how I wanted and cleaned up ALL the mess, I was so happy to make it finally happen, after 5 months of planning to do it)

> on the opposite side, things like scrolling news, reading, checking my emails, messaging someone on Telegram / Discord to share my thoughts and memes — these are all unproductive scenarios that don't lead to anything and I believe this is where I spend 80% of my time currently; however I can't tell without actually measuring it

> the most problematic thing that keeps happening is that I open a website / X / Discord / phone whatever I have and I see something that triggers my mind "oh, this could be interesting in context of: funny, useful, ragebait, related to my research" and I immediately dive into that thing and spend 1-8 hours on it, and after the fact not even realizing what I just spent my time on — it's just gone and I can't tell if it was useful or not

... I think these are most important points about my current state ...

And so first idea I had towards solving my attention/focus problem.

One. Set up calendar and todo list, and they are linked: when I take something to work on, it is added to calendar and my time is blocked and the goal is to spend 100% of the allocated time on the task.

However, with a setup like this, your only contract is calendar itself and your "definition of done / acceptance critera" to mark that task completed. You can't measure whether time was even spent on that task, you need an automated tracker that doesn't ask what you're doing, it must work in the background.

Two. Define goals what I'm trying to achieve and most importantly — measure them. If you can't measure what you want to improve, you can't improve it. The weight and sleep can be recorded, and my focus time as well. 

So it's just an engineering/commitment problem for me. Both are solvable, and this entire post I made to

1) make myself somewhat accountable for what I'm about to do
2) don't lose my thoughts
3) ask you about whether you actually had similar thoughts when starting your telemetry project or not, and whether it helps you to track/measure success currently; the reason I kept thinking about this thread is because you gave me an idea that I can automatically track everything but it seemed like there are a lot of problems that need to be solved before I can use it practically, and I wanted a relatively simple solution [2]

Anyway, hope this might be useful.
The project for this accountability/telemetry/goals/tasks/CBT is going to be live on my GitHub, I wanna start small with just todo+calendar+activity tracker that I can interact with individually, but eventually make it a complete system that answers "what should I be doing right now" and shows me what I'm doing with my life and why [3]

Notes:
1. Cronometer support for AI use is not just non-existent but they actually went as far as encrypting their APIs, and browser-use wasn't that good until recently; I think you can easily disrupt this market if you have some $$$ to spend on food datasets — unfortunately they are gated for some reason, and public one isn't that good; this is one problem I wanted to solve and I know how to do it for almost free, without even using Cronometer / paid datasets

2. I found https://activitywatch.net which I believe is ideal for my use case and so I think you might have seen it before or maybe it could be useful to your telemetry project as well

3. I know this is going to be yet another 14th standard in addition to 13 existing ones (xkcd) but hear me out: if this was a properly solved problem by now I wouldn't even had to spend effort writing all this, I'd just use the existing app/CLI/service/solution that worked for most people, and the fact that I don't know of this solution after spending so many days building Coherence means that there just isn't one, so making 14th experiment is worth it at least to build better understanding of the problem I want to solve; anyway, the name: https://github.com/konovalov-nk/day

## Read this first

This walkthrough describes the proposed product. The commands are not implemented by this document.
All IDs, times, URLs, and outputs below are examples. They are not records of your activity.

The example follows one task: write the introduction to a blog post about Day.
You plan 30 minutes. The tracker records 24 minutes in the project and 6 minutes elsewhere.
You save a draft. The task is not complete, but the work has a recorded result.

Formal requirements are in `day-specs.jsonl`.
The personal daily target is in `day-goals.jsonl`.
Each step lists the relevant specification IDs.

## 1. Open your day

You open Day on your second screen.
It shows the calendar and the task list. You keep this page open while you work.

```sh
day open
# Opened: https://day.home.br11k.dev
```

The CLI can show the same basic information.

```sh
day today
# Friday, 25 September 2026 — Europe/Warsaw
# Now: 09:00
# Current task: none
# Next event: Team meeting, 11:00–11:30
# Free until next event: 2h
# Inbox: 1 task
# Activity tracker: running
# Last update: 2 seconds ago
```

You can inspect an appointment without changing it.

```sh
day calendar show E01
# E01  Team meeting
# Today, 11:00–11:30
# Reminder: 10 minutes before
# Source: local calendar
```

The website is read-only. Changes use the CLI.
Imported Google events can appear here later. Google synchronization is optional.

Specifications: `SPEC-S01`, `SPEC-M01`, `SPEC-C03`.

## 2. Give the work a goal

You want to publish a post about Day.
The goal describes that result. Its criterion states how you will check it.

```sh
day goal add "Publish a post about Day" \
  --criterion "The post is available at a public URL"
# Goal: G01
# Criterion: GC01
# Stored in: personal Coherence catalog
# Status: draft
```

`G01` is a short CLI reference. Day keeps the full Coherence catalog and spec IDs behind it.
This publication goal is separate from your daily time target.

```sh
day goal show G01
# G01  Publish a post about Day
# GC01  The post is available at a public URL
# Tasks: 0
# Recorded time: 0m
```

Specification: `SPEC-M03`.

## 3. Capture one task

You do not need to organize a task when you first record it.
A title is enough to put it in the inbox.

```sh
day task add "Write the introduction"
# Created: T01
# Category: inbox
# Goal: not set
```

Now connect the task to the goal and set its priority.

```sh
day task update T01 --goal G01 --importance high --urgent no
# T01  Write the introduction
# Goal: G01 — Publish a post about Day
# Category: non-urgent, high priority
# State: ready
```

```sh
day task list
# Inbox:                         0
# Urgent + high priority:        0
# Non-urgent + high priority:    1  T01 Write the introduction
# Urgent + low priority:         0
# Non-urgent + low priority:     0
```

The website shows these five groups. The last group is gray but readable.
An unfinished classification stays in the inbox.

Specification: `SPEC-M02`.

## 4. Reserve time and start

You decide to work on T01 for 30 minutes, starting now.
Day creates a session and a calendar block.

```sh
day task start T01 --duration 30m
# Session: S01
# Task: T01 — Write the introduction
# Goal: G01
# Calendar block: E02, 09:00–09:30
# State: running
```

The website now shows T01 as the current task.
The calendar shows E02 beside your existing appointments.

This block records your plan. It does not prove that you worked for 30 minutes.

If you prefer to schedule work first, use a calendar block:

```sh
day task schedule T01 --start tomorrow@09:00 --duration 30m
# Session: S02
# Calendar block: E03, tomorrow 09:00–09:30
# State: planned
```

This second command is an alternative example. It is not required for the current session.
If a block overlaps a meeting, Day shows the conflict before it starts the session.

Specification: `SPEC-S02`.

## 5. Tell Day which project belongs to the task

Day needs a reason to connect observed activity to T01.
For this example, work in your blog directory belongs to the task.

```sh
day rule add --task T01 --project ~/git/blog
# Rule: R01, version 1
# Match: foreground tmux project ~/git/blog
# Assign matched activity to: T01
```

The rule does not count a detached tmux session or a background terminal as active work.

You can also add a browser rule for a specific research page.

```sh
day rule add --task T01 --url-prefix https://activitywatch.net/
# Rule: R02, version 1
# Match: active browser tab, while the browser is foreground
# Assign matched activity to: T01
```

Without a matching rule, activity remains unassigned.
A calendar block alone does not assign all activity to its task.

Specifications: `SPEC-M04`, `SPEC-M05`, `SPEC-C02`.

## 6. Work while the tracker runs

You write in Neovim inside tmux.
You do not start a separate timer for each window or tab.

```sh
day activity status
# Desktop watcher: running
# Browser watcher: running
# Tmux watcher: running
# Foreground project: ~/git/blog
# Matching task: T01
# Capture: enabled
```

You can pause capture when necessary.

```sh
day activity pause
# Capture paused
# This interval will appear as paused, not as idle time

day activity resume
# Capture resumed
```

These pause commands are optional examples. The sample session below has no pause and no missing data.

Specifications: `SPEC-M04`, `SPEC-C01`, `SPEC-C02`.

## 7. Save the result

It is now 09:30. You have an introduction draft, but the post is not finished.
End the session and record what changed.

```sh
day session end S01 \
  --progress "Drafted the introduction. Next: add an example." \
  --artifact ~/git/blog/posts/day.md
# Session S01: ended at 09:30
# Progress entry: P01
# Result: ~/git/blog/posts/day.md
# Task T01: paused, not completed
```

The result link is optional. A status update is enough.
Task completion remains a separate action.

```sh
day task show T01
# T01  Write the introduction
# State: paused
# Last progress: Drafted the introduction. Next: add an example.
# Last session: S01
```

Specifications: `SPEC-S02`, `SPEC-M02`.

## 8. Compare the plan with the records

Now Day can show what happened during the block.

```sh
day session show S01
# Planned:      09:00–09:30  30m
# Task T01:     09:00–09:24  24m  rule R01
# Unassigned:   09:24–09:30   6m  no matching rule
# Idle:                      0m
# Missing:                   0m
# Coverage:                100%
# Session adherence:        80%  (24m / 30m)
# Progress: P01
```

Here, **attribution** means “R01 connected these 24 observed minutes to T01”.
**Coverage** means “the watchers supplied data for the whole planned interval”.
**Session adherence** means “80% of the planned interval matched the task”.

Day does not call the other six minutes wasted. They have no accepted task connection yet.

You can inspect the reason behind a number.

```sh
day activity explain --session S01 --at 09:10
# Observation: O17
# Source: tmux watcher
# Foreground project: ~/git/blog
# Rule: R01, version 1
# Task: T01
# Goal: G01
# Method: project rule
```

On the website, selecting the corresponding chart segment shows the same records and P01.
This is the concrete behavior behind `SPEC-P01`: reconstruct the day from evidence.

Specifications: `SPEC-P01`, `SPEC-M05`, `SPEC-M06`, `SPEC-F01`, `SPEC-F02`.

## 9. Correct a wrong connection

Suppose you recognize that the six unassigned minutes were research for T01.
You can record that correction with a reason.

```sh
day activity assign --session S01 --from 09:24 --to 09:30 \
  --task T01 --reason "Read a source for the introduction"
# Attribution revision: A02
# Method: manual correction
# Previous attribution retained
# Session adherence after recalculation: 100%
```

This is an alternative branch. The remaining examples use the original 24-minute attribution.
Raw observations stay unchanged. Day keeps both attribution revisions.

If two rules disagree, Day shows an ambiguous interval instead of selecting a task without explanation.

Specifications: `SPEC-M05`, `SPEC-F03`.

## 10. Check the daily target

Your proposed daily target has three conditions:

- At least two distinct tasks with 80% session adherence and adequate coverage.
- At least three hours connected to current goals.
- A progress entry for each task started that day.

After this first session, Day can show progress toward that target.

```sh
day goal check intentional-day --date today
# As of: 09:30 — day still in progress
# Qualifying tasks: 1 / 2       target not reached yet
# Goal time:        24m / 3h    target not reached yet
# Progress entries: 1 / 1       met so far
# Final daily result: pending
```

“Pending” describes this live view. Final criterion results use `met`, `not_met`, or `insufficient_data`.
A session with missing data can have an inconclusive result.

```sh
day session show S03
# Separate example with a watcher failure
# Planned: 30m
# Accepted task time: 18m
# Missing: 12m
# Coverage: 60%
# Required coverage: 90% (proposed setting)
# Result: insufficient_data
```

Day must not turn missing data into a claim that you procrastinated.
Software correctness and your personal target are separate results.
The software can correctly report that a target was not met.

Specifications: `SPEC-S03`, `SPEC-F02`, `SPEC-G01` in the personal goal catalog.

## 11. Record what you noticed

You can save a personal observation without creating a new task.

```sh
day note add "Keeping the calendar visible helped me return after checking messages." \
  --session S01
# Note: N01
# Session: S01
# Visibility: private
```

Later, you can compare periods before and after a change.

```sh
day experiment add "Keep the calendar visible" \
  --hypothesis "A visible calendar helps me return to planned work" \
  --metric session-adherence \
  --baseline 2026-09-18..2026-09-24 \
  --period 2026-09-25..2026-10-01
# Experiment: X01
# Metric definition saved
# Baseline: unavailable until records exist
# Result: pending
```

Day shows the measurements beside your notes. You write the conclusion.
A comparison does not establish that the change caused the result.

Specifications: `SPEC-P02`, `SPEC-M07`.

## 12. Continue tomorrow

You open the same page the next morning.
The task and last progress entry are still there.

```sh
day today
# Current task: none
# Ready to continue: T01 — Write the introduction
# Last progress: Drafted the introduction. Next: add an example.

day task start T01 --duration 30m
# New session created
# Calendar block created
# Previous progress retained
```

Later, use history views to see changes over time.

```sh
day report --period week
# Opens the weekly activity and goal report
# Other periods: day, month, quarter, year
```

Specifications: `SPEC-P03`, `SPEC-M06`.

## Ask an agent for help

An agent can read the same task context without collecting it from several tools.

```sh
day task context T01 --json
# {
#   "schema_version": 1,
#   "task": {"id": "T01", "state": "paused"},
#   "goals": ["G01"],
#   "last_session": "S01",
#   "last_progress": "Drafted the introduction. Next: add an example.",
#   "next_actions": ["start", "schedule", "complete"]
# }
```

This is an abbreviated example. The full response also contains goal criteria, activity references, and source update times.
OpenCode can use this interface to help sort tasks or plan the next session.
Read-only credentials allow inspection but reject changes.

Specification: `SPEC-M08`.

## First installation

The previous steps assume a running installation.
The proposed first-start sequence is:

```sh
make prepare
# Checks Docker, task source, calendar source, environment, ports, and Caddy
# Reports missing requirements and how to resolve them

make setup
# Creates configuration and local stores without replacing existing data

make ci
# Runs checks with disposable stores and synthetic activity

make start
# Starts services and host watchers

make deploy
# Connects the local Caddy network
# Checks HTTPS access at https://day.home.br11k.dev

make tutorial
# Opens the working website and starts the guided task cycle
```

The future website tutorial guides the user through steps 1–8.
Each step shows an action, checks its saved result, and then offers the next step.
The tracker step requires a real observation. Closing the tutorial does not lose progress.

Specifications: `SPEC-M09`, `SPEC-M10`.

## How this walkthrough connects to the specification

| Walkthrough | Observable result | Specification |
| --- | --- | --- |
| Open the day | Calendar and priorities on a second screen | S01, M01 |
| Goal and task | Work has a stated purpose | M02, M03 |
| Start a session | A task gets a calendar block | S02 |
| Rules and tracker | Activity has a source and an explained task connection | M04, M05 |
| Save progress | An unfinished task has a recorded result | S02 |
| Inspect the session | Planned and observed time can be compared | P01, M06 |
| Check the daily target | Metrics use explicit definitions | S03, F02, G01 |
| Notes and experiments | Observations can be compared over time | P02, M07 |
| Continue tomorrow | Records survive restart | P03 |

The exact command names and output fields are proposed interface choices.
They illustrate the existing ACs. They are not additional verified behavior.

## Formal files

| File | Contents |
| --- | --- |
| `day-specs.jsonl` | 23 software specifications, 89 ACs, concerns, and spec relationships |
| `day-goals.jsonl` | The personal daily goal and its 3 ACs, with concerns |

The files use the record types and fields from the inspected Coherence bootstrap importer.
All specs remain drafts. No test links or passing results are fabricated.
Verification cases remain in spec descriptions as plans for future tests.

The catalogs are separate. Do not import personal goals into the software catalog.
The inspected importer inserts rows. It does not update existing IDs or make the whole import transactional.
Use a fresh, migrated catalog for each file. A repeated import can fail on duplicate IDs.
The inspected version also requires a manifest with `dolt_mode = "user-scoped"`.
It can report a skipped import with exit code zero in other modes.

After the software catalog is configured, its import command is:

```sh
coherence-bootstrap db import-jsonl --env dev --in day-specs.jsonl --confirm
```

Run the corresponding command from the separate personal-goal project:

```sh
coherence-bootstrap db import-jsonl --env dev --in /path/to/day-goals.jsonl --confirm
```

These Coherence commands are based on the inspected source. No live database import was run for this document.
The JSONL files have been checked for valid JSON, required fields, IDs, and references.

Importer reference: [coherence-bootstrap at c4fa255](https://github.com/usecoherence/coherence-bootstrap/blob/c4fa25549b8579e3e959cad4de55f8b4e2bc3210/crates/coherence-core-db/src/commands/db_import_jsonl.rs).


<details>
<summary>Implementation reference: software, data, formulas, deployment, and open decisions</summary>

### Software

| Part | Software and function |
| --- | --- |
| Backend | Rails API. Connects sources and stores notes, attributions, and calculated results. |
| Website | Nuxt. Shows the calendar, tasks, activity, and results. Requires login. |
| CLI | Rust. Provides one command, `day`, for the system. |
| Tasks | Taskwarrior or beads. Use one source for tasks. The choice is still open. |
| Calendar | A local calendar. The calendar software is still to be selected. |
| Goals | Coherence. Keep personal goals separate from software specifications. |
| Activity | ActivityWatch and a tmux watcher on the host. |
| Background work | Sidekiq. Imports data and calculates results. |
| Deployment | Docker Compose and the existing local Caddy network. |
| Address | `day.home.br11k.dev`. The address is configurable. |
| Agents | Use the same CLI and API as the user. An LLM is optional. |

Use the existing [Rails boilerplate](https://github.com/konovalov-nk/boilerplate-backend-rails-api) and [Nuxt boilerplate](https://github.com/konovalov-nk/boilerplate-frontend-nuxt).
Check their current configuration before implementation.
Use the existing Toptal deployment as a reference when it is available.

### Data

Each source owns its records.
Rails can keep a local copy of tasks, events, and goals.
These copies retain the source ID and revision.
Changes go through the source adapter.

| Record | Owner | Required data |
| --- | --- | --- |
| Goal | Coherence | Catalog ID, spec ID, AC IDs, revision, applicable dates |
| Task | Task source | ID, title, state, urgency, importance, goal references |
| CalendarEvent | Calendar source | Event and occurrence IDs, start, end, timezone, revision, cancellation state |
| WorkSession | Rails | ID, task ID, calendar occurrence, planned interval, actual start and end, state |
| Observation | ActivityWatch | Source, bucket, event ID, device, interval, watcher data, receipt time |
| CoverageInterval | Rails | Device, watcher, interval, status, reason |
| Attribution | Rails | Interval, task ID, observations, method, rule or model version, confidence if supplied, revision |
| ProgressEntry | Rails | Task, session, timestamp, status, summary, optional result links |
| JournalEntry | Rails | Timestamp, text, optional ratings, related records, visibility |
| Experiment | Rails | Hypothesis, change, dates, comparison periods, metric version, observations, conclusion |
| EvaluationRun | Rails and local files | Goal revision, period, input snapshot and hash, calculation versions, results, coverage, evidence links |

The tmux watcher sends compatible observations to ActivityWatch.
Coverage states include healthy, missing, paused, and idle.
An attribution can remain unassigned or ambiguous.

The CLI calls Rails for application operations.
The host part of the CLI manages local setup and watchers.
Some source adapters may also need to run on the host.
If Rails cannot call an adapter directly, use a local job connection.
Each job needs an operation ID and a result acknowledgement.
Processes must not share live database files as an integration method.

Task states are `inbox`, `ready`, `in_progress`, `paused`, `completed`, and `cancelled`.
Adapters must preserve additional source states when necessary.
A progress entry does not complete a task.

Session states are `planned`, `running`, `ended`, and `cancelled`.
A pause ends the current active interval.
An external meeting does not need a task.

### Measurement examples

Accepted task time means non-idle time with an accepted attribution to the task.
Day measures activity connected to a task. It does not measure cognition.

| Input | Result |
| --- | --- |
| Planned: 60 minutes. Accepted: 48 minutes. Full coverage. | 80% adherence. The session qualifies. |
| Planned: 60 minutes. Accepted: 48 minutes. Missing: 12 minutes. | 80% adherence lower bound. 80% coverage. Insufficient data under the proposed 90% rule. |
| Browser and tmux describe the same 30 minutes. | At most 30 minutes in the total. |
| One task has two sessions at 80%. | One qualifying task. |
| One task has 10 minutes at 100% and 50 minutes at 60%. | 40/60 = 66.67%. The task does not qualify. |
| Three goal hours. Task unfinished. Progress saved. | Time and progress criteria can pass. |
| Calendar block without observations. | Planned time only. No observed work. |

Configure the days on which the personal target applies.
Rest days do not need the same target.
The proposed targets are personal experiment settings.

Three recorded goal hours can establish the time target even when other periods have missing data.
If recorded time is below three hours and coverage is incomplete, the result is `insufficient_data`.
Missing data alone cannot establish success or failure.

A day without eligible sessions does not meet the two-task target.
Progress completeness uses the session list. It does not depend on watcher coverage.
All three personal ACs use `review_mode: hybrid` until attribution quality has been reviewed.

The minimum duration for a qualifying task remains undecided.
Without a minimum, a very short task can qualify.
Work outside planned blocks can count toward goal hours.
It does not count toward scheduled-session adherence.

### Additional rules

### Task categories

| Urgency | Importance | Category |
| --- | --- | --- |
| At least one field is unset | — | Inbox |
| Urgent | High | Urgent, high priority |
| Non-urgent | High | Non-urgent, high priority |
| Urgent | Low | Urgent, low priority |
| Non-urgent | Low | Non-urgent, low priority |

Urgency and importance are separate fields.
Taskwarrior's native urgency value must not silently set both fields.

### Activity scope

The first version records desktop application, browser tab, and tmux context.
It does not record keystrokes, page contents, screenshots, or phone activity.
Detailed actions inside applications need separate adapters.

### Optional services

Google synchronization is optional and comes after the first local version.
Attribution rules must work before LLM suggestions are added.
OpenCode uses the documented CLI. It does not need a separate copy of application logic.

### Performance

The 30-second refresh interval and 500 ms API target are proposals.
The performance report must identify the machine and dataset size.

### Repository structure

| Path | Contents |
| --- | --- |
| `backend/` | Rails API, background jobs, imported data, attribution, notes, and experiments |
| `frontend/` | Nuxt website and charts |
| `cli/` | One Rust workspace, CLI, and host adapters |
| `calendar/` | Calendar setup, configuration, and test data |
| `tasks/` | Task source setup, configuration, and test data |
| `goals/` | Personal Coherence catalog configuration and goal checks |
| `time-tracker/` | ActivityWatch setup, tmux watcher, and exclusion settings |
| `deploy/` | Docker Compose, Caddy integration, service definitions, and smoke tests |
| `.coherence/` | Software specification catalog and versioned exports |
| `journal/` | Notes and results selected for publication |
| `Makefile` | Commands for setup, services, checks, deployment, and tutorial |

Private runtime data stays outside tracked files.
This includes private notes, raw activity, personal goals, credentials, and test-run output.
The folder structure does not require separate CLI programs for each adapter.

### First start

1. Run `make prepare` to check requirements.
2. Run `make setup` to create configuration and stores.
3. Run `make ci` to check the installation with isolated test data.
4. Run `make start` to start services and watchers.
5. Run `make deploy` to connect Caddy and check HTTPS access.
6. Run `make tutorial` to complete the first task cycle.

The Makefile calls the same operations as the CLI.
Use `make status` to inspect services.
Use `make stop` to stop services without data deletion.
Check the existing Caddy network, certificate method, and host configuration before deployment.

### Implementation order

| Stage | Result | Specifications |
| --- | --- | --- |
| 1 | Open a local calendar on the target screens through authenticated HTTPS. | S01, S04, M01, M09, C03 |
| 2 | Create a task and goal. Start a session and save progress. | S02, M02, M03, M08 |
| 3 | Record real browser and tmux activity. Show idle and missing intervals. | M04, C01, C02, F01 |
| 4 | Apply attribution rules. Check the daily target. Complete the tutorial. | S03, M05, F02, M10, P03 |
| 5 | Add historical charts, experiments, notes, recovery, and selected public exports. | P01, P02, M06, M07, F03 |
| 6 | Add optional Google synchronization, agent workflows, and LLM suggestions. | AC-M01-03, AC-M05-05, M08 |

Build the tutorial during stages 1–4.
Add a tutorial step when its function works.
Do not wait for all charts or an LLM before recording the first day.

### Open decisions

- Taskwarrior or beads.
- Local calendar software.
- Google synchronization direction and conflict rules.
- Supported host sessions, browsers, and tmux window identification.
- Required watchers and minimum coverage. The proposed coverage threshold is 90%.
- Minimum qualifying task duration.
- Day and week boundaries.
- Data retention and backup policy.
- Data selected for publication or remote inference.

### Coherence taxonomy

Reference: `usecoherence/coherence-bootstrap`, commit `c4fa25549b8579e3e959cad4de55f8b4e2bc3210`.

| Field | Values |
| --- | --- |
| Spec level | `product`, `system`, `module`, `component`, `foundation` |
| Spec status | `draft`, `active`, `deprecated`, `archived` |
| AC review mode | `manual`, `automated`, `hybrid` |
| AC risk level | `low`, `medium`, `high`, `critical` |
| AC concern | `correctness`, `security`, `performance`, `reliability`, `maintainability` |
| Spec relations used here | `depends_on`, `constrained_by` |
| Supported code relations | `verified_by`, `implemented_by`, `touched_by` |

Day's level assignments are draft design choices.
The source model defines the available levels, not these assignments.

For a spec slug, remove `SPEC-`, use lowercase, and add the level prefix.
Example: `SPEC-P01` becomes `product/p01`.
For an AC slug, remove `AC-` and use lowercase.
The personal goal uses `product/intentional-day`.

No evidence links have been created.
Add `verified_by` links only when the corresponding checks exist and have been reviewed.

Sources: [model](https://github.com/usecoherence/coherence-bootstrap/blob/c4fa25549b8579e3e959cad4de55f8b4e2bc3210/crates/coherence-core-db/src/models.rs), [README](https://github.com/usecoherence/coherence-bootstrap/blob/c4fa25549b8579e3e959cad4de55f8b4e2bc3210/README.md), [export format](https://github.com/usecoherence/coherence-bootstrap/blob/c4fa25549b8579e3e959cad4de55f8b4e2bc3210/.coherence/exports/bootstrap-specs.jsonl).


</details>
