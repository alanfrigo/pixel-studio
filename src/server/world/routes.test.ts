import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as catalogRoute from "@/app/api/v1/projects/[projectId]/world/route";
import * as copyRoute from "@/app/api/v1/projects/[projectId]/world/maps/[assetId]/copy/route";
import * as mapRoute from "@/app/api/v1/projects/[projectId]/world/maps/[assetId]/route";
import * as publishRoute from "@/app/api/v1/projects/[projectId]/world/maps/[assetId]/publish/route";
import * as mapsRoute from "@/app/api/v1/projects/[projectId]/world/maps/route";
import * as objectsRoute from "@/app/api/v1/projects/[projectId]/world/objects/route";
import * as textureCheckRoute from "@/app/api/v1/projects/[projectId]/world/textures/check/route";
import * as texturesRoute from "@/app/api/v1/projects/[projectId]/world/textures/route";
import * as tilesetCheckRoute from "@/app/api/v1/projects/[projectId]/world/tilesets/check/route";
import * as tilesetImportRoute from "@/app/api/v1/projects/[projectId]/world/tilesets/import/route";
import * as templateRoute from "@/app/api/v1/projects/[projectId]/world/tilesets/template/route";
import * as plansRoute from "@/app/api/v1/projects/[projectId]/generation-plans/route";
import { createImage, encodePng, fillRect, setPixel } from "@/lib/media/png";
import { createProject, getUpload, reviewRevision } from "../catalog/catalog";
import { ingestUpload } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { torusTexture } from "./simulated-art";

/**
 * Rotas `/world` ponta a ponta (sem `next dev`): o handler HTTP real, com o
 * Studio de teste no lugar do Studio do processo web.
 */

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const GLOBAL_KEY = Symbol.for("pixel-studio.web");
let studio: TestStudio;
afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[GLOBAL_KEY];
  studio?.cleanup();
});

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

