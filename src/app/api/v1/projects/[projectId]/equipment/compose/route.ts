import { ComposeInput, composePreview } from "@/server/equipment/service";
import { api, json, readJson } from "@/server/http";

/** Composição local de uma combinação (folha achatada pixel a pixel, igual à exportada). Zero chamadas pagas. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await composePreview(studio, params.projectId, await readJson(req, ComposeInput))));
