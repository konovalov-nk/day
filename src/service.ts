import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Ctx } from "./db.js";
import { many, one } from "./db.js";
import { AppError } from "./errors.js";
import { ensureDataDir, ensureEnvFile, readEnvValue } from "./config.js";
import { importGoalRecords } from "./goals.js";
import { demoSeed } from "./demo.js";
import { captureState, sourceStates } from "./activity.js";

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export async function prepare(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({
    name: "Node.js",
    status: Number(process.versions.node.split(".")[0]) >= 22 ? "ok" : "fail",
    detail: `v${process.versions.node} (requires >=22)`,
  });
  const port = await portFree(ctx.config.port);
  checks.push({
    name: `Port ${ctx.config.port}`,
    status: port ? "ok" : "warn",
    detail: port ? "available" : "already in use; set DAY_PORT",
  });
  const envPath = resolve(ctx.config.root, ".env");
  checks.push({
    name: "Configuration",
    status: existsSync(envPath) ? "ok" : "warn",
    detail: existsSync(envPath) ? ".env exists" : "no .env; run `day setup`",
  });
  checks.push({
    name: "Data path",
    status: writable(resolve(ctx.config.dataDir)) ? "ok" : "fail",
    detail: ctx.config.dbPath,
  });
  const caddy = caddyNetwork(ctx);
  checks.push({
    name: "Caddy",
    status: caddy ? "ok" : "warn",
    detail: caddy
      ? `network ${ctx.config.caddyNetwork} found`
      : "Caddy network not found; local HTTP still works",
  });
  for (const [name, detail] of [
    ["curl", "needed for health checks"],
    ["tmux", "tmux watcher adapter"],
    ["hyprctl", "desktop watcher adapter"],
    ["docker", "Caddy network check"],
  ] as const) {
    checks.push({
      name,
      status: commandExists(name) ? "ok" : "warn",
      detail: commandExists(name) ? "available" : `${detail} not found`,
    });
  }
  checks.push({
    name: "Goal catalog",
    status: existsSync(resolve(ctx.config.root, "day-goals.jsonl")) ? "ok" : "warn",
    detail: existsSync(resolve(ctx.config.root, "day-goals.jsonl"))
      ? "day-goals.jsonl is available"
      : "day-goals.jsonl missing; intentional-day check uses built-in definitions",
  });
  return checks;
}

function writable(path: string): boolean {
  try {
    const probe = resolve(path, ".day-prepare");
    writeFileSync(probe, "");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => server.close(() => resolvePromise(true)));
    server.listen(port, "127.0.0.1");
  });
}

function caddyNetwork(ctx: Ctx): boolean {
  const result = spawnSync("docker", ["network", "inspect", ctx.config.caddyNetwork], {
    stdio: "ignore",
  });
  return result.status === 0;
}

