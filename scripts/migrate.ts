/** Aplica as migrações pendentes no banco de `PIXEL_STUDIO_DATA_DIR` (uma única vez). */
import { mkdirSync } from "node:fs";
import { loadConfig } from "@/server/config";
import { Db } from "@/server/db/connection";
import { migrate, migrationStatus } from "@/server/db/migrate";

export function runMigrations(): { applied: string[]; version: number; sqlite: string } {
  const config = loadConfig();
  mkdirSync(config.paths.dataDir, { recursive: true });
  const db = new Db(config.paths.database);
  try {
    const applied = migrate(db).map((m) => `${String(m.version).padStart(4, "0")}_${m.name}`);
    return { applied, version: migrationStatus(db).current, sqlite: db.sqliteVersion() };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const result = runMigrations();
  console.log(
    result.applied.length
      ? `Migrações aplicadas: ${result.applied.join(", ")} (schema v${result.version}, SQLite ${result.sqlite})`
      : `Banco já atualizado (schema v${result.version}, SQLite ${result.sqlite})`,
  );
}
