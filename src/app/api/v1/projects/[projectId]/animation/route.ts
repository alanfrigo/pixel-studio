import { animationOverview } from "@/server/animation/service";
import { api, json } from "@/server/http";

/** Visão da página de animação: bases, clipes, movimentos, presets, rotas por perfil e jobs recentes. */
export const GET = api<{ projectId: string }>(async (_req, { params, studio }) => json(animationOverview(studio, params.projectId)));
