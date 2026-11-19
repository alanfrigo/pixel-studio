import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config";
import type { Db } from "./connection";

/**
 * Migrações SQL numeradas (`NNNN_nome.sql`), aplicadas uma única vez e em
 * ordem, cada uma na própria transação. O checksum impede editar uma migração
 * já aplicada: mudanças de schema exigem um arquivo novo.
 */

export const MIGRATIONS_DIR = path.join(REPO_ROOT, "src", "server", "db", "migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

/**
 * Revisões que só mudaram comentários (o SQL executado é idêntico, conferido
 * em teste pelo SQL sem comentários): o checksum anterior continua aceito e é
 * atualizado pela próxima `migrate`.
 */
export const COMMENT_ONLY_REVISIONS: Readonly<Record<number, readonly string[]>> = {
  4: ["ca07391a122c510716c0eb98eb9fc089e08c87f324df52b36adc71e4a3fc9294"],
};

/** SQL sem comentários de linha nem linhas vazias: o que de fato executa. */
export function executableSql(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, "").trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n");
}

export function loadMigrations(dir = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(/*turbopackIgnore: true*/ dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(/*turbopackIgnore: true*/ path.join(dir, file), "utf8");
      return {
        version: Number(file.slice(0, 4)),
        name: file.slice(5, -4),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    });
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`Migrações devem ser contíguas: esperado ${i + 1}, encontrado ${m.version}`);
  });
  return migrations;
}

function ensureTable(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
}

interface Applied {
  version: number;
  name: string;
  checksum: string;
}

export interface MigrationStatus {
  current: number;
  latest: number;
  pending: Migration[];
}

export function migrationStatus(db: Db, migrations = loadMigrations()): MigrationStatus {
  ensureTable(db);
  const applied = db.all<Applied>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  for (const a of applied) {
    const m = migrations[a.version - 1];
    if (!m) throw new Error(`Banco tem a migração ${a.version} (${a.name}), desconhecida por este código`);
    if (m.checksum !== a.checksum && !COMMENT_ONLY_REVISIONS[a.version]?.includes(a.checksum)) {
      throw new Error(`Migração ${a.version} (${a.name}) foi alterada depois de aplicada`);
    }
  }
  return {
    current: applied.length,
    latest: migrations.length,
    pending: migrations.slice(applied.length),
  };
}

export function migrate(db: Db, migrations = loadMigrations(), now = () => new Date().toISOString()): Migration[] {
  const { pending } = migrationStatus(db, migrations);
  // Revisão só de comentário já aceita acima: grava o checksum atual.
  for (const [version, previous] of Object.entries(COMMENT_ONLY_REVISIONS)) {
    const m = migrations[Number(version) - 1];
    if (!m) continue;
    for (const checksum of previous) {
      db.run("UPDATE schema_migrations SET checksum = :current WHERE version = :version AND checksum = :checksum", { current: m.checksum, version: Number(version), checksum });
    }
  }
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (:version, :name, :checksum, :at)", {
        version: m.version,
        name: m.name,
        checksum: m.checksum,
        at: now(),
      });
    });
  }
  const fk = db.all("PRAGMA foreign_key_check");
  if (fk.length > 0) throw new Error(`Violação de chave estrangeira após migrar: ${JSON.stringify(fk[0])}`);
  return pending;
}

/** Web e worker não migram: só conferem que o banco está na versão do código. */
export function assertMigrated(db: Db): void {
  const status = migrationStatus(db);
  if (status.pending.length > 0) {
    throw new Error(`Banco na versão ${status.current}, código espera ${status.latest}. Rode: npm run db:migrate`);
  }
}
