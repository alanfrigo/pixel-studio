import { z } from "zod";
import { Id } from "@/contracts";
import { equipInConfig } from "@/server/equipment/loadouts";
import { tx } from "@/i18n/locales";
import { DomainFailure } from "@/server/errors";
import { LoadoutConfig, resolutionView, resolveRequest, ResolveRequest } from "@/server/equipment/resolve";
import { api, json, readJson } from "@/server/http";

const Body = z.strictObject({
  request: ResolveRequest,
  /** Equipar esta peça no rascunho, retirando quem disputa os slots (o "Substituir" do editor). */
  equip: Id.optional(),
});

/** Resolve um rascunho ou um conjunto publicado (local, sem provedor): postura, clipes, pilhas, matriz e pendências. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  if (body.equip) {
    if (!("config" in body.request)) throw new DomainFailure("validation_failed", tx("Equipar exige um rascunho (config); para um conjunto publicado use a troca de item", "Equipping requires a draft (config); for a published loadout use item swap"));
    const equipped = equipInConfig(studio, params.projectId, body.request.config, body.equip);
    const config = LoadoutConfig.parse(equipped.config);
    const ctx = resolveRequest(studio, params.projectId, { config });
    return json({ view: resolutionView(studio.db, params.projectId, ctx), config, replacement: equipped.replacement });
  }
  const ctx = resolveRequest(studio, params.projectId, body.request);
  return json({ view: resolutionView(studio.db, params.projectId, ctx) });
});
