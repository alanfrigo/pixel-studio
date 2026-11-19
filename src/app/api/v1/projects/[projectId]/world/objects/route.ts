import { z } from "zod";
import { api, json, readJson } from "@/server/http";
import { AssetTarget, ensureAsset } from "@/server/world/catalog";
import { MapObjectInput, publishMapObject } from "@/server/world/maps";

const Body = z.strictObject({ target: AssetTarget, object: MapObjectInput });

/** Objeto de mapa com apoio, footprint, colisão (ex.: só o tronco) e oclusão revisados. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, Body);
  const asset = ensureAsset(studio, params.projectId, body.target, "map", "object");
  return json({ revision: publishMapObject(studio, params.projectId, asset.id, body.object) }, 201);
});
