import { tx } from "@/i18n/locales";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import { DomainFailure } from "../errors";

/**
 * Blobs endereçados por conteúdo (02 §persistência): `blobs/sha256/ab/<hash>`.
 * Escrita: temporário no mesmo volume → fsync → hash → rename atômico. Em
 * corrida pelo mesmo hash, o arquivo existente é conferido; um arquivo
 * corrompido é substituído. O registro no SQLite é feito por quem publica.
 */

export interface StoredBlob {
  sha256: string;
  bytes: number;
  path: string;
  /** `false` quando o conteúdo já existia (deduplicado). */
  created: boolean;
}

export class BlobStore {
  constructor(
    readonly root: string,
    private readonly tmpDir: string,
    private readonly minFreeBytes = 0,
  ) {}

  pathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Hash inválido: ${sha256}`);
    return path.join(this.root, "sha256", sha256.slice(0, 2), sha256);
  }

  async ensureSpace(expectedBytes: number): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const fs = await statfs(this.root);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < expectedBytes + this.minFreeBytes) {
      throw new DomainFailure("storage_failed", tx("Espaço em disco insuficiente para gravar o arquivo", "Not enough disk space to write the file"), {
        freeBytes: free,
        neededBytes: expectedBytes + this.minFreeBytes,
      });
    }
  }

  async putBytes(bytes: Uint8Array): Promise<StoredBlob> {
    await this.ensureSpace(bytes.length);
    await mkdir(this.tmpDir, { recursive: true });
    const tmp = path.join(this.tmpDir, `blob-${randomUUID()}`);
    try {
      const fh = await open(tmp, "wx");
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return await this.promote(tmp, sha256, bytes.length);
    } catch (err) {
      await rm(tmp, { force: true });
      if (err instanceof DomainFailure) throw err;
      throw new DomainFailure("storage_failed", tx("Falha ao gravar arquivo no armazenamento local", "Failed to write the file to local storage"), { cause: String(err) });
    }
  }

  /** Promove um arquivo já escrito (ex.: saída do Python em staging) depois de recalcular o hash. */
  async putFile(file: string): Promise<StoredBlob> {
    // Copia (não move): a saída em staging continua disponível para reprocessar a tentativa.
    return this.putBytes(new Uint8Array(await readFile(file)));
  }

  private async promote(tmp: string, sha256: string, size: number): Promise<StoredBlob> {
    const target = this.pathFor(sha256);
    await mkdir(path.dirname(target), { recursive: true });
    const existing = await stat(target).catch(() => null);
    if (existing && existing.size === size && (await hashFile(target)) === sha256) {
      await rm(tmp, { force: true });
      return { sha256, bytes: size, path: target, created: false };
    }
    await rename(tmp, target);
    await syncDir(path.dirname(target));
    return { sha256, bytes: size, path: target, created: true };
  }

  async read(sha256: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(sha256)));
  }

  async exists(sha256: string): Promise<boolean> {
    return (await stat(this.pathFor(sha256)).catch(() => null)) !== null;
  }

  async verify(sha256: string): Promise<boolean> {
    const file = this.pathFor(sha256);
    return (await stat(file).catch(() => null)) !== null && (await hashFile(file)) === sha256;
  }

  stream(sha256: string) {
    return createReadStream(this.pathFor(sha256));
  }

  async remove(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true });
  }
}

export async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function syncDir(dir: string) {
  try {
    const fh = await open(dir, "r");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Nem todo sistema de arquivos permite fsync de diretório; o rename continua atômico.
  }
}
