import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, type StudioConfig } from "./config";
import { Db } from "./db/connection";
import { assertMigrated } from "./db/migrate";
import { JobQueue, type QueueOptions } from "./jobs/queue";
import { ProviderRegistry } from "./providers/registry";
import { BlobStore } from "./storage/blob-store";
import { type Clock, systemClock } from "./util";

/**
 * Serviços compartilhados por web e worker. Ambos abrem o mesmo diretório de
 * dados; nenhum dos dois aplica migrações (isso é feito uma vez pelo comando
 * de desenvolvimento ou `npm run db:migrate`).
 */
export interface Studio {
  config: StudioConfig;
  db: Db;
  blobs: BlobStore;
  queue: JobQueue;
  clock: Clock;
  providers: ProviderRegistry;
}

export function openStudio(opts: { config?: StudioConfig; clock?: Clock; queue?: Partial<QueueOptions>; skipMigrationCheck?: boolean } = {}): Studio {
  const config = opts.config ?? loadConfig();
  const clock = opts.clock ?? systemClock;
  for (const dir of [config.paths.dataDir, config.paths.blobs, config.paths.staging, config.paths.exports, config.paths.backups]) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Db(config.paths.database);
  if (!opts.skipMigrationCheck) {
    try {
      assertMigrated(db);
    } catch (err) {
      db.close();
      throw err;
    }
  }
  return {
    config,
    db,
    clock,
    blobs: new BlobStore(config.paths.blobs, path.join(config.paths.staging, "tmp"), config.minFreeBytes),
    queue: new JobQueue(db, clock, { leaseMs: config.leaseMs, ...opts.queue }),
    providers: new ProviderRegistry(db, config),
  };
}

const GLOBAL_KEY = Symbol.for("pixel-studio.web");

/** Instância do processo web, preservada entre recargas do Next em desenvolvimento. */
export function webStudio(): Studio {
  const g = globalThis as unknown as Record<symbol, Studio | undefined>;
  let studio = g[GLOBAL_KEY];
  if (!studio) {
    studio = openStudio();
    g[GLOBAL_KEY] = studio;
  }
  return studio;
}
