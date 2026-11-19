import { z } from "zod";
import {
  type CornerTilesetPayload,
  Id,
  MapObjectPayload,
  NonNegInt,
  PosInt,
  Rect,
  ROOM_PROJECTIONS,
  ROOM_TILE_SIZES,
  RoomDoor,
  RoomFloorPlan,
  RoomFurniture,
  RoomPayload,
  TilemapPayload,
} from "@/contracts";
import { floorPlanProblems, furnitureDrawPositions, furnitureOrder, furnitureProblems, linkDoors, roomGrid } from "@/domain/scenes/room";
import { doorWallCells, furniturePlacement, type KitKey, kitTilesetPayload, roomEntrances, roomVertices } from "@/domain/scenes/room-map";
import { checkPassages, emptyCornerMap, reresolveCorner } from "@/domain/world/map";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { type LocalizedText, tx } from "@/i18n/locales";
import { createAsset, getAsset, getProject, getRevision, getUpload, publishRevision, type RevisionView, saveDraft } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { ImageRef } from "../services";
import type { Studio } from "../studio";
import { mapContext, passageContext } from "../world/maps";
import { dataUrl, outputOf, runWorldPython, storeOutput } from "../world/python";
import { checkTilesetAtlas } from "../world/tileset-core";
import { resolveImageRef } from "../world/textures";
import { ROOM_ROUTE_LABELS } from "./core";
import { genericRoomPayload } from "./room-payload";
import { carryFiles, fileBlob, ROOM_PROVENANCE_FILES } from "./revision-files";
import { assertInpaintOf, registerMaskUpload } from "./scenes";

/**
 * Casos de uso da sala (cartão T2 · 06 §sala mobiliada, §móveis e kit):
 * importar, revisar grade/portas, ligar duas salas, montar a prévia com os
 * móveis, recortar um móvel com máscara explícita, compor a sala depois de
 * reconstruir a área antes oculta (E1), mapear o kit local (a própria imagem
 * da sala, pela grade) por chave e remontar o trecho num mapa editável do T1.
 */

export function roomRevision(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "map" || asset.kind !== "room") throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} não é uma sala`, `${asset.name} r${revision.number} is not a room`));
  return { revision, asset, payload: RoomPayload.parse(revision.payload) };
}

function objectRevision(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "map" || asset.kind !== "object") throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} não é um prop (map/object)`, `${asset.name} r${revision.number} is not a prop (map/object)`));
  return { revision, asset, payload: MapObjectPayload.parse(revision.payload) };
}

/** Imagem-base atual da sala: o fundo reconstruído quando há móveis extraídos, senão a pintura. */
export function roomBaseImage(room: RoomPayload) {
  return room.background ?? room.picture;
}

const DoorInput = z.strictObject({ doorId: Id, cell: z.tuple([NonNegInt, NonNegInt]), side: z.enum(["N", "E", "S", "W"]) });

// ---------------------------------------------------------------------------
// Importar e revisar
// ---------------------------------------------------------------------------

export const RoomImportInput = z.strictObject({
  image: ImageRef,
  theme: z.string().trim().min(1).max(500),
  projection: z.enum(ROOM_PROJECTIONS).default("top_down"),
  tileSize: z.number().int().refine((v) => (ROOM_TILE_SIZES as readonly number[]).includes(v)).default(32),
  floorPlan: RoomFloorPlan,
  doors: z.array(DoorInput).min(1).max(8),
  grid: z.strictObject({ cellPx: z.tuple([PosInt, PosInt]), gridOrigin: z.tuple([z.number().int(), z.number().int()]) }).optional(),
});

export function importRoom(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof RoomImportInput>) {
  const input = RoomImportInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "room") throw new DomainFailure("validation_failed", tx("O asset não é uma sala", "The asset is not a room"));
  const problems = floorPlanProblems(input.floorPlan, input.doors);
  if (problems.length) throw new DomainFailure("validation_failed", problems[0]!.message, { problems });
  const image = resolveImageRef(studio, projectId, input.image);
  const grid = input.grid ?? roomGrid(input.projection, input.tileSize, input.floorPlan.size);
  const payload = genericRoomPayload({
    params: { theme: input.theme, projection: input.projection, tileSize: input.tileSize, doors: input.doors, floorPlan: input.floorPlan, styleRoomRevisionId: null },
    grid: { pictureSize: [image.width, image.height], cellPx: grid.cellPx, gridOrigin: grid.gridOrigin },
    route: "imported",
  });
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: input.image.from === "upload" ? "import" : "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [{ fileKey: "picture", role: "picture", idx: 0, blob: image }],
    technicalReport: { operation: "room_import", routeLabel: ROOM_ROUTE_LABELS.import },
  });
}

