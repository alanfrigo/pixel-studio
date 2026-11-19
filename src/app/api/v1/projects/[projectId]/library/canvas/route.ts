import { api, json, readJson } from "@/server/http";
import { CanvasInput, resizeCanvas } from "@/server/library/library";

/** Amplia ou reduz a célula deslocando camadas, sockets, pivô e eventos pela mesma margem, sem gerar pixels. */
export const POST = api<{ projectId: string }>(async (req, { params, studio }) => {
  const body = await readJson(req, CanvasInput);
  return json(await resizeCanvas(studio, params.projectId, body), 201);
});