export function setup(ctx: Ctx, options: { demo?: boolean } = {}) {
  ensureDataDir(ctx.config);
  const env = ensureEnvFile(ctx.config);
  const imported: Array<{ id: number; sourceId: string }> = [];
  const goalsFile = resolve(ctx.config.root, "day-goals.jsonl");
  if (existsSync(goalsFile)) {
    const hasPersonal = one<{ count: number }>(
      ctx.db,
      "SELECT COUNT(*) AS count FROM goals WHERE catalog = 'personal' AND source_id = 'SPEC-G01'",
    );
    if (!hasPersonal || hasPersonal.count === 0) {
      const records = readFileSync(goalsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      imported.push(...importGoalRecords(ctx, records as never, "personal"));
    }
  }
  const demo = options.demo ? demoSeed(ctx) : null;
  return {
    created_env: env.created,
    env_path: env.path,
    imported_goals: imported,
    demo,
    password_hint: "Credentials are in .env (DAY_USER / DAY_PASSWORD, DAY_READ_TOKEN).",
  };
}

export function start(ctx: Ctx): { url: string; pid: number } {
  if (systemdAvailable()) {
    const current = systemdPid();
    if (current && systemdActive()) return { url: ctx.config.baseUrl, pid: current };
    spawnSync("systemctl", ["--user", "start", "day.service"], { stdio: "ignore" });
    if (!waitForHealth(`http://127.0.0.1:${ctx.config.port}`, 6000)) {
      throw new AppError("start_failed", "Systemd service did not become healthy", { exitCode: 1 });
    }
    return { url: ctx.config.baseUrl, pid: systemdPid() ?? 0 };
  }
  const pidPath = resolve(ctx.config.dataDir, "day.pid");
  const running = runningPid(ctx);
  if (running) return { url: ctx.config.baseUrl, pid: running };
  ensureDataDir(ctx.config);
  const logPath = resolve(ctx.config.dataDir, "day.log");
  const fd = openSync(logPath, "a");
  const servePath = existsSync(resolve(ctx.config.root, "src/serve.ts"))
    ? resolve(ctx.config.root, "src/serve.ts")
    : resolve(ctx.config.root, "dist/serve.js");
  const args = servePath.endsWith(".ts") ? ["--import", "tsx", servePath] : [servePath];
  const child = spawn(process.execPath, args, {
    cwd: ctx.config.root,
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  child.unref();
  closeSync(fd);
  if (!child.pid) throw new AppError("start_failed", "Unable to start the server");
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  const healthy = waitForHealth(`http://127.0.0.1:${ctx.config.port}`, 6000);
  if (!healthy) {
    throw new AppError("start_failed", `Server did not become healthy. Check ${logPath}`, {
      exitCode: 1,
    });
  }
  return { url: ctx.config.baseUrl, pid: child.pid };
}

function waitForHealth(url: string, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync("curl", ["-fsS", "--max-time", "1", `${url}/health`], {
      stdio: "ignore",
    });
    if (result.status === 0) return true;
    sleep(150);
  }
  return false;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function runningPid(ctx: Ctx): number | null {
  const pidPath = resolve(ctx.config.dataDir, "day.pid");
  if (!existsSync(pidPath)) return null;
  const pid = Number(readFileSync(pidPath, "utf8"));
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export function stop(ctx: Ctx): { stopped: boolean; pid: number | null } {
  if (systemdAvailable() && systemdActive()) {
    const pid = systemdPid();
    spawnSync("systemctl", ["--user", "stop", "day.service"], { stdio: "ignore" });
    return { stopped: true, pid };
  }
  const pid = runningPid(ctx);
  if (!pid) {
    rmSync(resolve(ctx.config.dataDir, "day.pid"), { force: true });
    return { stopped: false, pid: null };
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      sleep(100);
    } catch {
      rmSync(resolve(ctx.config.dataDir, "day.pid"), { force: true });
      return { stopped: true, pid };
    }
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
  rmSync(resolve(ctx.config.dataDir, "day.pid"), { force: true });
  return { stopped: true, pid };
}

export function status(ctx: Ctx) {
  const pid = runningPid(ctx) ?? systemdPid();
  const health = curlHealth(`http://127.0.0.1:${ctx.config.port}`);
  const capture = captureState(ctx);
  const sources = sourceStates(ctx);
  const counts = {
    goals: count(ctx, "goals"),
    tasks: count(ctx, "tasks"),
    sessions: count(ctx, "sessions"),
    observations: count(ctx, "observations"),
    notes: count(ctx, "notes"),
  };
  const pending = many<{ id: string }>(ctx.db, "SELECT id FROM operations WHERE status != 'done'");
  return {
    server: { running: Boolean(pid) || health, pid, healthy: health, url: ctx.config.baseUrl },
    capture: capture.paused ? "paused" : "enabled",
    sources,
    counts,
    pending_operations: pending.map((row) => row.id),
  };
}

function count(ctx: Ctx, table: string): number {
  return one<{ count: number }>(ctx.db, `SELECT COUNT(*) AS count FROM ${table}`)?.count ?? 0;
}

function systemdAvailable(): boolean {
  return spawnSync("systemctl", ["--user", "cat", "day.service"], { stdio: "ignore" }).status === 0;
}

function systemdActive(): boolean {
  return (
    spawnSync("systemctl", ["--user", "is-active", "--quiet", "day.service"], { stdio: "ignore" })
      .status === 0
  );
}

function systemdPid(): number | null {
  const result = spawnSync(
    "systemctl",
    ["--user", "show", "-p", "MainPID", "--value", "day.service"],
    {
      encoding: "utf8",
    },
  );
  const pid = Number(result.stdout.trim());
  return result.status === 0 && Number.isFinite(pid) && pid > 0 ? pid : null;
}

function curlHealth(baseUrl: string): boolean {
  return (
    spawnSync("curl", ["-fsS", "--max-time", "1", `${baseUrl}/health`], { stdio: "ignore" })
      .status === 0
  );
}

export function statusText(ctx: Ctx, view: ReturnType<typeof status>): string[] {
  return [
    `Server: ${view.server.running ? `running (pid ${view.server.pid})` : "stopped"}${view.server.healthy ? " · healthy" : ""}`,
    `URL: ${view.server.url}`,
    `Capture: ${view.capture}`,
    ...view.sources.map(
      (source) =>
        `Source ${source.source}: ${source.last_success_at ? `last update ${source.last_success_at}` : "never"}${
          source.stale ? " · stale" : ""
        }`,
    ),
    `Records: ${Object.entries(view.counts)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")}`,
    ...(view.pending_operations.length > 0
      ? [`Pending operations: ${view.pending_operations.join(", ")}`]
      : []),
    `Database: ${ctx.config.dbPath}`,
  ];
}

export function ci(ctx: Ctx): number {
  const directory = mkdtempSync(resolve(tmpdir(), "day-ci-"));
  const env = {
    ...process.env,
    DAY_DATA_DIR: directory,
    DAY_DB_PATH: resolve(directory, "day.sqlite"),
    DAY_DEMO: "1",
  };
  const result = spawnSync("npm", ["run", "ci"], {
    cwd: ctx.config.root,
    env,
    stdio: "inherit",
  });
  rmSync(directory, { recursive: true, force: true });
  return result.status ?? 1;
}

export function deploy(ctx: Ctx): { ok: boolean; steps: string[] } {
  const steps: string[] = [];
  if (!caddyNetwork(ctx)) {
    steps.push(`Create the Caddy network: docker network create ${ctx.config.caddyNetwork}`);
    steps.push("Start the existing Caddy container with that network.");
    return { ok: false, steps };
  }
  steps.push(`Caddy network ${ctx.config.caddyNetwork}: ok`);
  steps.push(
    `Add deploy/Caddyfile to Caddy for ${ctx.config.caddyHost} -> ${ctx.config.host}:${ctx.config.port}`,
  );
  const https = spawnSync(
    "curl",
    ["-kfsS", "--max-time", "5", `https://${ctx.config.caddyHost}/health`],
    { stdio: "ignore" },
  );
  if (https.status !== 0) {
    steps.push(`HTTPS check failed: https://${ctx.config.caddyHost}/health`);
    steps.push("Check DNS, the Caddy reverse proxy, and certificate trust.");
    return { ok: false, steps };
  }
  steps.push(`HTTPS check: https://${ctx.config.caddyHost}/health ok`);
  return { ok: true, steps };
}

export function readSecret(key: string): string | undefined {
  return readEnvValue(key);
}
