import { type LocalizedText, type TextValue, tx } from "@/i18n/locales";
import { z } from "zod";
import { type Capability, Id, PLAN_OPERATIONS, type PlanOperation } from "@/contracts";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { type Clock, iso } from "../util";
import { OpenAIImagesAdapter, OpenRouterAdapter } from "./adapters";
import { CodexCliAdapter } from "./codex-cli";
import { checkBaseUrl, failOnStatus, providerFetch, resolveSecret } from "./http";
import { DEFAULT_BASE_URLS, getProfileRow, profileView, type ProviderProfileView, type ProviderRegistry, SIMULATED_PROFILE_ID } from "./registry";
import { type ProviderAdapter, ProviderError } from "./types";

/**
 * Cadastro de perfis pelo operador local (02 §configuração): URL base,
 * protocolo e NOME da variável com o segredo. Ao salvar, grava a matriz de
 * capacidades declaradas por operação com a data do contrato consultado.
 */

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Use o nome de uma variável de ambiente, ex.: OPENROUTER_API_KEY");
const ProfileId = Id.refine((id) => id !== SIMULATED_PROFILE_ID, "ID reservado ao provedor simulado");
const common = { id: ProfileId, name: z.string().trim().min(1).max(120), config: z.record(z.string(), z.unknown()).default({}) };
const Model = z.string().trim().min(1).max(200);

export const ProfileInput = z.discriminatedUnion("transport", [
  z.strictObject({ ...common, secretRef: EnvName, transport: z.literal("openai_images"), baseUrl: z.string().min(1), model: Model }),
  z.strictObject({ ...common, secretRef: EnvName, transport: z.literal("openrouter_images"), baseUrl: z.string().min(1).optional(), model: Model }),
  // Codex CLI local: sem URL nem segredo (usa o login do `codex`); o modelo, opcional, conduz o turno.
  z.strictObject({ ...common, transport: z.literal("codex_cli"), model: Model.optional() }),
]);
export type ProfileInput = z.infer<typeof ProfileInput>;

/** Data/fonte dos contratos usados para declarar capacidades. */
export const CONTRACT_SNAPSHOTS: Record<string, LocalizedText> = {
  openai_images: tx("OpenAI Images API (referência oficial consultada em 2026-11-18)", "OpenAI Images API (official reference checked on 2026-11-18)"),
  openrouter_images: tx("OpenRouter Image API (guia e catálogo consultados em 2026-11-18)", "OpenRouter Image API (guide and catalog checked on 2026-11-18)"),
  codex_cli: tx("Codex CLI 0.169 · ferramenta de imagem embutida pela skill imagegen (ensaiada em 2026-11-19)", "Codex CLI 0.169 · built-in image tool via the imagegen skill (tested on 2026-11-19)"),
};

/** A coluna guarda o texto em português (como sempre); a API devolve os dois idiomas quando reconhece o texto. */
function snapshotText(stored: string | null): TextValue | null {
  if (stored === null) return null;
  return Object.values(CONTRACT_SNAPSHOTS).find((t) => t["pt-BR"] === stored) ?? stored;
}

