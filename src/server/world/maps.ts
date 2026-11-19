import { z } from "zod";
import {
  type CornerTilesetPayload,
  Id,
  type IsoTilesetPayload,
  MapObjectPayload,
  NonNegInt,
  PosInt,
  Rect,
  type SideTilesetPayload,
  TilemapPayload,
} from "@/contracts";
import { resolveSideMap } from "@/domain/world/side";
import { checkPassages, emptyCornerMap, isCornerMap, type PassageContext, reresolveCorner, reresolveSide } from "@/domain/world/map";
import { resolveCornerMap } from "@/domain/world/corner";
import { cornerSetKey } from "@/domain/world/map";
import { createAsset, getAsset, getDraft, getProject, getRevision, listAssets, listRevisions, publishRevision, type RevisionView, saveDraft } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { ImageRef } from "../services";
import type { Studio } from "../studio";
import { resolveImageRef } from "./textures";

/**
 * Objetos de mapa e mapas editáveis (06 §montar a região). O mapa vive como
 * rascunho versionado (duas abas) e vira revisão imutável ao publicar; a
 * publicação recalcula o autotile no servidor e confere as passagens exigidas.
 */

// ---------------------------------------------------------------------------
// Objetos de mapa (props com apoio, footprint, colisão e oclusão)
// ---------------------------------------------------------------------------

export const MapObjectInput = z.strictObject({
  image: ImageRef,
  projection: z.enum(["top_down", "three_quarter", "side"]).default("top_down"),
  supportPoint: z.tuple([NonNegInt, NonNegInt]),
  footprintCells: z.tuple([PosInt, PosInt]).default([1, 1]),
  collision: z.array(Rect).max(16).default([]),
  occlusionAboveY: NonNegInt.nullable().default(null),
});

export function publishMapObject(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof MapObjectInput>) {
  const input = MapObjectInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "object") throw new DomainFailure("validation_failed", `O asset é ${asset.family}/${asset.kind}; esperado map/object`);
  const image = resolveImageRef(studio, projectId, input.image);
  const payload = MapObjectPayload.parse({
    projection: input.projection,
    fileId: "image",
    rect: [0, 0, image.width, image.height],
    logicalSize: [image.width, image.height],
    supportPoint: input.supportPoint,
    footprintCells: input.footprintCells,
    collision: input.collision,
    occlusionAboveY: input.occlusionAboveY,
  });
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: input.image.from === "upload" ? "import" : "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [{ fileKey: "image", role: "normalized", idx: 0, blob: image }],
    ...(input.image.from === "revision" ? { edges: [{ toRevisionId: input.image.revisionId, role: "source", ordinal: 0, runtime: false }] } : {}),
    technicalReport: {
      operation: "map_object",
      label: "Colisão, apoio e oclusão revisados pelo artista (o prompt não cria colisão confiável)",
    },
  });
}

// ---------------------------------------------------------------------------
// Contexto do mapa: tileset e objetos citados
// ---------------------------------------------------------------------------

interface TilesetContext {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: RevisionView["status"];
  kind: "corner" | "sidescroller" | "isometric";
  payload: CornerTilesetPayload | SideTilesetPayload | IsoTilesetPayload;
  /** ID do vínculo de arquivo do atlas (rota de mídia). */
  atlasMediaId: string;
}

interface ObjectContext {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: RevisionView["status"];
  payload: MapObjectPayload;
  mediaId: string;
}

export function tilesetContext(studio: Studio, projectId: string, revisionId: string): TilesetContext {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "tileset") throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} não é um tileset`);
  const payload = revision.payload as TilesetContext["payload"];
  const atlas = revision.files.find((f) => f.fileKey === payload.atlas.fileId);
  if (!atlas) throw new DomainFailure("not_found", "Atlas ausente na revisão do tileset");
  return { revisionId, assetId: asset.id, name: asset.name, number: revision.number, status: revision.status, kind: asset.kind as TilesetContext["kind"], payload, atlasMediaId: atlas.id };
}

export function objectContext(studio: Studio, projectId: string, revisionId: string): ObjectContext {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "map" || asset.kind !== "object") throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} não é um objeto de mapa`);
  const payload = MapObjectPayload.parse(revision.payload);
  const file = revision.files.find((f) => f.fileKey === payload.fileId)!;
  return { revisionId, assetId: asset.id, name: asset.name, number: revision.number, status: revision.status, payload, mediaId: file.id };
}

