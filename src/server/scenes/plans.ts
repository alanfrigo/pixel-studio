import { z } from "zod";
import {
  type Capability,
  type GenerationPlan,
  Id,
  type PlanSource,
  ProjectionKind,
  ROOM_PROJECTIONS,
  ROOM_TILE_SIZES,
  RoomFloorPlan,
  RoomPayload,
  SCENE_LAYER_DEPTHS,
  type StylePayload,
} from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { floorPlanProblems, fullFloorPlan, roomGrid } from "@/domain/scenes/room";
import { getAsset, getProject, getRevision, getStyleRevision, type RevisionView } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { getProfileRow } from "../providers/registry";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { compileMapObjectPrompt, compileRoomPrompt, compileScenePrompt, MAP_OBJECT_ROUTE_LABEL, ROOM_GUIDE_COLORS, ROOM_ROUTE_LABELS, SCENE_ROUTE_LABELS } from "./core";

/**
 * Planos do cartão T2 (`POST /generation-plans`): capacidade, fontes, limites
 * e custo conferidos antes de qualquer cobrança. Cada resposta diz qual rota
 * será usada e o que ela NÃO faz.
 */

const Language = z.enum(["pt-BR", "en"]).optional();

function context(studio: Studio, projectId: string, profileId: string) {
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", "Projeto sem estilo ativo");
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(profileId);
  const adapter = studio.providers.adapterFor(profileId);
  const profile = getProfileRow(studio.db, profileId);
  return { project, styleRevisionId: project.activeStyleRevisionId, style, adapter, profile };
}

function languageOf(style: StylePayload, language?: "pt-BR" | "en") {
  return language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
}

function finish(studio: Studio, plan: GenerationPlan, profile: ReturnType<typeof getProfileRow>, extra: Record<string, unknown>) {
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    ...extra,
  };
}

function requireCaps(offered: Capability[], required: Capability[], profileId: string, what: string) {
  const missing = required.filter((c) => !offered.includes(c));
  if (missing.length) throw new DomainFailure("capability_missing", `O perfil ${profileId} não ${what}: falta ${missing.join(", ")}`, { missing, offered });
}

