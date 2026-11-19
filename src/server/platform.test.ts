import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClareira } from "@/fixtures/clareira";
import { Db } from "./db/connection";
import { assertMigrated, COMMENT_ONLY_REVISIONS, executableSql, loadMigrations, migrate, migrationStatus } from "./db/migrate";
import { inspectAudio, inspectFont, sniff } from "./media/inspect";
import { pythonInfo, runPython } from "./python/bridge";
import { BlobStore } from "./storage/blob-store";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-platform-"));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const fixture = buildClareira();
const fixtureFile = (p: string) => fixture.packageFiles.find((f) => f.path === p)!.bytes;

describe("migrações", () => {
  it("aplicam uma única vez e o banco confere a versão", () => {
    const db = new Db(path.join(tmp(), "a.sqlite"));
    expect(() => assertMigrated(db)).toThrow(/db:migrate/);
    expect(migrate(db).length).toBe(loadMigrations().length);
    expect(migrate(db)).toEqual([]);
    expect(() => assertMigrated(db)).not.toThrow();
    db.close();
  });

  it("detectam migração editada depois de aplicada", () => {
    const dir = tmp();
    const migrations = path.join(dir, "migrations");
    const db = new Db(path.join(dir, "a.sqlite"));
    rmSync(migrations, { recursive: true, force: true });
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "0001_x.sql"), "CREATE TABLE x (a INTEGER) STRICT;");
    migrate(db, loadMigrations(migrations));
    writeFileSync(path.join(migrations, "0001_x.sql"), "CREATE TABLE x (a TEXT) STRICT;");
    expect(() => migrationStatus(db, loadMigrations(migrations))).toThrow(/alterada depois de aplicada/);
    db.close();
  });

  it("revisão só de comentário: SQL executável idêntico, checksum anterior aceito e atualizado", () => {
    const migrations = loadMigrations();
    const m4 = migrations[3]!;
    // Hash do SQL sem comentários da versão aplicada em bancos existentes (antes da edição do comentário).
    expect(createHash("sha256").update(executableSql(m4.sql)).digest("hex")).toBe("7abe3fbc1f0543b395de45dc25e8e0ba3b1064e16f2baca54ce4610f2201bd45");
    expect(COMMENT_ONLY_REVISIONS[4]).not.toContain(m4.checksum);
    const db = new Db(path.join(tmp(), "a.sqlite"));
    migrate(db);
    db.run("UPDATE schema_migrations SET checksum = :old WHERE version = 4", { old: COMMENT_ONLY_REVISIONS[4]![0]! });
    expect(() => assertMigrated(db)).not.toThrow();
    expect(migrate(db)).toEqual([]);
    expect(db.get<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE version = 4")!.checksum).toBe(m4.checksum);
    db.close();
  });

  it("toda conexão liga WAL, chaves estrangeiras e espera por escrita ocupada", () => {
    const db = new Db(path.join(tmp(), "a.sqlite"), { busyTimeoutMs: 1234 });
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    expect(db.get<{ timeout: number }>("PRAGMA busy_timeout")?.timeout).toBe(1234);
    db.close();
  });

  it("segunda conexão espera e recebe SQLITE_BUSY se a escrita demorar demais", () => {
    const file = path.join(tmp(), "a.sqlite");
    const a = new Db(file);
    migrate(a);
    const b = new Db(file, { busyTimeoutMs: 50 });
    a.exec("BEGIN IMMEDIATE");
    expect(() => b.transaction(() => b.run("DELETE FROM projects"))).toThrow(/locked|busy/i);
    a.exec("ROLLBACK");
    expect(() => b.transaction(() => b.run("DELETE FROM projects"))).not.toThrow();
    a.close();
    b.close();
  });
});

