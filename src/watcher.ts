import { spawnSync } from "node:child_process";
import type { Ctx } from "./db.js";
import { captureState, recordObservation } from "./activity.js";
import { localTimeAt } from "./time.js";

export interface WatchOptions {
  source: "tmux" | "desktop";
  project?: string;
  intervalSeconds: number;
}

interface TmuxClient {
  name: string;
  flags: string;
  session: string;
}

interface TmuxContext {
  session: string;
  window: string;
  pane: string;
  project: string;
}

export function watchForever(ctx: Ctx, options: WatchOptions): never {
  process.stdout.write(
    `Watching ${options.source} every ${options.intervalSeconds}s. Ctrl-C stops.\n`,
  );
  let lastLabel = "";
  for (;;) {
    const start = new Date();
    sleep(options.intervalSeconds * 1000);
    const end = new Date();
    if (captureState(ctx).paused) {
      if (lastLabel !== "paused")
        process.stdout.write("Capture paused; no observations recorded.\n");
      lastLabel = "paused";
      continue;
    }
    const observation = options.source === "tmux" ? tmuxObservation(options) : desktopObservation();
    if (!observation) {
      if (lastLabel !== "none") process.stdout.write("No foreground context found.\n");
      lastLabel = "none";
      continue;
    }
    recordObservation(ctx, {
      source: options.source,
      bucket: "watch",
      eventId: `${options.source}-${start.getTime()}-${end.getTime()}`,
      start: start.toISOString(),
      end: end.toISOString(),
      project: observation.project,
      app: observation.app,
      tmuxSession: observation.session,
      tmuxWindow: observation.window,
      tmuxPane: observation.pane,
    });
    const label = observation.project ?? observation.app ?? observation.session ?? "unknown";
    if (label !== lastLabel) {
      process.stdout.write(`${localTimeAt(end, ctx.timezone)} ${label}\n`);
      lastLabel = label;
    }
  }
}

function tmuxObservation(
  options: WatchOptions,
): { project?: string; app?: string; session?: string; window?: string; pane?: string } | null {
  const clients = tmuxClients();
  if (clients.length === 0) return null;
  const focused = clients.filter((client) => client.flags.includes("focused"));
  if (clients.length > 1 && focused.length !== 1) {
    return { app: "tmux", session: "unknown" };
  }
  const client = focused[0] ?? clients[0];
  const context = client ? tmuxContext(client) : null;
  if (!context) return { app: "tmux", session: "unknown" };
  return {
    project: options.project ?? context.project,
    session: context.session,
    window: context.window,
    pane: context.pane,
  };
}

function tmuxClients(): TmuxClient[] {
  const result = spawnSync(
    "tmux",
    ["list-clients", "-F", "#{client_name}\t#{client_flags}\t#{session_name}"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", flags = "", session = ""] = line.split("\t");
      return { name, flags, session };
    });
}

function tmuxContext(client: TmuxClient): TmuxContext | null {
  const result = spawnSync(
    "tmux",
    [
      "display-message",
      "-p",
      "-c",
      client.name,
      "#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_current_path}",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const [session = "", window = "", pane = "", project = ""] = result.stdout.trim().split("\t");
  return {
    session: session || client.session,
    window,
    pane,
    project: project || process.cwd(),
  };
}

function desktopObservation(): {
  app?: string;
  project?: string;
  session?: string;
  window?: string;
  pane?: string;
} | null {
  const result = spawnSync("hyprctl", ["activewindow", "-j"], { encoding: "utf8" });
  if (result.status === 0) {
    try {
      const window = JSON.parse(result.stdout) as { class?: string };
      return window.class ? { app: window.class } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
