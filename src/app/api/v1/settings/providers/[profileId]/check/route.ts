import { api, json } from "@/server/http";
import { checkProfile } from "@/server/providers/profiles";

/** Verificação sem custo (catálogo, saldo ou lista de modelos); nunca gera imagem. */
export const POST = api<{ profileId: string }>(async (_req, { params, studio }) => json(await checkProfile(studio.db, studio.providers, params.profileId)));