describe("armazenamento por conteúdo", () => {
  it("deduplica, confere o existente e substitui arquivo corrompido", async () => {
    const root = tmp();
    const store = new BlobStore(path.join(root, "blobs"), path.join(root, "tmp"));
    const bytes = new TextEncoder().encode("pixel");
    const first = await store.putBytes(bytes);
    expect(first.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(first.created).toBe(true);
    expect((await store.putBytes(bytes)).created).toBe(false);

    writeFileSync(store.pathFor(first.sha256), "corrompido");
    expect(await store.verify(first.sha256)).toBe(false);
    expect((await store.putBytes(bytes)).created).toBe(true);
    expect(await store.verify(first.sha256)).toBe(true);
    expect(readdirSync(path.join(root, "tmp"))).toEqual([]);
  });

  it("recusa gravar quando o espaço livre fica abaixo da reserva", async () => {
    const root = tmp();
    const store = new BlobStore(path.join(root, "blobs"), path.join(root, "tmp"), Number.MAX_SAFE_INTEGER);
    await expect(store.putBytes(new Uint8Array([1]))).rejects.toMatchObject({ code: "storage_failed" });
  });
});

describe("inspeção por modalidade", () => {
  it("identifica pelos bytes, não pelo nome", () => {
    expect(sniff(fixtureFile("textures/spark.png"))).toMatchObject({ modality: "raster", mime: "image/png" });
    expect(sniff(fixtureFile("audio/hit.wav"))).toMatchObject({ modality: "audio", mime: "audio/wav" });
    expect(sniff(new TextEncoder().encode("<svg/>"))).toBeNull();
  });

  it("lê áudio sem exigir dimensões raster", () => {
    expect(inspectAudio(fixtureFile("audio/hit.wav"), "wav")).toEqual({
      durationMs: 100,
      sampleRate: 22_050,
      channels: 1,
      frameCount: 2205,
      codec: "pcm_s16le",
    });
  });

  it("lê glyphs de uma fonte sfnt mínima", () => {
    // Cabeçalho sfnt com tabelas head (54 bytes) e maxp (6 bytes, numGlyphs = 80).
    const font = new Uint8Array(12 + 32 + 54 + 6);
    const v = new DataView(font.buffer);
    v.setUint32(0, 0x00010000);
    v.setUint16(4, 2);
    const table = (i: number, tag: string, offset: number, length: number) => {
      [...tag].forEach((c, k) => (font[12 + i * 16 + k] = c.charCodeAt(0)));
      v.setUint32(12 + i * 16 + 8, offset);
      v.setUint32(12 + i * 16 + 12, length);
    };
    table(0, "head", 44, 54);
    table(1, "maxp", 98, 6);
    v.setUint16(44 + 18, 1000);
    v.setUint16(98 + 4, 80);
    expect(sniff(font)?.modality).toBe("font");
    expect(inspectFont(font)).toEqual({ glyphCount: 80, unitsPerEm: 1000, tables: ["head", "maxp"] });
  });
});

describe.skipIf(!existsSync(PYTHON))("ponte Python", () => {
  it("o interpretador fala o protocolo v1", async () => {
    expect(await pythonInfo(PYTHON)).toMatchObject({ ok: true, protocolVersion: 1 });
    expect(await pythonInfo("/nao/existe")).toMatchObject({ ok: false });
  });

  it("normaliza o PNG da fixture e Node confere hash e dimensões da saída", async () => {
    const workDir = tmp();
    const bytes = fixtureFile("sprites/warrior-attack-s.png");
    await mkdir(path.join(workDir, "in"));
    await writeFile(path.join(workDir, "in", "source"), bytes);
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: "job_1",
        attemptId: "att_1",
        operation: "ingest_inspect",
        inputs: [{ ordinal: 0, role: "source", sha256: createHash("sha256").update(bytes).digest("hex"), relPath: "in/source" }],
        recipe: { version: 1, limits: { maxBytes: 1e7, maxWidth: 4096, maxHeight: 4096, maxPixels: 1e7, maxFrames: 1 } },
      },
      { python: PYTHON, workDir },
    );
    expect(result.status).toBe("ok");
    if (result.status === "error") return;
    expect(result.outputs[0]).toMatchObject({ role: "normalized", width: 256, height: 64, mime: "image/png" });
    expect(result.outputs[0]!.absolutePath.startsWith(workDir)).toBe(true);
  });

  it("erro estruturado do processador chega como resultado, não como exceção", async () => {
    const workDir = tmp();
    await mkdir(path.join(workDir, "in"));
    await writeFile(path.join(workDir, "in", "source"), "não é imagem");
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: "job_1",
        attemptId: "att_1",
        operation: "ingest_inspect",
        inputs: [{ ordinal: 0, role: "source", sha256: createHash("sha256").update("não é imagem").digest("hex"), relPath: "in/source" }],
        recipe: { version: 1, limits: { maxBytes: 1e7, maxWidth: 64, maxHeight: 64, maxPixels: 4096, maxFrames: 1 } },
      },
      { python: PYTHON, workDir },
    );
    expect(result).toMatchObject({ status: "error", code: "decode_failed" });
  });

  it("interpretador ausente vira falha de domínio legível", async () => {
    const workDir = tmp();
    await expect(
      runPython(
        {
          protocolVersion: 1,
          jobId: "j",
          attemptId: "a",
          operation: "ingest_inspect",
          inputs: [],
          recipe: { version: 1, limits: { maxBytes: 1, maxWidth: 1, maxHeight: 1, maxPixels: 1, maxFrames: 1 } },
        },
        { python: "/nao/existe/python", workDir },
      ),
    ).rejects.toMatchObject({ code: "internal", message: expect.stringContaining("Não foi possível iniciar o Python") });
  });
});
