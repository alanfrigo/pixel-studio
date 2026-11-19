import { PLAN_OPERATIONS } from "@/contracts";
import { api, json, readJson } from "@/server/http";
import { capabilityMatrix, ProfileInput, saveProfile } from "@/server/providers/profiles";
import { listProfiles } from "@/server/providers/registry";

export const GET = api(async (_req, { studio }) => {
  const profiles = listProfiles(studio.db).map((p) => {
    let capabilities: Record<string, string[]> = {};
    let unavailable: string | null = null;
    try {
      const adapter = studio.providers.adapterFor(p.id);
      capabilities = Object.fromEntries(PLAN_OPERATIONS.map((op) => [op, adapter.capabilities(op)]).filter(([, caps]) => (caps?.length ?? 0) > 0));
      studio.providers.assertReady(p.id);
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }
    return { ...p, capabilities, matrix: capabilityMatrix(studio.db, p.id), unavailable };
  });
  return json({ profiles });
});

/** Cria ou atualiza um perfil (operador local). O segredo fica no ambiente do servidor. */
export const POST = api(async (req, { studio }) => {
  const body = await readJson(req, ProfileInput);
  return json({ profile: saveProfile(studio.db, studio.clock, body) }, 201);
});
