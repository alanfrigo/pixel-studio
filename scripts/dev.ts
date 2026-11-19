/**
 * Ambiente de desenvolvimento (02 §módulos): aplica as migrações UMA vez,
 * confere o Python, garante o perfil simulado e inicia web + worker juntos,
 * exibindo o endereço local. Ctrl+C encerra os dois.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { loadConfig, loadDotEnv, REPO_ROOT } from "@/server/config";
import { Db } from "@/server/db/connection";
import { ensureSimulatedProfile } from "@/server/providers/registry";
import { pythonInfo } from "@/server/python/bridge";
import { systemClock } from "@/server/util";
import { runMigrations } from "./migrate";

loadDotEnv();
const PORT = process.env.PORT ?? "3000";
const config = loadConfig();

const migration = runMigrations();
console.log(`[dev] dados em ${config.paths.dataDir} · schema v${migration.version} · SQLite ${migration.sqlite}`);
if (migration.applied.length) console.log(`[dev] migrações aplicadas: ${migration.applied.join(", ")}`);

if (config.simulatedProvider) {
  const db = new Db(config.paths.database);
  ensureSimulatedProfile(db, systemClock);
  db.close();
  console.log("[dev] perfil de provedor simulado disponível (PIXEL_STUDIO_SIMULATED_PROVIDER=0 desliga)");
}

const python = await pythonInfo(config.python);
console.log(python.ok ? `[dev] Python ${python.python} · Pillow ${python.pillow}` : `[dev] AVISO: ${python.error}`);

const bin = (name: string) => path.join(REPO_ROOT, "node_modules", ".bin", name);
const children: ChildProcess[] = [];

function start(label: string, command: string, args: string[]) {
  const child = spawn(command, args, { cwd: REPO_ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (chunk: Buffer) =>
    chunk
      .toString()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `[${label}] ${l}`)
      .join("\n");
  child.stdout?.on("data", (c: Buffer) => console.log(prefix(c)));
  child.stderr?.on("data", (c: Buffer) => console.error(prefix(c)));
  child.on("exit", (code, signal) => console.log(`[${label}] encerrado (${signal ?? code})`));
  children.push(child);
  return child;
}

start("web", bin("next"), ["dev", "--hostname", "127.0.0.1", "--port", PORT]);
start("worker", bin("tsx"), ["watch", "--clear-screen=false", "src/worker/main.ts"]);
console.log(`[dev] Pixel Studio em http://127.0.0.1:${PORT}`);

const stopAll = () => {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