function buildAdapter(input: ProfileInput): ProviderAdapter {
  const profile = {
    id: input.id,
    baseUrl: "baseUrl" in input ? (input.baseUrl ?? DEFAULT_BASE_URLS[input.transport]!) : "",
    secretRef: "secretRef" in input ? input.secretRef : null,
    model: input.model ?? null,
  };
  try {
    switch (input.transport) {
      case "openai_images":
        return new OpenAIImagesAdapter(profile, input.config);
      case "openrouter_images":
        return new OpenRouterAdapter(profile, input.config);
      case "codex_cli":
        return new CodexCliAdapter(profile, input.config);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new DomainFailure("validation_failed", tx("Configuração inválida para o transporte", "Invalid configuration for this transport"), {
        issues: err.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }
    throw err;
  }
}

export function saveProfile(db: Db, clock: Clock, input: ProfileInput): ProviderProfileView {
  if ("baseUrl" in input && input.baseUrl) checkBaseUrl(input.baseUrl);
  const adapter = buildAdapter(input); // valida config e modelo antes de gravar
  const now = iso(clock.now());
  return db.transaction(() => {
    db.run(
      `INSERT INTO provider_profiles (id, name, transport, base_url, secret_ref, model, concurrency, config_json, created_at, updated_at)
       VALUES (:id, :name, :transport, :base, :secret, :model, 1, :config, :now, :now)
       ON CONFLICT (id) DO UPDATE SET name = :name, transport = :transport, base_url = :base, secret_ref = :secret, model = :model,
         config_json = :config, updated_at = :now`,
      {
        id: input.id,
        name: input.name,
        transport: input.transport,
        base: "baseUrl" in input ? (input.baseUrl ?? null) : null,
        secret: "secretRef" in input ? input.secretRef : null,
        model: input.model ?? null,
        config: JSON.stringify(input.config),
        now,
      },
    );
    // Mudança de endpoint invalida a qualificação anterior: regrava como declarada.
    db.run("DELETE FROM model_capabilities WHERE provider_profile_id = :id", { id: input.id });
    for (const operation of PLAN_OPERATIONS) {
      for (const capability of adapter.capabilities(operation)) {
        db.run(
          `INSERT INTO model_capabilities (provider_profile_id, operation, capability, status, limits_json, contract_snapshot, verified_at)
           VALUES (:id, :op, :cap, 'declared', :limits, :snapshot, :now)`,
          {
            id: input.id,
            op: operation,
            cap: capability,
            limits: JSON.stringify(capabilityLimits(adapter, operation, capability)),
            snapshot: CONTRACT_SNAPSHOTS[input.transport]!["pt-BR"],
            now,
          },
        );
      }
    }
    return profileView(getProfileRow(db, input.id));
  });
}

/** Limites gravados na matriz: os que o adaptador declara para a operação (já com os padrões do transporte). */
function capabilityLimits(adapter: ProviderAdapter, operation: PlanOperation, capability: Capability): Record<string, number> {
  const max = adapter.limits?.(operation).maxReferences;
  return capability === "image_references" && typeof max === "number" ? { maxReferences: max } : {};
}

export function capabilityMatrix(db: Db, profileId: string) {
  return db.all<{ operation: string; capability: string; status: string; limits_json: string; contract_snapshot: string | null; verified_at: string }>(
    "SELECT operation, capability, status, limits_json, contract_snapshot, verified_at FROM model_capabilities WHERE provider_profile_id = :id ORDER BY operation, capability",
    { id: profileId },
  ).map((r) => ({ operation: r.operation, capability: r.capability, status: r.status, limits: JSON.parse(r.limits_json), contractSnapshot: snapshotText(r.contract_snapshot), verifiedAt: r.verified_at }));
}

/** Verificação gratuita, só por ação explícita do operador. Nenhuma geração é feita. */
export async function checkProfile(db: Db, registry: ProviderRegistry, profileId: string): Promise<{ ok: boolean; message: TextValue; details?: unknown }> {
  const row = getProfileRow(db, profileId);
  const signal = AbortSignal.timeout(30_000);
  try {
    const adapter = registry.adapterFor(profileId);
    if (adapter instanceof OpenRouterAdapter) {
      const endpoints = await adapter.discover(signal);
      return { ok: endpoints.length > 0, message: endpoints.length ? tx(`${endpoints.length} rota(s) disponível(is) para ${row.model}`, `${endpoints.length} route(s) available for ${row.model}`) : tx("Modelo sem rotas de imagem", "Model has no image routes"), details: endpoints };
    }
    if (adapter instanceof CodexCliAdapter) return await adapter.check(signal);
    if (adapter instanceof OpenAIImagesAdapter) {
      const url = `${row.base_url!.replace(/\/+$/, "")}/models`;
      const res = await providerFetch(url, { allowedHost: new URL(url).host, signal, headers: { authorization: `Bearer ${resolveSecret(row.secret_ref)}` } });
      failOnStatus(res);
      const ids = (res.json<{ data?: { id: string }[] }>().data ?? []).map((m) => m.id);
      return {
        ok: true,
        message: ids.includes(row.model ?? "") ? tx(`Modelo ${row.model} listado pelo servidor`, `Model ${row.model} listed by the server`) : tx(`Servidor respondeu; ${row.model} não aparece na listagem (pode ainda funcionar)`, `Server responded; ${row.model} is not in the listing (it may still work)`),
        details: { models: ids.length },
      };
    }
    return { ok: true, message: tx("Provedor simulado: nada a verificar", "Simulated provider: nothing to check") };
  } catch (err) {
    return { ok: false, message: err instanceof ProviderError ? err.text : err instanceof DomainFailure ? (err.messages ?? err.message) : err instanceof Error ? err.message : String(err) };
  }
}
