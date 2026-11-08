import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  formatDuration,
  interval,
  localDateAt,
  localTimeAt,
  parseDuration,
  startOfLocalDay,
  subtract,
  subtractAll,
  totalSeconds,
  union,
  zonedToUtc,
} from "../src/time.js";

test("zoned time converts Europe/Warsaw summer and winter", () => {
  const summer = zonedToUtc("2026-09-25", "09:00", "Europe/Warsaw");
  assert.equal(summer.toISOString(), "2026-09-25T07:00:00.000Z");
  assert.equal(localTimeAt(summer, "Europe/Warsaw"), "09:00");
  const winter = zonedToUtc("2026-01-15", "09:00", "Europe/Warsaw");
  assert.equal(winter.toISOString(), "2026-01-15T08:00:00.000Z");
});

test("local date survives around midnight", () => {
  const instant = zonedToUtc("2026-09-25", "00:10", "Europe/Warsaw");
  assert.equal(localDateAt(instant, "Europe/Warsaw"), "2026-09-25");
  assert.equal(localDateAt(instant, "UTC"), "2026-09-24");
});

test("half-open interval union merges overlaps and adjacent intervals", () => {
  const merged = union([
    interval("2026-09-25T09:00:00Z", "2026-09-25T09:10:00Z"),
    interval("2026-09-25T09:10:00Z", "2026-09-25T09:20:00Z"),
    interval("2026-09-25T09:15:00Z", "2026-09-25T09:30:00Z"),
  ]);
  assert.equal(merged.length, 1);
  assert.equal(totalSeconds(merged), 1800);
});

test("subtract removes overlaps without changing the base", () => {
  const base = interval("2026-09-25T09:00:00Z", "2026-09-25T09:30:00Z");
  const pieces = subtract(base, [interval("2026-09-25T09:10:00Z", "2026-09-25T09:20:00Z")]);
  assert.deepEqual(
    pieces.map((piece) => [new Date(piece.start).toISOString(), new Date(piece.end).toISOString()]),
    [
      ["2026-09-25T09:00:00.000Z", "2026-09-25T09:10:00.000Z"],
      ["2026-09-25T09:20:00.000Z", "2026-09-25T09:30:00.000Z"],
    ],
  );
  assert.equal(totalSeconds(subtractAll([base], [])), 1800);
});

test("durations parse and format", () => {
  assert.equal(parseDuration("30m"), 1800);
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("90s"), 90);
  assert.equal(formatDuration(1800), "30m");
  assert.equal(formatDuration(5400), "1h 30m");
  assert.throws(() => parseDuration("0m"));
});

test("calendar day and week arithmetic", () => {
  assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(
    startOfLocalDay("2026-09-25", "Europe/Warsaw").toISOString(),
    "2026-09-24T22:00:00.000Z",
  );
});
