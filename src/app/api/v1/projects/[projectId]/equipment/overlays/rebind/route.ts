import { RebindInput, rebindCoverage } from "@/server/equipment/overlays";
import { api, json, readJson } from "@/server/http";

/** Revincula a cobertura à nova revisão do clipe onde o digest de geometria coincide (mesmos blobs). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await rebindCoverage(studio, params.projectId, await readJson(req, RebindInput)), 201));
