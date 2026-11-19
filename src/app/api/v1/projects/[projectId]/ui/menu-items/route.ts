import { api, json, readJson } from "@/server/http";
import { MenuItemInput, publishMenuItem } from "@/server/ui/components";

/** Item de menu: botão aprovado + ação + legenda por chave (sem arte nova). */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(publishMenuItem(studio, params.projectId, await readJson(req, MenuItemInput)), 201));
