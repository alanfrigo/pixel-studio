import { z } from "zod";
import { type Capability, Id, PLAN_OPERATIONS } from "@/contracts";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import { type Clock, iso } from "../util";
import { OpenAIImagesAdapter, OpenRouterAdapter, PixelLabAdapter } from "./adapters";
import { checkBaseUrl, failOnStatus, providerFetch, resolveSecret } from "./http";
import { DEFAULT_BASE_URLS, getProfileRow, profileView, type ProviderProfileView, type ProviderRegistry, SIMULATED_PROFILE_ID } from "./registry";
import type { ProviderAdapter } from "./types";

/**
 * Cadastro de perfis pelo operador local (02 §configuração): URL base,
 * protocolo e NOME da variável com o segredo. Ao salvar, grava a matriz de
 * capacidades declaradas por operação com a data do contrato consultado.
 */

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "Use o nome de uma variável de ambiente, ex.: OPENROUTER_API_KEY");
const ProfileId = Id.refine((id) => id !== SIMULATED_PROFILE_ID, "ID reservado ao provedor simulado");
const common = { id: ProfileId, name: z.string().trim().min(1).max(120), secretRef: EnvName, config: z.record(z.string(), z.unknown()).default({}) };

export const ProfileInput = z.discriminatedUnion("transport", [
  z.strictObject({ ...common, transport: z.literal("openai_images"), baseUrl: z.string().min(1), model: z.string().trim().min(1).max(200) }),
  z.strictObject({ ...common, transport: z.literal("openrouter_images"), baseUrl: z.string().min(1).optional(), model: z.string().trim().min(1).max(200) }),
  z.strictObject({ ...common, transport: z.literal("pixellab_rest_v2"), baseUrl: z.string().min(1).optional() }),
]);
export type ProfileInput = z.infer<typeof ProfileInput>;

/** Data/fonte dos contratos usados para declarar capacidades. */
export const CONTRACT_SNAPSHOTS: Record<string, string> = {
  openai_images: "OpenAI Images API (referência oficial consultada em 2026-11-18)",
  openrouter_images: "OpenRouter Image API (guia e catálogo consultados em 2026-11-18)",
  pixellab_rest_v2: "PixelLab OpenAPI v2 (consultado em 2026-11-18)",
};

function buildAdapter(input: ProfileInput): ProviderAdapter {
  const profile = { id: input.id, baseUrl: input.baseUrl ?? DEFAULT_BASE_URLS[input.transport]!, secretRef: input.secretRef, model: "model" in input ? input.model : null };
  try {
    switch (input.transport) {
      case "openai_images":
        return new OpenAIImagesAdapter(profile, input.config);
      case "openrouter_images":
        return new OpenRouterAdapter(profile, input.config);
      case "pixellab_rest_v2":
        return new PixelLabAdapter(profile, input.config);
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new DomainFailure("validation_failed", "Configuração inválida para o transporte", {
        issues: err.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
      });
    }
    throw err;
  }
}

export function saveProfile(db: Db, clock: Clock, input: ProfileInput): ProviderProfileView {
  if (input.baseUrl) checkBaseUrl(input.baseUrl);
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
        base: input.baseUrl ?? null,
        secret: input.secretRef,
        model: "model" in input ? input.model : null,
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
            limits: JSON.stringify(capabilityLimits(input, capability)),
            snapshot: CONTRACT_SNAPSHOTS[input.transport]!,
            now,
          },
        );
      }
    }
    return profileView(getProfileRow(db, input.id));
  });
}

function capabilityLimits(input: ProfileInput, capability: Capability): Record<string, number> {
  const max = (input.config as { maxReferences?: number }).maxReferences;
  if (capability === "image_references" && typeof max === "number") return { maxReferences: max };
  if (capability === "image_references" && input.transport === "openai_images") return { maxReferences: 16 };
  return {};
}

export function capabilityMatrix(db: Db, profileId: string) {
  return db.all<{ operation: string; capability: string; status: string; limits_json: string; contract_snapshot: string | null; verified_at: string }>(
    "SELECT operation, capability, status, limits_json, contract_snapshot, verified_at FROM model_capabilities WHERE provider_profile_id = :id ORDER BY operation, capability",
    { id: profileId },
  ).map((r) => ({ operation: r.operation, capability: r.capability, status: r.status, limits: JSON.parse(r.limits_json), contractSnapshot: r.contract_snapshot, verifiedAt: r.verified_at }));
}

/** Verificação gratuita, só por ação explícita do operador. Nenhuma geração é feita. */
export async function checkProfile(db: Db, registry: ProviderRegistry, profileId: string): Promise<{ ok: boolean; message: string; details?: unknown }> {
  const row = getProfileRow(db, profileId);
  const signal = AbortSignal.timeout(30_000);
  try {
    const adapter = registry.adapterFor(profileId);
    if (adapter instanceof OpenRouterAdapter) {
      const endpoints = await adapter.discover(signal);
      return { ok: endpoints.length > 0, message: endpoints.length ? `${endpoints.length} rota(s) disponível(is) para ${row.model}` : "Modelo sem rotas de imagem", details: endpoints };
    }
    if (adapter instanceof PixelLabAdapter) {
      const balance = await adapter.balance(signal);
      return { ok: true, message: `Créditos US$ ${balance.credits.usd} · assinatura ${balance.subscription.status} (${balance.subscription.generations}/${balance.subscription.total} gerações)`, details: balance };
    }
    if (adapter instanceof OpenAIImagesAdapter) {
      const url = `${row.base_url!.replace(/\/+$/, "")}/models`;
      const res = await providerFetch(url, { allowedHost: new URL(url).host, signal, headers: { authorization: `Bearer ${resolveSecret(row.secret_ref)}` } });
      failOnStatus(res);
      const ids = (res.json<{ data?: { id: string }[] }>().data ?? []).map((m) => m.id);
      return {
        ok: true,
        message: ids.includes(row.model ?? "") ? `Modelo ${row.model} listado pelo servidor` : `Servidor respondeu; ${row.model} não aparece na listagem (pode ainda funcionar)`,
        details: { models: ids.length },
      };
    }
    return { ok: true, message: "Provedor simulado: nada a verificar" };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
