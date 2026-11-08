import type { Command } from "commander";
import { createCtx, type Ctx } from "./db.js";
import { AppError, errorPayload } from "./errors.js";
import { withOperation } from "./operations.js";
import { localDateAt, parseWhen, zonedToUtc } from "./time.js";

export interface CommonOptions {
  json?: boolean;
}

export function withCtx<T>(work: (ctx: Ctx) => T): T {
  const ctx = createCtx();
  try {
    return work(ctx);
  } finally {
    ctx.close();
  }
}

export async function withCtxAsync<T>(work: (ctx: Ctx) => Promise<T>): Promise<T> {
  const ctx = createCtx();
  try {
    return await work(ctx);
  } finally {
    ctx.close();
  }
}

export function today(ctx: Ctx): string {
  return localDateAt(ctx.now(), ctx.timezone);
}

export function parseClock(ctx: Ctx, value: string): Date {
  if (/^\d{2}:\d{2}$/.test(value)) {
    return zonedToUtc(localDateAt(ctx.now(), ctx.timezone), value, ctx.timezone);
  }
  return parseWhen(value, ctx.now(), ctx.timezone);
}

export function resolveDate(ctx: Ctx, value: string | undefined): string {
  if (!value || value === "today") return today(ctx);
  if (value === "yesterday") {
    return localDateAt(new Date(ctx.now().getTime() - 86_400_000), ctx.timezone);
  }
  if (value === "tomorrow") {
    return localDateAt(new Date(ctx.now().getTime() + 86_400_000), ctx.timezone);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError(
      "invalid_date",
      `Expected YYYY-MM-DD, today, yesterday, or tomorrow. Got: ${value}`,
    );
  }
  return value;
}

export function output(value: unknown, options: CommonOptions, lines: string[] = []): void {
  if (options.json) {
    const payload = Array.isArray(value)
      ? { schema_version: 1, items: value }
      : { schema_version: 1, ...(value as Record<string, unknown>) };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  for (const line of lines) process.stdout.write(`${line}\n`);
  if (lines.length === 0 && value !== undefined && value !== null) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  }
}

export function mutate<T>(
  ctx: Ctx,
  command: string,
  opId: string | undefined,
  work: () => T,
): { value: T; operationId: string } {
  const result = withOperation(ctx, { id: opId, actor: ctx.config.actor, command }, work);
  return { value: result.value, operationId: result.id };
}

export function handleError(error: unknown): number {
  const payload = errorPayload(error);
  const json = process.argv.includes("--json");
  if (json) {
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stderr.write(`Error [${payload.error.code}]: ${payload.error.message}\n`);
    const details = payload.error.details as
      { conflicts?: Array<{ title: string; time: string }> } | undefined;
    for (const conflict of details?.conflicts ?? []) {
      process.stderr.write(`  conflict: ${conflict.title} (${conflict.time})\n`);
    }
  }
  return error instanceof AppError ? error.exitCode : 1;
}

let activeCommand: Command | undefined;

export function action(handler: () => Promise<void> | void): () => Promise<void> {
  return async function (this: Command) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    activeCommand = this;
    try {
      await handler();
    } catch (error) {
      process.exitCode = handleError(error);
    }
  };
}

export function currentArgs(): string[] {
  return activeCommand?.args ?? [];
}

export function currentOpts<T>(): T {
  return (activeCommand?.opts() ?? {}) as T;
}

export function booleanOption(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ["yes", "true", "1", "urgent", "on"].includes(value.toLowerCase());
}

export function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}
