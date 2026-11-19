/**
 * Processo worker (02 §módulos): executa a fila persistida no SQLite, chama
 * provedores e o processador Python. Independente do servidor web; parar e
 * reiniciar retoma pelo banco.
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { WorkerDeps } from "@/server/jobs/context";
import { JobRunner, reconcileStaging } from "@/server/jobs/runner";
import { loadDotEnv } from "@/server/config";
import { pythonInfo } from "@/server/python/bridge";
import { openStudio } from "@/server/studio";
import { iso } from "@/server/util";

function log(message: string, extra?: Record<string, unknown>) {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
  console.log(`${new Date().toISOString()} ${message}${suffix}`);
}

loadDotEnv();
const studio = openStudio();
const workerId = `worker-${os.hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
const deps: WorkerDeps = { ...studio, log };
const runner = new JobRunner(deps, { workerId, heartbeatMs: Math.floor(studio.queue.options.leaseMs / 3) });

const python = await pythonInfo(studio.config.python);
if (!python.ok) log("Aviso: processador Python indisponível; ingestão raster vai falhar", { error: python.error });

studio.db.run("DELETE FROM worker_heartbeats WHERE last_seen_at < :cutoff", { cutoff: iso(new Date(Date.now() - 86_400_000)) });
runner.registerHeartbeat(process.pid);
const beat = setInterval(() => runner.beat(), 5_000);
const removed = await reconcileStaging(deps);
log("Worker pronto", { workerId, data: studio.config.paths.dataDir, stagingRemoved: removed, python: python.ok ? python.pillow : "indisponível" });

const stop = new AbortController();
let signals = 0;
const shutdown = (signal: string) => {
  signals++;
  if (signals > 1) {
    log("Encerrando sem esperar o job atual; a reserva vence e outro worker retoma");
    process.exit(1);
  }
  log(`${signal} recebido; termina o job atual e para`);
  stop.abort();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await runner.loop(stop.signal);
clearInterval(beat);
studio.db.run("DELETE FROM worker_heartbeats WHERE worker_id = :w", { w: workerId });
studio.db.close();
log("Worker encerrado");