export function mapContext(studio: Studio, projectId: string, map: TilemapPayload) {
  const tileset = tilesetContext(studio, projectId, map.terrain.tilesetRevisionId);
  const expected = map.terrain.mode === "corner" ? "corner" : map.terrain.mode === "side" ? "sidescroller" : "isometric";
  if (tileset.kind !== expected) throw new DomainFailure("validation_failed", `Terreno ${map.terrain.mode} exige tileset ${expected}; ${tileset.name} é ${tileset.kind}`);
  const objects: Record<string, ObjectContext> = {};
  for (const o of map.objects) {
    if (o.objectRevisionId && !objects[o.objectRevisionId]) objects[o.objectRevisionId] = objectContext(studio, projectId, o.objectRevisionId);
    if (o.pieceKey) {
      const piece = tileset.kind === "isometric" ? (tileset.payload as IsoTilesetPayload).pieces.find((p) => p.pieceKey === o.pieceKey) : undefined;
      if (!piece || piece.kind !== "prop") throw new DomainFailure("validation_failed", `Peça ${o.pieceKey} não é um prop do tileset isométrico do mapa`);
    }
  }
  return { tileset, objects };
}

export function passageContext(ctx: ReturnType<typeof mapContext>): PassageContext {
  return {
    objects: new Map(Object.values(ctx.objects).map((o) => [o.revisionId, o.payload])),
    ...(ctx.tileset.kind === "isometric" ? { isoPieces: new Map((ctx.tileset.payload as IsoTilesetPayload).pieces.map((p) => [p.pieceKey, p])) } : {}),
  };
}

/** Recalcula no servidor a parte derivada do terreno (autotile/configuração): o cliente não decide o resolvido. */
export function resolveTerrain(map: TilemapPayload, tileset: TilesetContext): { map: TilemapPayload; missing: string[] } {
  if (isCornerMap(map)) {
    const ts = tileset.payload as CornerTilesetPayload;
    const res = resolveCornerMap(map.terrain.vertices, map.size, ts, { seed: map.seed, setKey: cornerSetKey(ts), rule: map.terrain.rule, overrides: map.terrain.overrides });
    return { map: reresolveCorner(map, ts), missing: res.missing.map(String) };
  }
  if (map.terrain.mode === "side") {
    const res = resolveSideMap(map.terrain.solid, map.size, tileset.payload as SideTilesetPayload);
    return { map: reresolveSide(map, tileset.payload as SideTilesetPayload), missing: res.gaps };
  }
  const terrain = map.terrain;
  if (terrain.mode !== "isometric") return { map, missing: [] };
  const pieces = new Set((tileset.payload as IsoTilesetPayload).pieces.filter((p) => p.kind !== "prop").map((p) => p.pieceKey));
  const missing = [...new Set(terrain.cells.map((c) => c.pieceKey).filter((k): k is string => k !== null && !pieces.has(k)))];
  return { map, missing };
}

// ---------------------------------------------------------------------------
// Criar, abrir, publicar e copiar mapas
// ---------------------------------------------------------------------------

export const CreateMapInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  tilesetRevisionId: Id,
  size: z.tuple([z.number().int().min(1).max(128), z.number().int().min(1).max(128)]).default([12, 8]),
  seed: z.number().int().min(0).max(1_000_000).default(1),
  walkable: z.tuple([z.boolean(), z.boolean()]).default([true, false]),
});