export const RoomEditInput = z.strictObject({
  baseRevisionId: Id,
  cellPx: z.tuple([PosInt, PosInt]).optional(),
  gridOrigin: z.tuple([z.number().int(), z.number().int()]).optional(),
  doors: z.array(RoomDoor).min(1).max(8).optional(),
  walkable: z.array(Rect).max(64).optional(),
  furniture: z.array(RoomFurniture).max(64).optional(),
  connections: z.array(z.strictObject({ doorId: Id, toRoomRevisionId: Id, toDoorId: Id })).max(8).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Problemas de colocação: apoio/footprint no piso, mesma vista e escala do prop (sombra e apoio corretos). */
export function furnitureReport(studio: Studio, projectId: string, room: RoomPayload, furniture: RoomPayload["furniture"]) {
  return furniture.map((f) => {
    const obj = objectRevision(studio, projectId, f.objectRevisionId);
    const problems = [...furnitureProblems(room, f.supportAtPx, obj.payload)];
    const wantIso = room.projection === "isometric";
    if ((obj.payload.projection === "isometric") !== wantIso) problems.push(tx(`${obj.asset.name} é ${obj.payload.projection}; a sala é ${room.projection}`, `${obj.asset.name} is ${obj.payload.projection}; the room is ${room.projection}`));
    if (obj.payload.sourceRoom) {
      const src = getRevision(studio.db, projectId, obj.payload.sourceRoom.roomRevisionId);
      const srcRoom = RoomPayload.parse(src.payload);
      if (srcRoom.cellPx[0] !== room.cellPx[0] || srcRoom.cellPx[1] !== room.cellPx[1]) {
        problems.push(
          tx(
            `${obj.asset.name} veio de uma sala com célula ${srcRoom.cellPx.join("×")}; esta usa ${room.cellPx.join("×")} (escala diferente)`,
            `${obj.asset.name} came from a room with ${srcRoom.cellPx.join("×")} cells; this one uses ${room.cellPx.join("×")} (different scale)`,
          ),
        );
      }
    }
    return { placementId: f.placementId, objectRevisionId: f.objectRevisionId, name: obj.asset.name, problems, draw: furnitureDrawPositions(f.supportAtPx, obj.payload) };
  });
}

/** Problemas de colocação que impedem publicar, prefixados pelo ID do móvel. */
function furnitureBlocking(furniture: ReturnType<typeof furnitureReport>): LocalizedText[] {
  return furniture.flatMap((f) => f.problems.map((p) => tx(`${f.placementId}: ${p["pt-BR"]}`, `${f.placementId}: ${p.en}`)));
}

function connectionReport(studio: Studio, projectId: string, room: RoomPayload, connections: RoomPayload["connections"]) {
  return connections.map((c) => {
    const other = roomRevision(studio, projectId, c.toRoomRevisionId);
    return { ...c, ...linkDoors(room, c.doorId, other.payload, c.toDoorId) };
  });
}

export function editRoom(studio: Studio, projectId: string, raw: z.input<typeof RoomEditInput>) {
  const input = RoomEditInput.parse(raw);
  const base = roomRevision(studio, projectId, input.baseRevisionId);
  const next = RoomPayload.parse({
    ...base.payload,
    ...(input.cellPx ? { cellPx: input.cellPx } : {}),
    ...(input.gridOrigin ? { gridOrigin: input.gridOrigin } : {}),
    ...(input.doors ? { doors: input.doors } : {}),
    ...(input.walkable ? { walkable: input.walkable } : {}),
    ...(input.furniture ? { furniture: input.furniture } : {}),
    ...(input.connections ? { connections: input.connections } : {}),
    sourceRoomRevisionId: base.revision.id,
  });
  const furniture = furnitureReport(studio, projectId, next, next.furniture);
  const blocking = furnitureBlocking(furniture);
  if (blocking.length) throw new DomainFailure("validation_failed", blocking[0]!, { problems: blocking });
  const connections = connectionReport(studio, projectId, next, next.connections);
  const broken = connections.filter((c) => !c.ok);
  if (broken.length) {
    const b = broken[0]!;
    throw new DomainFailure(
      "validation_failed",
      tx(`Porta ${b.doorId} não liga: ${b.problems.map((p) => p["pt-BR"]).join("; ")}`, `Door ${b.doorId} does not connect: ${b.problems.map((p) => p.en).join("; ")}`),
      { connections },
    );
  }
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: base.asset.id,
    origin: "composition",
    styleRevisionId: base.revision.styleRevisionId,
    predecessorId: base.revision.id,
    payload: next,
    files: carryFiles(studio.db, base.revision, "map", "room", next, { keep: ROOM_PROVENANCE_FILES }),
    technicalReport: {
      operation: "room_edit",
      label: input.note ?? tx("Sala revisada (grade, portas, móveis ou ligações)", "Room revised (grid, doors, furniture or links)"),
      furniture: furniture.map((f) => ({ placementId: f.placementId, objectRevisionId: f.objectRevisionId, name: f.name, problems: f.problems })),
      connections: connections.map((c) => ({ doorId: c.doorId, toRoomRevisionId: c.toRoomRevisionId, toDoorId: c.toDoorId, offsetPx: c.offsetPx, method: c.method })),
    },
  });
  return { revision, furniture, connections };
}

