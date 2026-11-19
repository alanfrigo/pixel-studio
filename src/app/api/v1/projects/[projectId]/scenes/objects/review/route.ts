import { api, json, readJson } from "@/server/http";
import { ObjectReviewInput, reviewObject } from "@/server/scenes/rooms";

/** Revisão do prop (apoio, footprint, colisão, oclusão) preservando sombra e sala de origem. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => json({ revision: reviewObject(studio, params.projectId, await readJson(req, ObjectReviewInput)) }, 201));
