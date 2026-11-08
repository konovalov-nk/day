import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCtx } from "../src/db.js";
import { setup } from "../src/service.js";
import { startServer } from "../src/server.js";

const directory = mkdtempSync(resolve(tmpdir(), "day-e2e-"));
process.env.DAY_DATA_DIR = directory;
process.env.DAY_DB_PATH = resolve(directory, "day.sqlite");
process.env.DAY_NOW = process.env.DAY_NOW ?? "2026-09-25T09:30:00+02:00";
process.env.DAY_PORT = process.env.DAY_PORT ?? "3139";
process.env.DAY_PASSWORD = process.env.DAY_PASSWORD ?? "test";
process.env.DAY_READ_TOKEN = process.env.DAY_READ_TOKEN ?? "test-token";

const ctx = createCtx();
setup(ctx, { demo: true });
const server = await startServer(ctx, { port: Number(process.env.DAY_PORT), host: "127.0.0.1" });
process.stdout.write(`e2e server ready on http://127.0.0.1:${process.env.DAY_PORT}\n`);

const shutdown = () => {
  server.close(() => {
    ctx.close();
    rmSync(directory, { recursive: true, force: true });
    process.exit(0);
  });
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