// ---------------------------------------------------------------------------
// Prévia montada (fundo + sombras + móveis pelo apoio + muretas)
// ---------------------------------------------------------------------------

export async function roomComposite(studio: Studio, projectId: string, revision: RevisionView, payload: RoomPayload = RoomPayload.parse(revision.payload)) {
  const baseImg = roomBaseImage(payload);
  const baseFile = revision.files.find((f) => f.fileKey === baseImg.fileId);
  if (!baseFile) throw new DomainFailure("not_found", tx("Imagem-base da sala ausente na revisão", "The room base image is missing from the revision"));
  const inputs: { role: string; sha256: string }[] = [{ role: "source", sha256: baseFile.sha256 }];
  const items: { inputOrdinal: number; at: [number, number] }[] = [];
  const furniture = furnitureReport(studio, projectId, payload, payload.furniture);
  for (const f of furnitureOrder(payload.furniture)) {
    const obj = objectRevision(studio, projectId, f.objectRevisionId);
    const draw = furnitureDrawPositions(f.supportAtPx, obj.payload);
    if (obj.payload.shadow && draw.shadow) {
      inputs.push({ role: "layer", sha256: obj.revision.files.find((x) => x.fileKey === obj.payload.shadow!.fileId)!.sha256 });
      items.push({ inputOrdinal: inputs.length - 1, at: draw.shadow });
    }
    inputs.push({ role: "layer", sha256: obj.revision.files.find((x) => x.fileKey === obj.payload.fileId)!.sha256 });
    items.push({ inputOrdinal: inputs.length - 1, at: draw.object });
  }
  if (payload.overlay) {
    inputs.push({ role: "layer", sha256: revision.files.find((x) => x.fileKey === payload.overlay!.fileId)!.sha256 });
    items.push({ inputOrdinal: inputs.length - 1, at: [0, 0] });
  }
  const [w, h] = [payload.picture.rect[2], payload.picture.rect[3]];
  const run = await runWorldPython(studio, "room_compose", inputs, { canvas: [w, h], items, zoom: 2 });
  return { run, furniture };
}

export async function previewRoom(studio: Studio, projectId: string, revisionId: string) {
  const { revision, payload } = roomRevision(studio, projectId, revisionId);
  const { run, furniture } = await roomComposite(studio, projectId, revision, payload);
  return { furniture, previews: { room: dataUrl(outputOf(run, "room")), zoom: dataUrl(outputOf(run, "room_zoom")) } };
}

export const LinkInput = z.strictObject({ aRevisionId: Id, aDoorId: Id, bRevisionId: Id, bDoorId: Id });

/** Duas salas lado a lado pelas portas ligadas: mesma vista/escala, portas opostas e alinhamento. */
export async function previewLink(studio: Studio, projectId: string, raw: z.input<typeof LinkInput>) {
  const input = LinkInput.parse(raw);
  const a = roomRevision(studio, projectId, input.aRevisionId);
  const b = roomRevision(studio, projectId, input.bRevisionId);
  const link = linkDoors(a.payload, input.aDoorId, b.payload, input.bDoorId);
  if (!link.ok || !link.offsetPx) return { link, preview: null };
  const ca = await roomComposite(studio, projectId, a.revision, a.payload);
  const cb = await roomComposite(studio, projectId, b.revision, b.payload);
  const [ox, oy] = link.offsetPx;
  const [aw, ah] = [a.payload.picture.rect[2], a.payload.picture.rect[3]];
  const [bw, bh] = [b.payload.picture.rect[2], b.payload.picture.rect[3]];
  const minX = Math.min(0, ox);
  const minY = Math.min(0, oy);
  const canvas: [number, number] = [Math.max(aw, ox + bw) - minX, Math.max(ah, oy + bh) - minY];
  const blank = await studio.blobs.putBytes(encodePng(createImage(1, 1)));
  const sa = await storeOutput(studio, outputOf(ca.run, "room"));
  const sb = await storeOutput(studio, outputOf(cb.run, "room"));
  const run = await runWorldPython(
    studio,
    "room_compose",
    [{ role: "source", sha256: blank.sha256 }, { role: "layer", sha256: sa.sha256 }, { role: "layer", sha256: sb.sha256 }],
    { canvas, items: [{ inputOrdinal: 1, at: [-minX, -minY] }, { inputOrdinal: 2, at: [ox - minX, oy - minY] }], zoom: 2 },
  );
  return { link, preview: dataUrl(outputOf(run, "room")) };
}

// ---------------------------------------------------------------------------
// Recorte local revisado de um móvel
// ---------------------------------------------------------------------------

export const CutoutInput = z.strictObject({
  roomRevisionId: Id,
  maskUploadId: Id,
  shadowMaskUploadId: Id.nullable().default(null),
  dilatePx: z.number().int().min(0).max(8).default(1),
});

