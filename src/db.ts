import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { nowDate } from "./time.js";

export type Db = Database.Database;

export interface Ctx {
  config: Config;
  db: Db;
  timezone: string;
  now: () => Date;
  close: () => void;
}

function schemaText(): string {
  return readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
}

export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.exec(schemaText());
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare("INSERT OR IGNORE INTO capture_state (id, paused, updated_at) VALUES (1, 0, ?)").run(
    new Date().toISOString(),
  );
  return db;
}

export interface CreateCtxOptions extends Partial<Config> {
  now?: Date;
}

export function createCtx(options: CreateCtxOptions = {}): Ctx {
  const config: Config = { ...loadConfig(), ...options };
  const db = openDb(config.dbPath);
  const fixed = options.now;
  const now = () => fixed ?? nowDate(config.nowOverride);
  return {
    config,
    db,
    timezone: config.timezone,
    now,
    close: () => db.close(),
  };
}

export function one<T>(db: Db, sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function many<T>(db: Db, sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(db: Db, sql: string, ...params: unknown[]): Database.RunResult {
  return db.prepare(sql).run(...params);
}

export function getMeta(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
  run(
    db,
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

export function inTransaction<T>(db: Db, work: () => T): T {
  return db.transaction(work)();
}
