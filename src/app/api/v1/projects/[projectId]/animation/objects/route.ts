import { api, json, readJson } from "@/server/http";
import { CreateObjectInput, createObjectFromImage } from "@/server/animation/temporal-service";

/** Objeto (baú, tocha) a partir de uma imagem do projeto: base sem rig humanoide, candidata à aprovação. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CreateObjectInput);
  return json(await createObjectFromImage(studio, params.projectId, body), 201);
});