async function cutoutRun(studio: Studio, projectId: string, input: z.output<typeof CutoutInput>) {
  const room = roomRevision(studio, projectId, input.roomRevisionId);
  if (room.payload.projection === "oblique") throw new DomainFailure("capability_missing", tx("Sala oblíqua não tem móveis a recortar: só paredes, portas e piso", "An oblique room has no furniture to cut out: walls, doors and floor only"));
  if (room.revision.status !== "approved") throw new DomainFailure("source_not_approved", tx("Aprove a sala antes de recortar móveis", "Approve the room before cutting out furniture"));
  const baseImg = roomBaseImage(room.payload);
  const baseFile = room.revision.files.find((f) => f.fileKey === baseImg.fileId)!;
  const mask = getUpload(studio.db, projectId, input.maskUploadId);
  const inputs = [
    { role: "source", sha256: baseFile.sha256 },
    { role: "editMask", sha256: mask.normalizedSha256 ?? mask.sha256 },
    ...(input.shadowMaskUploadId ? [{ role: "removeMask", sha256: (() => { const s = getUpload(studio.db, projectId, input.shadowMaskUploadId!); return s.normalizedSha256 ?? s.sha256; })() }] : []),
  ];
  const run = await runWorldPython(studio, "room_cutout", inputs, { dilatePx: input.dilatePx, contextRingPx: 2, alphaThreshold: 128 });
  return { room, baseImg, run, report: run.report as unknown as CutoutReport };
}

export interface CutoutReport {
  roomSize: [number, number];
  pieceRect: [number, number, number, number];
  piecePixels: number;
  shadowRect: [number, number, number, number] | null;
  shadowOffset: [number, number] | null;
  footY: number;
  suggestedSupport: [number, number];
  areaPixels: number;
  areaRect: [number, number, number, number] | null;
  contextOpaque: number;
  needsReconstruction: boolean;
}

export async function previewCutout(studio: Studio, projectId: string, raw: z.input<typeof CutoutInput>) {
  const input = CutoutInput.parse(raw);
  const { run, report } = await cutoutRun(studio, projectId, input);
  const has = (role: string) => run.outputs.some((o) => o.role === role);
  return {
    report,
    warnings: run.warnings,
    routeLabel: ROOM_ROUTE_LABELS.cutLocal,
    previews: { piece: dataUrl(outputOf(run, "piece")), shadow: has("shadow") ? dataUrl(outputOf(run, "shadow")) : null, area: dataUrl(outputOf(run, "area_preview")) },
  };
}

export const CutoutPublishInput = CutoutInput.extend({
  name: z.string().trim().min(1).max(64),
  supportPoint: z.tuple([NonNegInt, NonNegInt]).optional(),
  footprintCells: z.tuple([PosInt, PosInt]).default([1, 1]),
  collision: z.array(Rect).max(16).default([]),
  occlusionAboveY: NonNegInt.nullable().default(null),
});

/** Peça → prop reutilizável (candidato) + máscara da área exposta registrada para o E1. */
export async function publishCutout(studio: Studio, projectId: string, raw: z.input<typeof CutoutPublishInput>) {
  const input = CutoutPublishInput.parse(raw);
  const { room, baseImg, run, report } = await cutoutRun(studio, projectId, input);
  const piece = await storeOutput(studio, outputOf(run, "piece"));
  const shadowOut = run.outputs.find((o) => o.role === "shadow");
  const shadow = shadowOut ? await storeOutput(studio, shadowOut) : null;
  const [pw, ph] = [report.pieceRect[2], report.pieceRect[3]];
  const payload = MapObjectPayload.parse({
    projection: room.payload.projection === "isometric" ? "isometric" : "top_down",
    fileId: "image",
    rect: [0, 0, pw, ph],
    logicalSize: [pw, ph],
    supportPoint: input.supportPoint ?? report.suggestedSupport,
    footprintCells: input.footprintCells,
    collision: input.collision,
    occlusionAboveY: input.occlusionAboveY,
    shadow: shadow && report.shadowRect && report.shadowOffset ? { fileId: "shadow", rect: [0, 0, report.shadowRect[2], report.shadowRect[3]], offset: report.shadowOffset } : null,
    sourceRoom: { roomRevisionId: room.revision.id, pieceName: input.name, rectInRoom: report.pieceRect, method: "local_mask_cutout" },
  });
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "object", name: `${room.asset.name} · ${input.name}`.slice(0, 120) });
  const object = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "local_process",
    styleRevisionId: room.revision.styleRevisionId,
    payload,
    files: [{ fileKey: "image", role: "normalized", idx: 0, blob: piece }, ...(shadow ? [{ fileKey: "shadow", role: "shadow", idx: 0, blob: shadow }] : [])],
    technicalReport: {
      operation: "room_cutout",
      routeLabel: ROOM_ROUTE_LABELS.cutLocal,
      cutout: report,
      shadow: shadow
        ? tx(
            "Sombra estimada (escura translúcida) na máscara revisada: a pintura não separa a sombra do piso",
            "Estimated shadow (translucent dark) within the reviewed mask: the painting does not separate the shadow from the floor",
          )
        : null,
      label: tx("Apoio, footprint e colisão revisados pelo artista; o recorte não cria colisão confiável", "Support, footprint and collision reviewed by the artist; the cutout does not create reliable collision"),
    },
  });
  const area = await storeOutput(studio, outputOf(run, "area_mask"));
  const holed = await storeOutput(studio, outputOf(run, "holed"));
  const areaUpload = registerMaskUpload(studio, projectId, area, `area-${input.name}.png`, {
    roomRevisionId: room.revision.id,
    objectRevisionId: object.id,
    holedSha256: holed.sha256,
    cutout: { pieceName: input.name, areaRect: report.areaRect, areaPixels: report.areaPixels, contextOpaque: report.contextOpaque, needsReconstruction: report.needsReconstruction, supportAtPx: [report.pieceRect[0] + payload.supportPoint[0], report.pieceRect[1] + payload.supportPoint[1]] },
  });
  return {
    object,
    areaMaskUploadId: areaUpload.id,
    report,
    warnings: run.warnings,
    needsReconstruction: report.needsReconstruction,
    inpaint: { sourceRevisionId: room.revision.id, sourceFileKey: baseImg.fileId, maskUploadId: areaUpload.id },
  };
}

