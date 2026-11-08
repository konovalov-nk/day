import { pathToFileURL } from "node:url";
import { createCtx, type Ctx } from "./db.js";
import { startServer } from "./server.js";

export async function serveForever(ctx: Ctx): Promise<void> {
  const server = await startServer(ctx);
  process.stdout.write(`Day listening on ${ctx.config.baseUrl}\n`);
  process.stdout.write(`Dashboard: ${ctx.config.baseUrl}\n`);
  const shutdown = () => {
    server.close(() => {
      ctx.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => {
    /* The listening server keeps the process alive. */
  });
}

async function main(): Promise<void> {
  const ctx = createCtx();
  await serveForever(ctx);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