export function initialMap(studio: Studio, projectId: string, input: z.output<typeof CreateMapInput>): TilemapPayload {
  const tileset = tilesetContext(studio, projectId, input.tilesetRevisionId);
  const [cols, rows] = input.size;
  if (tileset.kind === "corner") {
    const ts = tileset.payload as CornerTilesetPayload;
    return emptyCornerMap({ size: input.size, cellSize: ts.cellSize, tilesetRevisionId: tileset.revisionId, tileset: ts, seed: input.seed, walkable: input.walkable });
  }
  const base = { size: input.size, seed: input.seed, units: { cell: "cell", offset: "px", polygon: "px" } as const, objects: [], collisions: [], regions: [], entrances: [], passages: [] };
  if (tileset.kind === "sidescroller") {
    const ts = tileset.payload as SideTilesetPayload;
    // Chão inicial: as duas linhas de baixo sólidas.
    const solid = Array.from({ length: cols * rows }, (_, i) => (Math.floor(i / cols) >= rows - 2 ? 1 : 0)) as (0 | 1)[];
    const { resolved } = resolveSideMap(solid, input.size, ts);
    return TilemapPayload.parse({ ...base, projection: "side", cellSize: ts.cellSize, terrain: { mode: "side", tilesetRevisionId: tileset.revisionId, rule: "side-v1", solid, resolved } });
  }
  const ts = tileset.payload as IsoTilesetPayload;
  const floor = ts.pieces.find((p) => p.kind === "floor")?.pieceKey ?? null;
  return TilemapPayload.parse({
    ...base,
    projection: "isometric",
    cellSize: ts.groundDiamondSize,
    terrain: { mode: "isometric", tilesetRevisionId: tileset.revisionId, rule: "iso-v1", cells: Array.from({ length: cols * rows }, () => ({ pieceKey: floor, elevation: 0 })) },
  });
}

export function createTilemap(studio: Studio, projectId: string, raw: z.input<typeof CreateMapInput>) {
  const input = CreateMapInput.parse(raw);
  const payload = initialMap(studio, projectId, input);
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "tilemap", name: input.name });
  const draft = saveDraft(studio.db, studio.clock, { projectId, assetId: asset.id, expectedVersion: 0, payload });
  return { asset, draft };
}

/** Abre o rascunho (padrão) ou uma revisão publicada, com o contexto para desenhar: tileset, objetos e catálogo disponível. */
export function openTilemap(studio: Studio, projectId: string, assetId: string, opts: { revisionId?: string } = {}) {
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "tilemap") throw new DomainFailure("validation_failed", "O asset não é um mapa");
  const revisions = listRevisions(studio.db, projectId, assetId);
  const draft = getDraft(studio.db, projectId, assetId);
  let payload: unknown;
  let source: { kind: "draft"; version: number } | { kind: "revision"; revisionId: string; number: number };
  if (opts.revisionId) {
    const rev = revisions.find((r) => r.id === opts.revisionId);
    if (!rev) throw new DomainFailure("not_found", "Revisão não pertence a este mapa");
    payload = rev.payload;
    source = { kind: "revision", revisionId: rev.id, number: rev.number };
  } else if (draft) {
    payload = draft.payload;
    source = { kind: "draft", version: draft.version };
  } else if (revisions[0]) {
    payload = revisions[0].payload;
    source = { kind: "revision", revisionId: revisions[0].id, number: revisions[0].number };
  } else {
    throw new DomainFailure("not_found", "Mapa sem rascunho nem revisão");
  }
  const map = TilemapPayload.parse(payload);
  const ctx = mapContext(studio, projectId, map);
  // Catálogo para o editor: objetos de mapa e revisões de tileset do mesmo tipo (trocar numa cópia).
  const available = {
    objects: listAssets(studio.db, projectId, { family: "map" })
      .filter((a) => a.kind === "object")
      .flatMap((a) => listRevisions(studio.db, projectId, a.id).filter((r) => r.status !== "rejected").map((r) => objectContext(studio, projectId, r.id))),
    tilesets: listAssets(studio.db, projectId, { family: "tileset" })
      .filter((a) => a.kind === ctx.tileset.kind)
      .flatMap((a) => listRevisions(studio.db, projectId, a.id).filter((r) => r.status !== "rejected").map((r) => ({ revisionId: r.id, name: a.name, number: r.number, status: r.status }))),
  };
  return {
    asset,
    source,
    draftVersion: draft?.version ?? 0,
    payload: map,
    tileset: ctx.tileset,
    objects: ctx.objects,
    available,
    revisions: revisions.map((r) => ({ id: r.id, number: r.number, status: r.status, createdAt: r.createdAt, technicalReport: r.technicalReport })),
  };
}