export const ComposeExtractedInput = z.strictObject({
  roomRevisionId: Id,
  areaMaskUploadId: Id,
  /** Área com piso/parede atrás: inpainting (E1) aprovado. Só área sobre rocha pode ficar apenas sem alfa. */
  reconstruction: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("inpaint"), inpaintRevisionId: Id }), z.strictObject({ kind: z.literal("transparent") })]),
  /** Onde o móvel volta a ficar (padrão: onde estava); mover depois é outra revisão. */
  supportAtPx: z.tuple([z.number().int(), z.number().int()]).optional(),
  placementId: Id.optional(),
});

/** Sala com o fundo sem o móvel (área reconstruída) e o móvel como prop colocado pelo apoio. */
export function composeExtracted(studio: Studio, projectId: string, raw: z.input<typeof ComposeExtractedInput>) {
  const input = ComposeExtractedInput.parse(raw);
  const room = roomRevision(studio, projectId, input.roomRevisionId);
  const upload = getUpload(studio.db, projectId, input.areaMaskUploadId);
  const meta = (upload.metadata ?? {}) as { roomRevisionId?: string; objectRevisionId?: string; holedSha256?: string; cutout?: { pieceName: string; areaRect: [number, number, number, number] | null; areaPixels: number; contextOpaque: number; needsReconstruction: boolean; supportAtPx: [number, number] } };
  if (meta.roomRevisionId !== room.revision.id || !meta.cutout || !meta.objectRevisionId) throw new DomainFailure("validation_failed", tx("A máscara não é a área de um recorte desta revisão da sala", "The mask is not the area of a cutout from this room revision"));
  const object = objectRevision(studio, projectId, meta.objectRevisionId);
  const baseImg = roomBaseImage(room.payload);
  let background;
  let status: "reconstructed_inpaint" | "transparent_reviewed";
  let inpaintRevisionId: string | null = null;
  if (input.reconstruction.kind === "inpaint") {
    const inpaint = assertInpaintOf(studio, projectId, input.reconstruction.inpaintRevisionId, room.revision, input.areaMaskUploadId);
    const edited = inpaint.files.find((f) => f.fileKey === baseImg.fileId);
    if (!edited) throw new DomainFailure("validation_failed", tx("O inpainting não editou a imagem-base da sala", "The inpainting did not edit the room base image"));
    background = fileBlob(studio.db, edited.sha256);
    status = "reconstructed_inpaint";
    inpaintRevisionId = inpaint.id;
  } else {
    if (meta.cutout.needsReconstruction) {
      const pct = Math.round(meta.cutout.contextOpaque * 100);
      throw new DomainFailure(
        "validation_failed",
        tx(
          `A área tem ${pct}% de piso/parede em volta: o que a peça cobria nunca foi pintado; reconstrua por inpainting (apagar o alfa não basta)`,
          `The area has ${pct}% floor/wall around it: what the piece covered was never painted; rebuild it by inpainting (clearing alpha is not enough)`,
        ),
      );
    }
    background = fileBlob(studio.db, meta.holedSha256!);
    status = "transparent_reviewed";
  }
  const n = room.payload.exposedAreas.length + 1;
  const maskBlob = fileBlob(studio.db, upload.normalizedSha256 ?? upload.sha256);
  const placementId = input.placementId ?? `${object.asset.name.split("·").pop()!.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "movel"}-${n}`;
  const next = RoomPayload.parse({
    ...room.payload,
    background: { fileId: "background", rect: [0, 0, room.payload.picture.rect[2], room.payload.picture.rect[3]] },
    furniture: [...room.payload.furniture, { placementId, objectRevisionId: object.revision.id, supportAtPx: input.supportAtPx ?? meta.cutout.supportAtPx, label: meta.cutout.pieceName }],
    exposedAreas: [
      ...room.payload.exposedAreas,
      {
        areaId: `area-${n}`,
        pieceName: meta.cutout.pieceName,
        rect: meta.cutout.areaRect ?? object.payload.sourceRoom?.rectInRoom ?? [0, 0, 1, 1],
        mask: { fileId: `area-mask-${n}`, rect: [0, 0, room.payload.picture.rect[2], room.payload.picture.rect[3]] },
        measured: { pixels: Math.max(1, meta.cutout.areaPixels), contextOpaque: meta.cutout.contextOpaque },
        status,
        inpaintRevisionId,
      },
    ],
    sourceRoomRevisionId: room.revision.id,
  });
  const furniture = furnitureReport(studio, projectId, next, next.furniture);
  const blocking = furnitureBlocking(furniture);
  if (blocking.length) throw new DomainFailure("validation_failed", blocking[0]!, { problems: blocking });
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: room.asset.id,
    origin: "composition",
    styleRevisionId: room.revision.styleRevisionId,
    predecessorId: room.revision.id,
    payload: next,
    files: [
      ...carryFiles(studio.db, room.revision, "map", "room", next, { keep: ROOM_PROVENANCE_FILES, skip: ["background"] }),
      { fileKey: "background", role: "background", idx: 0, blob: background },
      { fileKey: `area-mask-${n}`, role: "mask", idx: n, blob: maskBlob },
    ],
    technicalReport: {
      operation: "room_compose_extracted",
      routeLabel: ROOM_ROUTE_LABELS.cutLocal,
      area: { piece: meta.cutout.pieceName, status, inpaintRevisionId, contextOpaque: meta.cutout.contextOpaque, pixels: meta.cutout.areaPixels },
      label:
        status === "reconstructed_inpaint"
          ? tx(
              "Área antes oculta reconstruída por inpainting (E1) e revisada; o móvel virou prop colocado pelo apoio",
              "Previously hidden area rebuilt by inpainting (E1) and reviewed; the furniture became a prop placed by its support point",
            )
          : tx(
              "Área sobre rocha transparente: nada a reconstruir; o móvel virou prop colocado pelo apoio",
              "Area over transparent rock: nothing to rebuild; the furniture became a prop placed by its support point",
            ),
    },
  });
}

