import { PLAN_OPERATIONS } from "@/contracts";
import { type TextValue, tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";
import { api, json, readJson } from "@/server/http";
import { capabilityMatrix, checkProfile, ProfileInput, saveProfile } from "@/server/providers/profiles";
import { listProfiles } from "@/server/providers/registry";

export const GET = api(async (req, { studio }) => {
  const forCreation = new URL(req.url).searchParams.get("for") === "creation";
  const profiles = await Promise.all(listProfiles(studio.db).map(async (p) => {
    let capabilities: Record<string, string[]> = {};
    let unavailable: TextValue | null = null;
    let maxReferences: number | undefined;
    try {
      const adapter = studio.providers.adapterFor(p.id);
      const operations = forCreation ? ["generate_asset"] as const : PLAN_OPERATIONS;
      capabilities = Object.fromEntries(operations.map((op) => [op, adapter.capabilities(op)] as const).filter(([, caps]) => caps.length > 0));
      maxReferences = adapter.limits?.("generate_asset").maxReferences;
      studio.providers.assertReady(p.id);
      if (forCreation && p.transport === "codex_cli") {
        const check = await checkProfile(studio.db, studio.providers, p.id);
        if (!check.ok) unavailable = check.message;
      }
    } catch (err) {
      unavailable = err instanceof DomainFailure ? (err.messages ?? err.message) : err instanceof Error ? err.message : tx("Perfil indisponível", "Profile unavailable");
    }
    if (forCreation) return { id: p.id, name: p.name, transport: p.transport, model: p.model, simulated: p.simulated, capabilities, maxReferences, unavailable };
    return { ...p, capabilities, matrix: capabilityMatrix(studio.db, p.id), unavailable };
  }));
  return json({ profiles });
});

/** Cria ou atualiza um perfil (operador local). O segredo fica no ambiente do servidor. */
export const POST = api(async (req, { studio }) => {
  const body = await readJson(req, ProfileInput);
  return json({ profile: saveProfile(studio.db, studio.clock, body) }, 201);
});
