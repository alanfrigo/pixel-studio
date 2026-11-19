import path from "node:path";
import type { StudioConfig } from "../config";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { type Clock, iso } from "../util";
import { OpenAIImagesAdapter, OpenRouterAdapter } from "./adapters";
import { CodexCliAdapter } from "./codex-cli";
import { FileSimulatedStore, SimulatedProvider } from "./simulated";
import type { ProviderAdapter } from "./types";

/**
 * Perfis de provedor (02a `provider_profiles`): configuração no servidor com
 * REFERÊNCIA ao segredo (nome da variável de ambiente), nunca o segredo.
 */

export interface ProviderProfileRow {
  id: string;
  name: string;
  transport: string;
  base_url: string | null;
  secret_ref: string | null;
  model: string | null;
  concurrency: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface ProviderProfileView {
  id: string;
  name: string;
  transport: string;
  baseUrl: string | null;
  secretRef: string | null;
  /** Indica se a variável do segredo está definida, sem expor o valor. */
  secretConfigured: boolean;
  model: string | null;
  simulated: boolean;
  config: Record<string, unknown>;
}

export const SIMULATED_PROFILE_ID = "simulated";

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter_images: "https://openrouter.ai/api/v1",
};

export function profileView(row: ProviderProfileRow): ProviderProfileView {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    baseUrl: row.base_url,
    secretRef: row.secret_ref,
    secretConfigured: row.secret_ref ? Boolean(process.env[row.secret_ref]) : false,
    model: row.model,
    simulated: row.transport === "simulated",
    config: JSON.parse(row.config_json),
  };
}

export function listProfiles(db: Db): ProviderProfileView[] {
  return db.all<ProviderProfileRow>("SELECT * FROM provider_profiles ORDER BY name").map(profileView);
}

export function getProfileRow(db: Db, id: string): ProviderProfileRow {
  const row = db.get<ProviderProfileRow>("SELECT * FROM provider_profiles WHERE id = :id", { id });
  if (!row) throw new DomainFailure("not_found", `Perfil de provedor ${id} não encontrado`);
  return row;
}

export function ensureSimulatedProfile(db: Db, clock: Clock, config: { delayMs: number; idempotent: boolean } = { delayMs: 4000, idempotent: false }) {
  const now = iso(clock.now());
  db.run(
    `INSERT OR IGNORE INTO provider_profiles (id, name, transport, concurrency, config_json, created_at, updated_at)
     VALUES (:id, 'Simulado (desenvolvimento)', 'simulated', 1, :config, :now, :now)`,
    { id: SIMULATED_PROFILE_ID, config: JSON.stringify(config), now },
  );
}

export class ProviderRegistry {
  constructor(
    private readonly db: Db,
    private readonly config: StudioConfig,
    /** Adaptadores injetados (testes) por ID de perfil. */
    private readonly overrides = new Map<string, ProviderAdapter>(),
  ) {}

  adapterFor(profileId: string): ProviderAdapter {
    const override = this.overrides.get(profileId);
    if (override) return override;
    const row = getProfileRow(this.db, profileId);
    if (row.transport === "simulated") {
      if (!this.config.simulatedProvider) {
        throw new DomainFailure("capability_missing", "O provedor simulado está desabilitado nesta instalação");
      }
      const cfg = JSON.parse(row.config_json) as { delayMs?: number; idempotent?: boolean };
      return new SimulatedProvider(new FileSimulatedStore(path.join(this.config.paths.dev, "simulated-provider.json")), {
        delayMs: cfg.delayMs ?? 4000,
        idempotent: cfg.idempotent ?? false,
      });
    }
    const profile = { id: row.id, baseUrl: row.base_url ?? DEFAULT_BASE_URLS[row.transport] ?? "", secretRef: row.secret_ref, model: row.model };
    const config = JSON.parse(row.config_json) as unknown;
    switch (row.transport) {
      case "openai_images":
        return new OpenAIImagesAdapter(profile, config);
      case "openrouter_images":
        return new OpenRouterAdapter(profile, config);
      case "codex_cli":
        return new CodexCliAdapter(profile, config);
      default:
        throw new DomainFailure("capability_missing", `Transporte desconhecido: ${row.transport}`, { profileId });
    }
  }

  /** A credencial está configurada no ambiente do servidor? (checagem antes de planejar/cobrar) */
  assertReady(profileId: string): void {
    if (this.overrides.has(profileId)) return;
    const row = getProfileRow(this.db, profileId);
    if (row.transport !== "simulated" && row.secret_ref && !process.env[row.secret_ref]) {
      throw new DomainFailure("capability_missing", `Credencial ausente: defina a variável de ambiente ${row.secret_ref} no servidor`, { profileId });
    }
    if (row.transport === "codex_cli") CodexCliAdapter.assertInstalled(JSON.parse(row.config_json) as unknown, profileId);
  }
}
