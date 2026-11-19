import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Configuração local (02 §persistência). O catálogo fica fora do build em
 * `PIXEL_STUDIO_DATA_DIR`; web e worker compartilham o mesmo diretório.
 */

export interface StudioPaths {
  dataDir: string;
  database: string;
  blobs: string;
  staging: string;
  exports: string;
  backups: string;
  dev: string;
}

export interface StudioConfig {
  paths: StudioPaths;
  /** Interpretador Python com `pixel_pipeline` instalado. */
  python: string;
  /** Reserva mínima de disco antes de gravar staging/blobs. */
  minFreeBytes: number;
  /** Limite de bytes de um upload. */
  maxUploadBytes: number;
  /** Habilita o provedor simulado (desenvolvimento e testes). */
  simulatedProvider: boolean;
  /** Limites de ingestão raster aplicados antes de expandir pixels (05 §ingestão). */
  rasterLimits: { maxBytes: number; maxWidth: number; maxHeight: number; maxPixels: number; maxFrames: number };
  /** Tempo máximo de um processamento Python. */
  pythonTimeoutMs: number;
  /** Prazo da reserva de um job; o worker renova a cada terço. */
  leaseMs: number;
}

/** Raiz do repositório. Next empacota o servidor, então usamos o diretório de trabalho (scripts npm rodam na raiz). */
export const REPO_ROOT = path.resolve(/*turbopackIgnore: true*/ process.env.PIXEL_STUDIO_ROOT ?? process.cwd());

export function resolvePaths(dataDir: string): StudioPaths {
  const root = path.resolve(dataDir);
  return {
    dataDir: root,
    database: path.join(root, "studio.sqlite"),
    blobs: path.join(root, "blobs"),
    staging: path.join(root, "staging"),
    exports: path.join(root, "exports"),
    backups: path.join(root, "backups"),
    dev: path.join(root, "dev"),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): StudioConfig {
  const dataDir = env.PIXEL_STUDIO_DATA_DIR ?? path.join(REPO_ROOT, "data");
  return {
    paths: resolvePaths(dataDir),
    python: env.PIXEL_STUDIO_PYTHON ?? path.join(REPO_ROOT, "python", ".venv", "bin", "python"),
    minFreeBytes: Number(env.PIXEL_STUDIO_MIN_FREE_BYTES ?? 256 * 1024 * 1024),
    maxUploadBytes: Number(env.PIXEL_STUDIO_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024),
    simulatedProvider: (env.PIXEL_STUDIO_SIMULATED_PROVIDER ?? (env.NODE_ENV === "production" ? "0" : "1")) === "1",
    rasterLimits: { maxBytes: 64 * 1024 * 1024, maxWidth: 8192, maxHeight: 8192, maxPixels: 4096 * 4096, maxFrames: 256 },
    pythonTimeoutMs: Number(env.PIXEL_STUDIO_PYTHON_TIMEOUT_MS ?? 60_000),
    leaseMs: Number(env.PIXEL_STUDIO_LEASE_MS ?? 30_000),
  };
}

/**
 * Carrega `.env` da raiz nos processos fora do Next (worker e scripts); o Next
 * já carrega o arquivo no processo web. Variáveis já definidas prevalecem.
 */
export function loadDotEnv(root: string = REPO_ROOT): void {
  const file = path.join(root, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}