async function call(handler: unknown, params: Record<string, string>, method: "GET" | "POST", body?: unknown, query = "") {
  const req = new Request(`http://127.0.0.1:3000/api/v1/x${query}`, {
    method,
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  // Corpo JSON livre: cada asserção lê só o campo que interessa.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return upload.id;
}

describe.skipIf(!existsSync(PYTHON))("rotas do mundo", () => {
  it("textura → gabarito → objeto → mapa → publicar → reabrir → copiar, e prévia de plano", async () => {
    studio = makeTestStudio();
    (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = studio;
    const project = createProject(studio.db, studio.clock, { name: "Rotas" });
    const p = { projectId: project.id };

    const textures: Record<string, { revision: { id: string; assetId: string } }> = {};
    for (const [name, color] of [
      ["grama", [80, 150, 60]],
      ["água", [50, 100, 200]],
    ] as const) {
      const uploadId = await upload(project.id, `${name}.png`, encodePng(torusTexture(name, [32, 32], 1, color)));
      const check = await call(textureCheckRoute.POST, p, "POST", { image: { from: "upload", uploadId }, axes: { x: true, y: true } });
      expect(check.status).toBe(200);
      const res = await call(texturesRoute.POST, p, "POST", { target: { name }, texture: { image: { from: "upload", uploadId }, material: name, axes: { x: true, y: true } } });
      expect(res.status).toBe(201);
      textures[name] = res.body;
      const rev = textures[name]!.revision;
      reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: rev.assetId, revisionId: rev.id, decision: "approve", reason: null, expectedActiveRevisionId: null });
    }

    const template = await call(templateRoute.POST, p, "POST", {
      target: { name: "Grama ↔ água" },
      template: {
        kind: "corner",
        materialA: textures.grama!.revision.id,
        materialB: textures["água"]!.revision.id,
        terrains: [
          { terrainId: "grass", name: "Grama", color: "#469632" },
          { terrainId: "water", name: "Água", color: "#3264c8" },
        ],
      },
    });
    expect(template.status).toBe(201);
    const tileset = (template.body as unknown as { revision: { id: string; assetId: string } }).revision;
    reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: tileset.assetId, revisionId: tileset.id, decision: "approve", reason: null, expectedActiveRevisionId: null });
    const tcheck = await call(tilesetCheckRoute.POST, p, "POST", { revisionId: tileset.id });
    expect(tcheck.status).toBe(200);
    expect(Object.keys(tcheck.body.previews as object)).toEqual(expect.arrayContaining(["sample", "sample_zoom", "pairs"]));

    // Importação de atlas com layout declarado errado é recusada com o caminho do campo.
    const atlasUpload = await upload(project.id, "atlas.png", encodePng(createImage(64, 64)));
    const badImport = await call(tilesetImportRoute.POST, p, "POST", {
      target: { name: "Importado" },
      kind: "corner",
      atlas: { image: { from: "upload", uploadId: atlasUpload }, payload: { projection: "top_down", cellSize: [32, 32], tiles: [] } },
    });
    expect(badImport.status).toBe(422);

    const tree = createImage(32, 48);
    for (let y = 2; y < 34; y++) for (let x = 2; x < 30; x++) if ((x - 16) ** 2 / 196 + (y - 18) ** 2 / 256 <= 1) setPixel(tree, x, y, [40, 120, 50, 255]);
    fillRect(tree, 13, 30, 6, 15, [110, 70, 40, 255]);
    const obj = await call(objectsRoute.POST, p, "POST", {
      target: { name: "Árvore" },
      object: { image: { from: "upload", uploadId: await upload(project.id, "arvore.png", encodePng(tree)) }, supportPoint: [16, 44], collision: [[13, 38, 6, 7]], occlusionAboveY: 34 },
    });
    expect(obj.status).toBe(201);
    const objRev = (obj.body as unknown as { revision: { id: string } }).revision;

    const created = await call(mapsRoute.POST, p, "POST", { name: "Clareira", tilesetRevisionId: tileset.id });
    expect(created.status).toBe(201);
    const mapAsset = (created.body as unknown as { asset: { id: string } }).asset.id;
    const opened = await call(mapRoute.GET, { ...p, assetId: mapAsset }, "GET");
    expect(opened.status).toBe(200);
    const payload = opened.body.payload as unknown as Record<string, unknown>;
    expect((opened.body.available as unknown as { objects: { revisionId: string }[] }).objects.map((o) => o.revisionId)).toContain(objRev.id);

    const edited = {
      ...payload,
      objects: [{ objectId: "arvore-1", objectRevisionId: objRev.id, pieceKey: null, cell: [4, 4], offsetPx: [0, 0] }],
      entrances: [
        { entranceId: "oeste", name: "Oeste", cell: [0, 4], side: "W" },
        { entranceId: "leste", name: "Leste", cell: [11, 4], side: "E" },
      ],
      passages: [{ from: "oeste", to: "leste" }],
    };
    const published = await call(publishRoute.POST, { ...p, assetId: mapAsset }, "POST", { payload: edited });
    expect(published.status).toBe(201);
    const revId = (published.body as unknown as { revision: { id: string } }).revision.id;
    const reopened = await call(mapRoute.GET, { ...p, assetId: mapAsset }, "GET", undefined, `?revision=${revId}`);
    expect((reopened.body.payload as unknown as { objects: { cell: number[] }[] }).objects[0]!.cell).toEqual([4, 4]);

    const copy = await call(copyRoute.POST, { ...p, assetId: mapAsset }, "POST", { revisionId: revId, name: "Cópia" });
    expect(copy.status).toBe(201);

    const catalog = await call(catalogRoute.GET, p, "GET");
    expect((catalog.body.maps as unknown[]).length).toBe(2);
    expect((catalog.body.tilesets as unknown[]).length).toBe(2);

    const plan = await call(plansRoute.POST, p, "POST", { operation: "generate_tileset", providerProfileId: "simulated", guideRevisionId: tileset.id, instruction: "mais detalhe" });
    expect(plan.status).toBe(200);
    expect((plan.body as unknown as { routeLabel: string }).routeLabel).toMatch(/Não é geração nativa/);
  });
});
