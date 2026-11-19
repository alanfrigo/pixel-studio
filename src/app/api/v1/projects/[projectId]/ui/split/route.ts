import { api, json, readJson } from "@/server/http";
import { SplitTemplateInput, splitTemplate } from "@/server/ui/components";

/** Recorte local explícito do template aprovado: cada peça vira revisão candidata de componente, ligada ao template. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json({ pieces: await splitTemplate(studio, params.projectId, await readJson(req, SplitTemplateInput)) }, 201));
