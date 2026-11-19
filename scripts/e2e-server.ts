import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@/server/config";
import { Db } from "@/server/db/connection";
import { ensureSimulatedProfile } from "@/server/providers/registry";
import { pythonInfo } from "@/server/python/bridge";
import { systemClock } from "@/server/util";
import { runMigrations } from "./migrate";

const dataDir = mkdtempSync(join(tmpdir(), "pixel-studio-e2e-"));
const port = process.env.PORT ?? "14831";
process.env.PIXEL_STUDIO_DATA_DIR = dataDir;
process.env.PIXEL_STUDIO_SIMULATED_PROVIDER = "1";
process.env.PIXEL_STUDIO_MIN_FREE_BYTES = "0";

const stop = new AbortController();
process.once("SIGINT", () => stop.abort());
process.once("SIGTERM", () => stop.abort());
const stopping = once(stop.signal, "abort");
const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];

try {
  const config = loadConfig();
  const python = await pythonInfo(config.python);
  if (!python.ok) throw new Error(`Run npm run python:setup before E2E tests: ${JSON.stringify(python.error)}`);
  runMigrations();
  const db = new Db(config.paths.database);
  try {
    ensureSimulatedProfile(db, systemClock, { delayMs: 0, idempotent: true });
  } finally {
    db.close();
  }

  if (!stop.signal.aborted) {
    const commands = [
      ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", port],
      ["--import", "tsx", "src/worker/main.ts"],
    ];
    for (const args of commands) {
      const child = spawn(process.execPath, args, { stdio: "inherit" });
      children.push({ child, closed: once(child, "close") });
    }
    await Promise.race([stopping, ...children.map(({ closed }) => closed)]);
    if (!stop.signal.aborted) throw new Error("The E2E web server or worker stopped unexpectedly");
  }
} finally {
  for (const { child } of children) child.kill("SIGTERM");
  await Promise.allSettled(children.map(({ closed }) => closed));
  rmSync(dataDir, { recursive: true, force: true });
}