/** Arquivo de imagem principal de uma revisão aprovada usada como referência visual. */
export function revisionImage(studio: Studio, projectId: string, revisionId: string): { revision: RevisionView; fileKey: string; sha256: string } {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", `${asset.name} r${revision.number} precisa estar aprovada`);
  const p = revision.payload as Record<string, unknown>;
  const key =
    asset.family === "map" && asset.kind === "scene"
      ? (p.image as { fileId: string }).fileId
      : asset.family === "map" && asset.kind === "room"
        ? ((p.background as { fileId: string } | null) ?? (p.picture as { fileId: string })).fileId
        : typeof p.fileId === "string"
          ? p.fileId
          : null;
  const file = key ? revision.files.find((f) => f.fileKey === key) : undefined;
  if (!file) throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} (${asset.family}/${asset.kind}) não tem imagem de referência`);
  return { revision, fileKey: file.fileKey, sha256: file.sha256 };
}

// ---------------------------------------------------------------------------
// Cena plana / plano de paralaxe
// ---------------------------------------------------------------------------

export const ScenePlanInput = z.strictObject({
  operation: z.literal("generate_scene"),
  providerProfileId: Id,
  brief: z.string().trim().min(1).max(1000),
  composition: z.string().trim().max(500).default(""),
  lighting: z.string().trim().max(200).default(""),
  requiredElements: z.array(z.string().trim().min(1).max(200)).max(8).default([]),
  projection: ProjectionKind.default("side"),
  logicalSize: z.tuple([z.number().int().min(32).max(512), z.number().int().min(32).max(512)]).default([240, 160]),
  /** Presente = gera UM plano de paralaxe (cada plano é gerado separadamente). */
  layer: z.strictObject({ name: z.string().trim().min(1).max(64), depth: z.enum(SCENE_LAYER_DEPTHS), repeatX: z.boolean().default(true), transparent: z.boolean().default(true) }).optional(),
  referenceRevisionIds: z.array(Id).max(4).default([]),
  variants: z.number().int().min(1).max(4).default(1),
  language: Language,
});
export type ScenePlanInput = z.input<typeof ScenePlanInput>;

export function buildScenePlan(studio: Studio, projectId: string, raw: ScenePlanInput) {
  const input = ScenePlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const sources: PlanSource[] = input.referenceRevisionIds.map((id, ordinal) => {
    const ref = revisionImage(studio, projectId, id);
    return { ordinal, revisionId: id, fileId: ref.fileKey, sha256: ref.sha256, role: "style" };
  });
  const offered = adapter.capabilities("generate_scene");
  const transparent = Boolean(input.layer?.transparent);
  const alpha = transparent && offered.includes("alpha_output");
  const key = transparent && !alpha ? chooseKeyColor(style.palette.colors.map((c) => c.hex)) : null;
  const required: Capability[] = ["text_to_image", ...(sources.length ? (["image_references"] as const) : []), ...(alpha ? (["alpha_output"] as const) : [])];
  requireCaps(offered, required, input.providerProfileId, "gera cena com estas entradas");
  const maxRefs = adapter.limits?.("generate_scene").maxReferences;
  if (maxRefs !== undefined && sources.length > maxRefs) throw new DomainFailure("capability_missing", `O perfil aceita até ${maxRefs} referências`);
  const language = languageOf(style, input.language);
  const prompt = compileScenePrompt({
    language,
    brief: input.brief,
    composition: input.composition,
    lighting: input.lighting,
    requiredElements: input.requiredElements,
    projection: input.projection,
    size: input.logicalSize,
    style,
    references: sources.length,
    layer: input.layer,
    backgroundKey: key,
    alpha,
  });
  const unit = input.layer ? "layer" : "scene";
  const parts = Array.from({ length: input.variants }, (_, i) => ({ partKey: `image:${unit}-${i + 1}`, unit: "image" as const, label: `${input.layer ? `Plano ${input.layer.name}` : "Cena"} · candidata ${i + 1}` }));
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_scene",
    styleRevisionId,
    recipeRevisionId: input.layer ? "builtin-scene-layer-v1" : "builtin-scene-flat-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.brief, compiled: prompt, language },
    sources,
    requiredCapabilities: required,
    parts,
    limits: { maxSubmissions: parts.length, costCeiling: null, estimate: adapter.estimate("generate_scene", parts.length) },
    params: {
      logicalSize: input.logicalSize,
      projection: input.projection,
      outputKind: input.layer ? "layers" : "flat_image",
      requiredElements: input.requiredElements,
      composition: input.composition,
      lighting: input.lighting,
      ...(input.layer ? { layer: input.layer, backgroundKey: key } : {}),
    },
  };
  return finish(studio, plan, profile, {
    routeLabel: input.layer ? SCENE_ROUTE_LABELS.layer : SCENE_ROUTE_LABELS.flat,
    targetKind: input.layer ? "scene_layer" : "scene",
    transparency: transparent ? (alpha ? "alfa nativo da rota" : "fundo de cor-chave removido localmente") : "opaco",
  });
}

// ---------------------------------------------------------------------------
// Sala
// ---------------------------------------------------------------------------

const DoorInput = z.strictObject({ doorId: Id, cell: z.tuple([z.number().int().min(0).max(6), z.number().int().min(0).max(5)]), side: z.enum(["N", "E", "S", "W"]) });

export const RoomPlanInput = z.strictObject({
  operation: z.literal("generate_room"),
  providerProfileId: Id,
  theme: z.string().trim().min(3).max(300),
  projection: z.enum(ROOM_PROJECTIONS).default("top_down"),
  tileSize: z.number().int().refine((v) => (ROOM_TILE_SIZES as readonly number[]).includes(v), { message: "tile_size: 16, 24, 32, 48 ou 64" }).default(32),
  floorPlan: RoomFloorPlan.default(fullFloorPlan()),
  doors: z.array(DoorInput).min(1).max(8),
  /** Sala aprovada do mesmo edifício (mesma vista e escala), enviada como referência visual. */
  styleRoomRevisionId: Id.nullable().default(null),
  language: Language,
});
export type RoomPlanInput = z.input<typeof RoomPlanInput>;

export function buildRoomPlan(studio: Studio, projectId: string, raw: RoomPlanInput) {
  const input = RoomPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const problems = floorPlanProblems(input.floorPlan, input.doors);
  if (problems.length) throw new DomainFailure("validation_failed", problems[0]!.message, { problems });
  const offered = adapter.capabilities("generate_room");
  const required: Capability[] = ["text_to_image", "image_references"];
  requireCaps(offered, required, input.providerProfileId, "aceita a planta como referência raster");
  const sources: PlanSource[] = [];
  if (input.styleRoomRevisionId) {
    const rev = getRevision(studio.db, projectId, input.styleRoomRevisionId);
    const asset = getAsset(studio.db, projectId, rev.assetId);
    if (asset.family !== "map" || asset.kind !== "room") throw new DomainFailure("validation_failed", "A sala de estilo precisa ser uma sala (map/room)");
    if (rev.status !== "approved") throw new DomainFailure("source_not_approved", `${asset.name} r${rev.number} precisa estar aprovada para servir de estilo`);
    const styleRoom = RoomPayload.parse(rev.payload);
    if (styleRoom.projection !== input.projection) throw new DomainFailure("validation_failed", `A sala de estilo é ${styleRoom.projection}; a nova é ${input.projection} (mesma vista exigida)`);
    if (styleRoom.tileSize !== input.tileSize) throw new DomainFailure("validation_failed", `Escalas diferentes: tile ${styleRoom.tileSize} × ${input.tileSize} (mesma escala para portas se encontrarem)`);
    const ref = revisionImage(studio, projectId, rev.id);
    sources.push({ ordinal: 0, revisionId: rev.id, fileId: ref.fileKey, sha256: ref.sha256, role: "style" });
  }
  const language = languageOf(style, input.language);
  const grid = roomGrid(input.projection, input.tileSize, input.floorPlan.size);
  const key = chooseKeyColor([...style.palette.colors.map((c) => c.hex), ROOM_GUIDE_COLORS.floor, ROOM_GUIDE_COLORS.wall, ROOM_GUIDE_COLORS.door]);
  const compiled = compileRoomPrompt({ language, theme: input.theme, projection: input.projection, pictureSize: grid.pictureSize, cellPx: grid.cellPx, colors: { ...ROOM_GUIDE_COLORS, rock: key }, doors: input.doors.length, style, styleReferences: sources.length });
  const maxRefs = adapter.limits?.("generate_room").maxReferences;
  if (maxRefs !== undefined && sources.length + 1 > maxRefs) throw new DomainFailure("capability_missing", `A guia da planta + ${sources.length} referência(s) excede o limite de ${maxRefs}`);
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_room",
    styleRevisionId,
    recipeRevisionId: "builtin-room-guide-v1",
    providerProfileId: input.providerProfileId,
    prompt: { brief: input.theme, compiled, language },
    sources,
    requiredCapabilities: required,
    parts: [{ partKey: "image:room", unit: "image", label: `Sala (${input.projection})` }],
    limits: { maxSubmissions: 1, costCeiling: null, estimate: adapter.estimate("generate_room", 1) },
    params: {
      theme: input.theme,
      floorPlan: input.floorPlan,
      doors: input.doors,
      projection: input.projection,
      tileSize: input.tileSize,
      styleRoomRevisionId: input.styleRoomRevisionId,
      guide: { pictureSize: grid.pictureSize, cellPx: grid.cellPx, gridOrigin: grid.gridOrigin, backgroundKey: key },
    },
  };
  return finish(studio, plan, profile, {
    routeLabel: ROOM_ROUTE_LABELS.generic,
    grid,
    restrictions: [
      ...(input.projection === "oblique" ? ["Oblíqua: só paredes, portas e piso; sem móveis a extrair"] : []),
      "Móveis saem depois por recorte local revisado (máscara explícita); a área exposta é reconstruída por inpainting (E1)",
      ...(input.projection === "top_down" && input.tileSize !== 32 ? [`Top-down: a imagem usa células de 32 px; o tile_size ${input.tileSize} fica declarado como escala da sala`] : []),
    ],
  });
}

// ---------------------------------------------------------------------------
// Prop independente
// ---------------------------------------------------------------------------

export const MapObjectPlanInput = z.strictObject({
  operation: z.literal("generate_map_object"),
  providerProfileId: Id,
  brief: z.string().trim().min(1).max(1000),
  projection: z.enum(["top_down", "three_quarter", "side"]).default("top_down"),
  logicalSize: z.tuple([z.number().int().min(16).max(400), z.number().int().min(16).max(400)]).default([64, 64]),
  variants: z.number().int().min(1).max(4).default(1),
  language: Language,
});
export type MapObjectPlanInput = z.input<typeof MapObjectPlanInput>;

export function buildMapObjectPlan(studio: Studio, projectId: string, raw: MapObjectPlanInput) {
  const input = MapObjectPlanInput.parse(raw);
  const { styleRevisionId, style, adapter, profile } = context(studio, projectId, input.providerProfileId);
  const offered = adapter.capabilities("generate_map_object");
  const alpha = offered.includes("alpha_output");
  const key = alpha ? null : chooseKeyColor(style.palette.colors.map((c) => c.hex));
  const required: Capability[] = ["text_to_image", ...(alpha ? (["alpha_output"] as const) : [])];
  requireCaps(offered, required, input.providerProfileId, "gera props");
  const language = languageOf(style, input.language);
  const parts = Array.from({ length: input.variants }, (_, i) => ({ partKey: `image:object-${i + 1}`, unit: "image" as const, label: `Prop · candidata ${i + 1}` }));
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_map_object",
    styleRevisionId,
    recipeRevisionId: "builtin-map-object-image-v1",
    providerProfileId: input.providerProfileId,
    prompt: {
      brief: input.brief,
      compiled: compileMapObjectPrompt({ language, brief: input.brief, projection: input.projection, size: input.logicalSize, style, backgroundKey: key, alpha }),
      language,
    },
    sources: [],
    requiredCapabilities: required,
    parts,
    limits: { maxSubmissions: parts.length, costCeiling: null, estimate: adapter.estimate("generate_map_object", parts.length) },
    params: { logicalSize: input.logicalSize, projection: input.projection, transparent: true, backgroundKey: key, variants: input.variants },
  };
  return finish(studio, plan, profile, { routeLabel: MAP_OBJECT_ROUTE_LABEL });
}

/** Registro no `POST /generation-plans` (ver `plan-builders.ts`). */
export const SCENE_PLAN_BUILDERS = [
  { operation: "generate_scene", input: ScenePlanInput, build: (studio: Studio, projectId: string, body: never) => buildScenePlan(studio, projectId, body) },
  { operation: "generate_room", input: RoomPlanInput, build: (studio: Studio, projectId: string, body: never) => buildRoomPlan(studio, projectId, body) },
  { operation: "generate_map_object", input: MapObjectPlanInput, build: (studio: Studio, projectId: string, body: never) => buildMapObjectPlan(studio, projectId, body) },
] as const;