// ---------------------------------------------------------------------------
// Kit → tileset por chave → mapa editável do T1
// ---------------------------------------------------------------------------

/** Folha do kit local (a própria imagem da sala) e a grade declarada, para mapear por chave. */
export function inspectKit(studio: Studio, projectId: string, roomRevisionId: string) {
  const room = roomRevision(studio, projectId, roomRevisionId);
  const picture = room.revision.files.find((f) => f.fileKey === room.payload.picture.fileId);
  const sheets = [
    { sheetId: "picture", name: tx("Imagem da sala (kit local pela grade)", "Room image (local kit by grid)"), fileKey: room.payload.picture.fileId, mediaId: picture?.id ?? null, size: [room.payload.picture.rect[2], room.payload.picture.rect[3]] as [number, number], source: "picture" as const },
  ];
  return { sheets, grid: { cellPx: room.payload.cellPx, gridOrigin: room.payload.gridOrigin }, projection: room.payload.projection };
}

const KitKeyInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mask"), mask: z.number().int().min(0).max(15) }),
  z.strictObject({ kind: z.literal("door"), side: z.enum(["N", "E", "S", "W"]) }),
  z.strictObject({ kind: z.literal("ignore") }),
]);

export const KitMapInput = z.strictObject({
  roomRevisionId: Id,
  /** Folha mapeada: a imagem da sala (kit local). */
  sheetId: z.literal("picture").default("picture"),
  name: z.string().trim().min(1).max(120),
  /** Grade declarada na folha: canto da primeira célula, tamanho da célula e espaçamento. */
  origin: z.tuple([NonNegInt, NonNegInt]).default([0, 0]),
  cell: z.tuple([PosInt, PosInt]),
  spacing: NonNegInt.default(0),
  /** Chave de cada célula, linha a linha (máscara 0–15 piso/parede, porta ou ignorar). */
  keys: z.array(KitKeyInput).min(1).max(512),
});

function gridRects(size: readonly [number, number], origin: readonly [number, number], cell: readonly [number, number], spacing: number): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let y = origin[1]; y + cell[1] <= size[1]; y += cell[1] + spacing) for (let x = origin[0]; x + cell[0] <= size[0]; x += cell[0] + spacing) out.push([x, y, cell[0], cell[1]]);
  return out;
}

/** Recorta um retângulo de uma imagem (máscara retangular no `room_cutout`) para virar prop. */
async function cropRect(studio: Studio, sha256: string, size: readonly [number, number], rect: readonly [number, number, number, number]) {
  const mask = createImage(size[0], size[1]);
  fillRect(mask, 0, 0, size[0], size[1], [0, 0, 0, 255]);
  fillRect(mask, rect[0], rect[1], rect[2], rect[3], [255, 255, 255, 255]);
  const stored = await studio.blobs.putBytes(encodePng(mask));
  const run = await runWorldPython(studio, "room_cutout", [{ role: "source", sha256 }, { role: "editMask", sha256: stored.sha256 }], { dilatePx: 0, contextRingPx: 1, alphaThreshold: 1 });
  return { blob: await storeOutput(studio, outputOf(run, "piece")), report: run.report as unknown as CutoutReport };
}

