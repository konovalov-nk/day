import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorized } from "./auth.js";
import type { Ctx } from "./db.js";
import { AppError, errorPayload } from "./errors.js";
import { buildDashboard } from "./dashboard.js";
import { listObservations, sourceStates, captureState } from "./activity.js";
import { occurrencesBetween } from "./events.js";
import { listNotes } from "./notes.js";
import { report, type Period } from "./reports.js";
import { sessionShow } from "./sessions.js";
import { taskContext } from "./tasks.js";
import { parseRef } from "./ids.js";
import { endOfLocalDay, localDateAt, parseInstant, startOfLocalDay } from "./time.js";
import {
  renderDashboardMain,
  renderDashboardPage,
  renderNotFound,
  renderReportPage,
  renderSessionPage,
} from "./web.js";

const PERIODS: Period[] = ["day", "week", "month", "quarter", "year"];

export function createDayServer(ctx: Ctx): Server {
  return createServer((request, response) => {
    void handle(ctx, request, response);
  });
}

export async function startServer(
  ctx: Ctx,
  options: { host?: string; port?: number } = {},
): Promise<Server> {
  const server = createDayServer(ctx);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? ctx.config.port, options.host ?? ctx.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function handle(ctx: Ctx, request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://localhost");
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      sendJson(response, 405, {
        schema_version: 1,
        error: { code: "read_only", message: "The website is read-only" },
      });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", schema_version: 1 });
      return;
    }
    if (!authorized(ctx.config, request)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="Day"');
      sendJson(response, 401, {
        schema_version: 1,
        error: { code: "unauthorized", message: "Authentication required" },
      });
      return;
    }
    route(ctx, request, response, url);
  } catch (error) {
    const payload = errorPayload(error);
    const status = statusFor(error);
    if (url.pathname.startsWith("/api/")) {
      sendJson(response, status, { schema_version: 1, ...payload });
    } else {
      sendHtml(response, status, renderNotFound(payload.error.message));
    }
  }
}

function route(ctx: Ctx, _request: IncomingMessage, response: ServerResponse, url: URL): void {
  if (routePage(ctx, response, url)) return;
  if (routeApi(ctx, response, url)) return;
  sendJson(response, 404, {
    schema_version: 1,
    error: { code: "not_found", message: `No route for ${url.pathname}` },
  });
}

function routePage(ctx: Ctx, response: ServerResponse, url: URL): boolean {
  const path = url.pathname;
  if (path === "/") {
    const data = ctx.db.transaction(() =>
      buildDashboard(ctx, dateParam(ctx, url.searchParams.get("date"))),
    )();
    sendHtml(response, 200, renderDashboardPage(data));
    return true;
  }
  if (path === "/partials/dashboard") {
    const data = ctx.db.transaction(() =>
      buildDashboard(ctx, dateParam(ctx, url.searchParams.get("date"))),
    )();
    sendHtml(response, 200, renderDashboardMain(data));
    return true;
  }
  if (path.startsWith("/session/")) {
    const view = sessionShow(ctx, parseRef(path.slice("/session/".length), "session"));
    sendHtml(response, 200, renderSessionPage(view));
    return true;
  }
  if (path === "/report") {
    const period = periodParam(url.searchParams.get("period"));
    const date = dateParam(ctx, url.searchParams.get("date"));
    sendHtml(response, 200, renderReportPage(report(ctx, period, date)));
    return true;
  }
  return false;
}

function routeApi(ctx: Ctx, response: ServerResponse, url: URL): boolean {
  const path = url.pathname;
  if (path === "/api/v1/dashboard") {
    const data = ctx.db.transaction(() =>
      buildDashboard(ctx, dateParam(ctx, url.searchParams.get("date"))),
    )();
    sendJson(response, 200, data);
    return true;
  }
  if (path === "/api/v1/report") {
    const period = periodParam(url.searchParams.get("period"));
    sendJson(response, 200, report(ctx, period, dateParam(ctx, url.searchParams.get("date"))));
    return true;
  }
  if (path.startsWith("/api/v1/sessions/")) {
    sendJson(
      response,
      200,
      sessionShow(ctx, parseRef(path.slice("/api/v1/sessions/".length), "session")),
    );
    return true;
  }
  if (path.startsWith("/api/v1/tasks/") && path.endsWith("/context")) {
    const ref = path.slice("/api/v1/tasks/".length, -"/context".length);
    sendJson(response, 200, taskContext(ctx, parseRef(ref, "task")));
    return true;
  }
  if (path === "/api/v1/calendar") return calendarApi(ctx, response, url);
  if (path === "/api/v1/observations") return observationsApi(ctx, response, url);
  if (path === "/api/v1/notes") {
    sendJson(response, 200, { schema_version: 1, items: listNotes(ctx, 100) });
    return true;
  }
  if (path === "/api/v1/sources") {
    sendJson(response, 200, {
      schema_version: 1,
      capture: captureState(ctx),
      sources: sourceStates(ctx),
    });
    return true;
  }
  return false;
}

function calendarApi(ctx: Ctx, response: ServerResponse, url: URL): boolean {
  const range = boundedRange(ctx, url);
  sendJson(response, 200, {
    schema_version: 1,
    events: occurrencesBetween(ctx, range.from, range.to),
  });
  return true;
}

function observationsApi(ctx: Ctx, response: ServerResponse, url: URL): boolean {
  const range = boundedRange(ctx, url, 7);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");
  sendJson(response, 200, {
    schema_version: 1,
    ...listObservations(ctx, range.from, range.to, limit, offset),
  });
  return true;
}

function dateParam(ctx: Ctx, value: string | null): string {
  const today = localDateAt(ctx.now(), ctx.timezone);
  if (!value || value === "today") return today;
  if (value === "yesterday")
    return localDateAt(new Date(ctx.now().getTime() - 86_400_000), ctx.timezone);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("invalid_date", "Expected YYYY-MM-DD");
  }
  return value;
}

function periodParam(value: string | null): Period {
  if (!value) return "day";
  if (!PERIODS.includes(value as Period)) {
    throw new AppError("invalid_period", "Period must be day, week, month, quarter, or year");
  }
  return value as Period;
}

function boundedRange(ctx: Ctx, url: URL, maxDays = 92): { from: Date; to: Date } {
  const today = localDateAt(ctx.now(), ctx.timezone);
  const fromValue = url.searchParams.get("from") ?? today;
  const toValue = url.searchParams.get("to") ?? fromValue;
  const from = rangeBoundary(ctx, fromValue, false);
  const to = rangeBoundary(ctx, toValue, true);
  if (to <= from) throw new AppError("invalid_range", "The range end must be after its start");
  if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
    throw new AppError("range_too_large", `The range is limited to ${maxDays} days`);
  }
  return { from, to };
}

function rangeBoundary(ctx: Ctx, value: string, end: boolean): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return end ? endOfLocalDay(value, ctx.timezone) : startOfLocalDay(value, ctx.timezone);
  }
  return parseInstant(value);
}

function statusFor(error: unknown): number {
  if (!(error instanceof AppError)) return 500;
  if (error.code.endsWith("_not_found") || error.code === "not_found") return 404;
  if (error.code === "unauthorized") return 401;
  if (error.code === "read_only") return 405;
  if (
    error.code.startsWith("invalid_") ||
    error.code.endsWith("_large") ||
    error.code === "future_evaluation"
  ) {
    return 400;
  }
  return 500;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
