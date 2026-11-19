import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";

/**
 * Conexão SQLite (02 §persistência, item 4): `foreign_keys`, espera por escrita
 * ocupada e WAL em toda conexão. Transações são síncronas e curtas — rede e
 * processamento ficam fora delas por construção (a API não aceita `await`).
 */

/** Primeira versão com a correção do WAL-reset documentada pelo SQLite. */
export const MIN_SQLITE_VERSION = "3.51.3";

export type Row = Record<string, SQLInputValue>;
export type Params = Record<string, SQLInputValue>;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export class Db {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(file: string, opts: { busyTimeoutMs?: number } = {}) {
    this.raw = new DatabaseSync(file, { timeout: opts.busyTimeoutMs ?? 5000, enableForeignKeyConstraints: true });
    this.raw.exec("PRAGMA journal_mode = WAL");
    this.raw.exec("PRAGMA synchronous = NORMAL");
    this.raw.exec("PRAGMA foreign_keys = ON");
    const version = this.sqliteVersion();
    if (compareVersions(version, MIN_SQLITE_VERSION) < 0) {
      this.raw.close();
      throw new Error(`SQLite ${version} não tem a correção de WAL; é preciso ≥ ${MIN_SQLITE_VERSION}`);
    }
  }

  sqliteVersion(): string {
    return (this.raw.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.stmt(sql).get(params) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.stmt(sql).all(params) as T[];
  }

  run(sql: string, params: Params = {}): { changes: number } {
    const r = this.stmt(sql).run(params);
    return { changes: Number(r.changes) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /**
   * Executa `fn` numa transação. `immediate` reserva a escrita logo no início
   * (reserva de jobs, publicação). Transações aninhadas reutilizam a externa.
   */
  transaction<T>(fn: () => T, mode: "deferred" | "immediate" = "immediate"): T {
    if (this.raw.isTransaction) return fn();
    this.raw.exec(mode === "immediate" ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error("Transação não pode ser assíncrona");
      this.raw.exec("COMMIT");
      return result;
    } catch (err) {
      if (this.raw.isTransaction) this.raw.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.statements.clear();
    if (this.raw.isOpen) this.raw.close();
  }
}
