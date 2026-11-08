import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx, many, one } from "../src/db.js";
import { demoSeed } from "../src/demo.js";
import { exportData, importData, writeBackup, deleteEntity } from "../src/data.js";
import { deleteNote } from "../src/notes.js";
import { zonedToUtc } from "../src/time.js";

function context(prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  const ctx = createCtx({
    dbPath: resolve(directory, "day.sqlite"),
    dataDir: directory,
    now: zonedToUtc("2026-09-25", "09:30", "Europe/Warsaw"),
  });
  return { ctx, directory };
}

test("private backup restores into a separate installation with matching counts", () => {
  const source = context("day-backup-source-");
  const target = context("day-backup-target-");
  const file = resolve(source.directory, "backup.json");
  try {
    demoSeed(source.ctx);
    const written = writeBackup(source.ctx, file);
    const result = importData(target.ctx, file);
    assert.equal(result.matches, true);
    for (const [table, count] of Object.entries(written.counts)) {
      assert.equal(
        one<{ count: number }>(target.ctx.db, `SELECT COUNT(*) AS count FROM ${table}`)?.count,
        count,
        table,
      );
    }
    const tasks = many<{ id: number }>(target.ctx.db, "SELECT id FROM tasks ORDER BY id");
    assert.deepEqual(
      tasks.map((task) => task.id),
      [1, 2, 3],
    );
    const observations = many<{ id: number }>(
      target.ctx.db,
      "SELECT id FROM observations ORDER BY id",
    );
    assert.equal(observations.length, 2);
  } finally {
    source.ctx.close();
    target.ctx.close();
    rmSync(source.directory, { recursive: true, force: true });
    rmSync(target.directory, { recursive: true, force: true });
  }
});

test("public export excludes private notes and raw activity", () => {
  const { ctx, directory } = context("day-public-");
  try {
    demoSeed(ctx);
    const data = exportData(ctx, { publicOnly: true });
    assert.equal(data.public, true);
    assert.equal("notes" in data.tables, false);
    assert.equal("observations" in data.tables, false);
    assert.equal("attributions" in data.tables, false);
    assert.equal("tasks" in data.tables, true);
    assert.equal("evaluations" in data.tables, true);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("note deletion removes content and records only the deletion", () => {
  const { ctx, directory } = context("day-delete-note-");
  try {
    demoSeed(ctx);
    const result = deleteNote(ctx, 1, "test");
    assert.equal(result.deleted, "N01");
    assert.equal(one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM notes")?.count, 0);
    assert.equal(
      one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM note_revisions")?.count,
      0,
    );
    const deletion = one<{ entity: string; entity_id: number }>(
      ctx.db,
      "SELECT entity, entity_id FROM deletions WHERE entity = 'note'",
    );
    assert.deepEqual({ ...deletion }, { entity: "note", entity_id: 1 });
    assert.match(result.backup_effect, /backups/i);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("task deletion invalidates evaluations but keeps raw observations", () => {
  const { ctx, directory } = context("day-delete-task-");
  try {
    demoSeed(ctx);
    const result = deleteEntity(ctx, { task: "T01" });
    assert.equal(result.deleted, "T01");
    assert.equal(
      one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM tasks WHERE id = 1")?.count,
      0,
    );
    assert.equal(
      one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM sessions WHERE task_id = 1")
        ?.count,
      0,
    );
    assert.equal(
      one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM observations")?.count,
      2,
    );
    assert.equal(
      one<{ count: number }>(ctx.db, "SELECT COUNT(*) AS count FROM evaluations")?.count,
      0,
    );
    assert.match(result.effect, /Raw observations remain/);
  } finally {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