/**
 * Kit mapeado por chave → tileset por cantos piso ↔ parede do T1 (o atlas é a
 * imagem da sala, recortada pelas chaves; não pela posição original) e portas
 * como props. Falta de máscara impede declarar o conjunto completo.
 */
export async function mapKit(studio: Studio, projectId: string, raw: z.input<typeof KitMapInput>) {
  const input = KitMapInput.parse(raw);
  const room = roomRevision(studio, projectId, input.roomRevisionId);
  if (room.payload.projection === "oblique") throw new DomainFailure(
      "capability_missing",
      tx(
        "Sala oblíqua: as paredes inclinadas não cabem no tileset por cantos do T1 (quadro = célula); sem mapa automático",
        "Oblique room: the slanted walls do not fit the T1 corner tileset (frame = cell); no automatic map",
      ),
    );
  const sheet = { fileKey: room.payload.picture.fileId, size: [room.payload.picture.rect[2], room.payload.picture.rect[3]] as [number, number] };
  const file = room.revision.files.find((f) => f.fileKey === sheet.fileKey)!;
  const rects = gridRects(sheet.size, input.origin, input.cell, input.spacing);
  if (input.keys.length > rects.length) throw new DomainFailure("validation_failed", tx(`A grade declarada tem ${rects.length} células; recebidas ${input.keys.length} chaves`, `The declared grid has ${rects.length} cells; received ${input.keys.length} keys`));
  const mapped = kitTilesetPayload({ fileId: "atlas", cell: input.cell, margin: 0, spacing: input.spacing, rects, keys: input.keys as KitKey[] });
  if (mapped.payload.tiles.length === 0) throw new DomainFailure("validation_failed", tx("Nenhuma célula mapeada para máscara piso/parede", "No cell is mapped to a floor/wall mask"));
  const atlas = fileBlob(studio.db, file.sha256);
  const check = await checkTilesetAtlas(studio, "corner", mapped.payload, atlas.sha256);
  const label = ROOM_ROUTE_LABELS.kitLocal;
  const tsAsset = createAsset(studio.db, studio.clock, { projectId, family: "tileset", kind: "corner", name: input.name });
  const tileset = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: tsAsset.id,
    origin: "import",
    styleRevisionId: room.revision.styleRevisionId,
    payload: mapped.payload,
    files: [{ fileKey: "atlas", role: "atlas", idx: 0, blob: atlas }],
    edges: [{ toRevisionId: room.revision.id, role: "source_room", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "room_kit_map",
      routeLabel: label,
      sheet: { sheetId: input.sheetId, origin: input.origin, cell: input.cell, spacing: input.spacing },
      keys: input.keys,
      missing: mapped.missing,
      check: check.report,
      warnings: [
        ...(mapped.missing.length ? [tx(`Máscaras ausentes: ${mapped.missing.join(", ")} — o conjunto não é declarado completo`, `Missing masks: ${mapped.missing.join(", ")} — the set is not declared complete`)] : []),
        ...check.warnings,
      ],
    },
  });
  const doors = [];
  for (const d of mapped.doors) {
    const { blob, report } = await cropRect(studio, atlas.sha256, sheet.size, d.rect);
    const [w, h] = [report.pieceRect[2], report.pieceRect[3]];
    const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "object", name: `${input.name} · porta ${d.side}` });
    doors.push({
      side: d.side,
      revision: publishRevision(studio.db, studio.clock, {
        projectId,
        assetId: asset.id,
        origin: "import",
        styleRevisionId: room.revision.styleRevisionId,
        payload: MapObjectPayload.parse({ projection: "top_down", fileId: "image", rect: [0, 0, w, h], logicalSize: [w, h], supportPoint: [Math.floor(w / 2), h], footprintCells: [1, 1], collision: [], occlusionAboveY: null }),
        files: [{ fileKey: "image", role: "normalized", idx: 0, blob }],
        edges: [{ toRevisionId: room.revision.id, role: "source_room", ordinal: 0, runtime: false }],
        technicalReport: { operation: "room_kit_door", routeLabel: label, rect: d.rect, label: tx("Peça de porta do kit: passagem livre (sem colisão); a entrada do mapa marca a porta", "Kit door piece: free passage (no collision); the map entrance marks the door") },
      }),
    });
  }
  return { tileset, missing: mapped.missing, complete: mapped.payload.complete, doors, check: { report: check.report, warnings: check.warnings } };
}

export const RoomToMapInput = z.strictObject({
  roomRevisionId: Id,
  tilesetRevisionId: Id,
  name: z.string().trim().min(1).max(120),
  /** Porta do kit (prop) por lado, desenhada na parede junto à entrada. */
  doorObjects: z.partialRecord(z.enum(["N", "E", "S", "W"]), Id).default({}),
});

