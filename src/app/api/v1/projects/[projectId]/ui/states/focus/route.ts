import { api, json, readJson } from "@/server/http";
import { applyFocusOverlay, FocusOverlayInput } from "@/server/ui/components";

/** Overlay de foco desenhado localmente na cor reservada do estilo. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json(await applyFocusOverlay(studio, params.projectId, await readJson(req, FocusOverlayInput)), 201));