export const PublishMapInput = z.strictObject({
  payload: z.unknown(),
  /** Publica mesmo com passagem exigida interrompida (fica registrado no relatório). */
  allowBrokenPassages: z.boolean().default(false),
});

export function publishTilemap(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof PublishMapInput>) {
  const input = PublishMapInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "tilemap") throw new DomainFailure("validation_failed", "O asset não é um mapa");
  const parsed = TilemapPayload.safeParse(input.payload);
  if (!parsed.success) {
    throw new DomainFailure("validation_failed", "Mapa inválido", { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })) });
  }
  const ctx = mapContext(studio, projectId, parsed.data);
  const { map, missing } = resolveTerrain(parsed.data, ctx.tileset);
  const passages = checkPassages(map, passageContext(ctx));
  const broken = passages.results.filter((p) => !p.connected);
  if (passages.supported && broken.length > 0 && !input.allowBrokenPassages) {
    throw new DomainFailure("validation_failed", `Passagem interrompida: ${broken.map((b) => `${b.from} → ${b.to} (${b.reason})`).join("; ")}`, {
      passages: passages.results.map((p) => ({ from: p.from, to: p.to, connected: p.connected, reason: p.reason ?? null })),
    });
  }
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload: map,
    files: [],
    technicalReport: {
      operation: "tilemap_publish",
      tileset: { revisionId: ctx.tileset.revisionId, name: ctx.tileset.name, number: ctx.tileset.number, status: ctx.tileset.status },
      missing,
      passagesSupported: passages.supported,
      passages: passages.results.map(({ path, ...rest }) => ({ ...rest, pathLength: path.length })),
      blockedCells: passages.blocked?.filter(Boolean).length ?? null,
      warnings: [
        ...(missing.length ? [`Terreno usa casos ausentes no tileset: ${missing.join(", ")}`] : []),
        ...(ctx.tileset.status !== "approved" ? [`Tileset ${ctx.tileset.name} r${ctx.tileset.number} ainda não aprovado: o pacote só exporta revisões aprovadas`] : []),
        ...broken.map((b) => `Passagem ${b.from} → ${b.to} interrompida: ${b.reason}`),
      ],
    },
  });
  return { revision, passages: passages.results.map(({ path, ...rest }) => ({ ...rest, pathLength: path.length })), missing };
}

export const CopyMapInput = z.strictObject({
  revisionId: Id,
  name: z.string().trim().min(1).max(120),
  /** Outra revisão de tileset do mesmo tipo: o traçado e as colocações são mantidos, só o resolvido muda. */
  tilesetRevisionId: Id.optional(),
});

export function copyTilemap(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof CopyMapInput>) {
  const input = CopyMapInput.parse(raw);
  const source = getRevision(studio.db, projectId, input.revisionId);
  if (source.assetId !== assetId) throw new DomainFailure("validation_failed", "A revisão pertence a outro mapa");
  let map = TilemapPayload.parse(source.payload);
  if (input.tilesetRevisionId) {
    map = { ...map, terrain: { ...map.terrain, tilesetRevisionId: input.tilesetRevisionId } } as TilemapPayload;
    map = resolveTerrain(map, mapContext(studio, projectId, map).tileset).map;
  }
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "map", kind: "tilemap", name: input.name });
  const draft = saveDraft(studio.db, studio.clock, { projectId, assetId: asset.id, expectedVersion: 0, payload: map });
  return { asset, draft };
}