/** Remonta o trecho editável: planta → terreno piso/parede, portas → entradas, móveis → objetos com apoio/colisão. */
export function roomToMap(studio: Studio, projectId: string, raw: z.input<typeof RoomToMapInput>) {
  const input = RoomToMapInput.parse(raw);
  const room = roomRevision(studio, projectId, input.roomRevisionId);
  if (room.payload.projection !== "top_down") throw new DomainFailure(
      "capability_missing",
      tx(
        "Remontar em mapa por cantos vale para salas top-down; a vista isométrica usa o tileset isométrico do T1",
        "Rebuilding as a corner map applies to top-down rooms; the isometric view uses the T1 isometric tileset",
      ),
    );
  const tsRev = getRevision(studio.db, projectId, input.tilesetRevisionId);
  const tsAsset = getAsset(studio.db, projectId, tsRev.assetId);
  if (tsAsset.family !== "tileset" || tsAsset.kind !== "corner") throw new DomainFailure("validation_failed", tx("O kit mapeado é um tileset por cantos (piso ↔ parede)", "The mapped kit must be a corner tileset (floor ↔ wall)"));
  const ts = tsRev.payload as CornerTilesetPayload;
  const { size, vertices } = roomVertices(room.payload.floorPlan);
  let map = emptyCornerMap({ size, cellSize: ts.cellSize, tilesetRevisionId: tsRev.id, tileset: ts, seed: 1, walkable: [true, false] });
  if (map.terrain.mode !== "corner") throw new Error("inalcançável");
  map = reresolveCorner({ ...map, terrain: { ...map.terrain, vertices } } as Parameters<typeof reresolveCorner>[0], ts);
  const objects = [];
  for (const f of room.payload.furniture) {
    const obj = objectRevision(studio, projectId, f.objectRevisionId);
    objects.push(furniturePlacement(room.payload, ts.cellSize, f, obj.payload.footprintCells));
  }
  for (const w of doorWallCells(room.payload)) {
    const objectRevisionId = input.doorObjects[w.side];
    if (objectRevisionId) objects.push({ objectId: `porta-${w.doorId}`, objectRevisionId, pieceKey: null, cell: w.cell, offsetPx: [0, 0] as [number, number], label: `Porta ${w.side}` });
  }
  const entrances = roomEntrances(room.payload);
  const draft = TilemapPayload.parse({
    ...map,
    objects,
    entrances,
    passages: entrances.slice(1).map((e) => ({ from: entrances[0]!.entranceId, to: e.entranceId })),
    regions: [{ regionId: "sala", name: room.asset.name.slice(0, 64), kind: "area", rect: [1, 1, room.payload.floorPlan.size[0], room.payload.floorPlan.size[1]] }],
  });
  const passages = checkPassages(draft, passageContext(mapContext(studio, projectId, draft)));
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "tilemap", name: input.name });
  const saved = saveDraft(studio.db, studio.clock, { projectId, assetId: asset.id, expectedVersion: 0, payload: draft });
  return {
    asset,
    draft: saved,
    passages: passages.results.map(({ path, ...r }) => ({ ...r, pathLength: path.length })),
    openUrl: `/projects/${projectId}/world?tab=maps&map=${asset.id}`,
    label: tx(
      "Trecho editável no editor do T1: terreno por vértice, entradas com os IDs das portas, móveis com apoio/footprint/colisão/oclusão do próprio prop",
      "Editable section in the T1 editor: per-vertex terrain, entrances with the door IDs, furniture with each prop's own support/footprint/collision/occlusion",
    ),
  };
}

// ---------------------------------------------------------------------------
// Revisão do prop (apoio, footprint, colisão, oclusão) sem perder sombra e origem
// ---------------------------------------------------------------------------

export const ObjectReviewInput = z.strictObject({
  baseRevisionId: Id,
  supportPoint: z.tuple([NonNegInt, NonNegInt]),
  footprintCells: z.tuple([PosInt, PosInt]),
  collision: z.array(Rect).max(16),
  occlusionAboveY: NonNegInt.nullable(),
});

export function reviewObject(studio: Studio, projectId: string, raw: z.input<typeof ObjectReviewInput>) {
  const input = ObjectReviewInput.parse(raw);
  const base = objectRevision(studio, projectId, input.baseRevisionId);
  const payload = MapObjectPayload.parse({ ...base.payload, supportPoint: input.supportPoint, footprintCells: input.footprintCells, collision: input.collision, occlusionAboveY: input.occlusionAboveY });
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: base.asset.id,
    origin: "composition",
    styleRevisionId: base.revision.styleRevisionId,
    predecessorId: base.revision.id,
    payload,
    files: carryFiles(studio.db, base.revision, "map", "object", payload, { keep: (k) => k === "raw" }),
    edges: [{ toRevisionId: base.revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "map_object_review",
      label: tx("Apoio, footprint, colisão e oclusão revisados pelo artista (sombra e origem preservadas)", "Support, footprint, collision and occlusion reviewed by the artist (shadow and origin preserved)"),
    },
  });
}
