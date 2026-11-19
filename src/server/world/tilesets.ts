import { z } from "zod";
import {
  type CornerTilesetPayload,
  DEFAULT_SIDE_REQUIRED,
  type GenerationPlan,
  HexColor,
  Id,
  type IsoTilesetPayload,
  missingSideConfigurations,
  parseRevisionPayload,
  Rect,
  SIDE_CONFIGURATIONS,
  SideConfiguration,
  type SideTilesetPayload,
  Size,
  Slug,
  TexturePayload,
} from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { type LocalizedText, tx } from "@/i18n/locales";
import { type BlobRecord, getAsset, getProject, getRevision, getStyleRevision, publishRevision, type RevisionView } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { inpaintMarkColor } from "../inpaint";
import { getProfileRow } from "../providers/registry";
import { ImageRef } from "../services";
import type { Studio } from "../studio";
import { dataUrl, outputOf, runWorldPython, storeOutput, type WorldRun } from "./python";
import { resolveImageRef, textureSource } from "./textures";
import { type AnyTilesetPayload, checkTilesetAtlas, compileTilesetPrompt, geometryOf, guideUpscale, ROUTE_LABELS, type TilesetKind } from "./tileset-core";

/**
 * Tilesets do T1 (06 §autotile, §cobertura lateral, §payload isométrico):
 * gabaritos locais a partir de texturas aprovadas, importação com layout
 * declarado, verificação de emendas/losangos e geração guiada com rota
 * identificada. Cada caminho deixa o rótulo da rota no relatório técnico.
 */

const TerrainIn = z.strictObject({ terrainId: Slug, name: z.string().trim().min(1).max(64), color: HexColor });

export const TilesetTemplateInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("corner"),
    materialA: Id,
    materialB: Id,
    terrains: z.tuple([TerrainIn, TerrainIn]),
    projection: z.enum(["top_down", "three_quarter"]).default("top_down"),
    diagonals: z.strictObject({ mask5: z.enum(["connected", "separate"]), mask10: z.enum(["connected", "separate"]) }).default({ mask5: "separate", mask10: "separate" }),
    bandPx: z.number().int().min(1).max(8).default(4),
    seed: z.number().int().min(0).max(1_000_000).default(1),
  }),
  z.strictObject({
    kind: z.literal("sidescroller"),
    body: Id,
    surface: Id,
    requiredConfigurations: z.array(SideConfiguration).min(1).default([...DEFAULT_SIDE_REQUIRED]),
    /** Configurações desenhadas no gabarito (padrão: a tabela inteira). Omitir uma deixa a lacuna visível. */
    configurations: z.array(SideConfiguration).min(1).default([...SIDE_CONFIGURATIONS]),
    surfaceDepthPx: z.number().int().min(1).max(64).optional(),
  }),
  z.strictObject({
    kind: z.literal("isometric"),
    floor: Id,
    diamond: Size.default([64, 32]),
    blockHeightPx: z.number().int().min(0).max(128).default(16),
    prop: z
      .strictObject({
        image: ImageRef,
        name: z.string().trim().min(1).max(64),
        /** Omitido: base visual do prop (linha opaca mais baixa), medida localmente. */
        supportPoint: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
        occluderRect: Rect.nullable().default(null),
        blocksMovement: z.boolean().default(true),
      })
      .nullable()
      .default(null),
  }),
]);
export type TilesetTemplateInput = z.input<typeof TilesetTemplateInput>;

function assertTilesetAsset(studio: Studio, projectId: string, assetId: string, kind: TilesetKind) {
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "tileset" || asset.kind !== kind) throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; esperado tileset/${kind}`, `The asset is ${asset.family}/${asset.kind}; expected tileset/${kind}`));
  return asset;
}

function atlasOf(revision: RevisionView, payload: AnyTilesetPayload) {
  const file = revision.files.find((f) => f.fileKey === payload.atlas.fileId);
  if (!file) throw new DomainFailure("not_found", tx(`Atlas ${payload.atlas.fileId} ausente na revisão`, `Atlas ${payload.atlas.fileId} is missing from the revision`));
  const { width, height } = file.metadata as { width?: number; height?: number };
  return { file, size: [width ?? 0, height ?? 0] as [number, number] };
}

const PREVIEW_ROLES = ["sample", "sample_zoom", "pairs", "patch", "patch_zoom"] as const;

/** Prévias da verificação guardadas como arquivos auxiliares da revisão (não entram no payload). */
async function previewFiles(studio: Studio, check: WorldRun, startIdx = 1) {
  const files = [];
  let idx = startIdx;
  for (const role of PREVIEW_ROLES) {
    const out = check.outputs.find((o) => o.role === role);
    if (out) files.push({ fileKey: `check-${role.replace("_", "-")}`, role: "preview", idx: idx++, blob: await storeOutput(studio, out) });
  }
  return files;
}

/** Gabarito local: 16 máscaras (cantos), tabela lateral ou peças isométricas, a partir de texturas aprovadas. */
export async function buildTilesetTemplate(studio: Studio, projectId: string, assetId: string, raw: TilesetTemplateInput) {
  const input = TilesetTemplateInput.parse(raw);
  assertTilesetAsset(studio, projectId, assetId, input.kind);
  const styleRevisionId = getProject(studio.db, projectId).activeStyleRevisionId;
  let payload: AnyTilesetPayload;
  let guides: WorldRun;
  const sources: { revisionId: string }[] = [];
  const extra: { fileKey: string; role: string; idx: number; blob: BlobRecord }[] = [];
  let label: LocalizedText;

  if (input.kind === "corner") {
    const a = textureSource(studio, projectId, input.materialA);
    const b = textureSource(studio, projectId, input.materialB);
    if (a.size[0] !== b.size[0] || a.size[1] !== b.size[1]) {
      throw new DomainFailure(
        "validation_failed",
        tx(
          `As texturas têm tamanhos diferentes (${a.size.join("×")} e ${b.size.join("×")}); a célula usa o tamanho delas`,
          `The textures have different sizes (${a.size.join("×")} and ${b.size.join("×")}); the cell uses their size`,
        ),
      );
    }
    if (input.terrains[0].terrainId === input.terrains[1].terrainId) throw new DomainFailure("validation_failed", tx("Os dois terrenos devem ser distintos", "The two terrains must be different"));
    const cell = a.size;
    guides = await runWorldPython(studio, "corner_guides", [{ role: "layer", sha256: a.sha256 }, { role: "layer", sha256: b.sha256 }], {
      cellSize: cell,
      diagonals: input.diagonals,
      bandPx: input.bandPx,
      seed: input.seed,
    });
    const report = guides.report as { tiles: { mask: number; rect: [number, number, number, number] }[] };
    const slug = `${input.terrains[0].terrainId}-${input.terrains[1].terrainId}`;
    payload = {
      projection: input.projection,
      cellSize: cell,
      atlas: { fileId: "atlas", margin: 0, spacing: 0 },
      terrains: input.terrains,
      diagonals: input.diagonals,
      tiles: report.tiles.map((t) => ({ tileKey: `${slug}-${t.mask}`, mask: t.mask, variant: 0, weight: 1, rect: t.rect, frames: [] })),
      complete: report.tiles.length === 16,
    } satisfies CornerTilesetPayload;
    sources.push({ revisionId: input.materialA }, { revisionId: input.materialB });
    extra.push({ fileKey: "terrain-map", role: "preview", idx: 0, blob: await storeOutput(studio, outputOf(guides, "terrain")) });
    label = ROUTE_LABELS.corner_template;
  } else if (input.kind === "sidescroller") {
    const body = textureSource(studio, projectId, input.body);
    const surface = textureSource(studio, projectId, input.surface);
    const cell = body.size;
    const depth = input.surfaceDepthPx ?? Math.max(2, Math.round(cell[1] / 4));
    guides = await runWorldPython(studio, "side_guides", [{ role: "layer", sha256: body.sha256 }, { role: "layer", sha256: surface.sha256 }], {
      cellSize: cell,
      configurations: input.configurations,
      surfaceDepthPx: depth,
      columns: Math.min(6, input.configurations.length),
    });
    const report = guides.report as { tiles: { configuration: SideConfiguration; rect: [number, number, number, number] }[]; walkableLineY: number };
    const material = (rev: RevisionView) => TexturePayload.parse(rev.payload).material;
    payload = {
      projection: "side",
      cellSize: cell,
      atlas: { fileId: "atlas", margin: 0, spacing: 0 },
      platformMaterial: material(body.revision),
      surfaceMaterial: material(surface.revision),
      walkableLineY: report.walkableLineY,
      requiredConfigurations: input.requiredConfigurations,
      tiles: report.tiles.map((t) => ({ tileKey: `side-${t.configuration}`, configuration: t.configuration, variant: 0, weight: 1, rect: t.rect, frames: [] })),
      complete: missingSideConfigurations(input.requiredConfigurations, report.tiles.map((t) => t.configuration)).length === 0,
    } satisfies SideTilesetPayload;
    sources.push({ revisionId: input.body }, { revisionId: input.surface });
    label = ROUTE_LABELS.side_template;
  } else {
    const floor = textureSource(studio, projectId, input.floor);
    const [dw, dh] = input.diamond;
    if (dw % 2 || dh % 2) throw new DomainFailure("validation_failed", tx("Losango deve ter largura e altura pares", "The diamond must have even width and height"));
    const prop = input.prop ? resolveImageRef(studio, projectId, input.prop.image) : null;
    guides = await runWorldPython(
      studio,
      "iso_pieces",
      [{ role: "layer", sha256: floor.sha256 }, ...(prop ? [{ role: "layer", sha256: prop.sha256 }] : [])],
      { diamond: input.diamond, blockHeightPx: input.blockHeightPx },
    );
    const report = guides.report as {
      pieces: { key: string; kind: "floor" | "block" | "prop"; rect: [number, number, number, number]; groundOrigin?: [number, number]; supportPoint?: [number, number]; visualBase?: [number, number] | null }[];
    };
    const pieces: IsoTilesetPayload["pieces"] = [];
    for (const p of report.pieces) {
      const size: [number, number] = [p.rect[2], p.rect[3]];
      if (p.kind === "prop") {
        const sp = input.prop!.supportPoint ?? p.visualBase;
        if (!sp) throw new DomainFailure("validation_failed", tx("Prop sem pixels visíveis: não há base para o apoio", "The prop has no visible pixels: there is no base for the support point"));
        if (sp[0] > size[0] || sp[1] > size[1]) throw new DomainFailure("validation_failed", tx("Ponto de apoio fora da imagem do prop", "Support point is outside the prop image"));
        if (sp[1] < dh / 2) throw new DomainFailure("validation_failed", tx("Apoio do prop alto demais: o losango do footprint sairia da imagem", "The prop support point is too high: the footprint diamond would leave the image"));
        pieces.push({
          pieceKey: "prop",
          kind: "prop",
          name: input.prop!.name,
          rect: p.rect,
          logicalSize: size,
          supportPoint: sp,
          // Vértice superior do losango do footprint 1×1: meio losango acima do apoio.
          groundOrigin: [sp[0], sp[1] - dh / 2],
          footprintCells: [1, 1],
          elevation: 0,
          occluderRect: input.prop!.occluderRect,
          blocksMovement: input.prop!.blocksMovement,
        });
        continue;
      }
      if (p.kind === "block" && input.blockHeightPx === 0) continue;
      pieces.push({
        pieceKey: p.key,
        kind: p.kind,
        name: p.kind === "floor" ? "Chão" : "Bloco (degrau)",
        rect: p.rect,
        logicalSize: size,
        groundOrigin: p.groundOrigin!,
        supportPoint: p.supportPoint!,
        footprintCells: [1, 1],
        elevation: p.kind === "block" ? 1 : 0,
        occluderRect: null,
        blocksMovement: p.kind === "block",
      });
    }
    payload = {
      projection: "isometric",
      groundDiamondSize: input.diamond,
      logicalCellSize: [dw / 2, dw / 2],
      elevationStepPx: input.blockHeightPx || dh / 2,
      sortRule: "depth_ij_elevation_v1",
      atlas: { fileId: "atlas", margin: 0, spacing: 0 },
      pieces,
    } satisfies IsoTilesetPayload;
    sources.push({ revisionId: input.floor });
    if (input.prop?.image.from === "revision") sources.push({ revisionId: input.prop.image.revisionId });
    label = ROUTE_LABELS.iso_template;
  }

  const atlasOut = outputOf(guides, "atlas");
  const atlas = await storeOutput(studio, atlasOut);
  const check = await checkTilesetAtlas(studio, input.kind, payload, atlas.sha256);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "composition",
    styleRevisionId,
    payload,
    files: [{ fileKey: "atlas", role: "atlas", idx: 0, blob: atlas }, ...extra, ...(await previewFiles(studio, check, extra.length))],
    edges: sources.map((s, ordinal) => ({ toRevisionId: s.revisionId, role: "material", ordinal, runtime: false })),
    technicalReport: { operation: "tileset_template", kind: input.kind, routeLabel: label, guides: guides.report, check: check.report, warnings: [...guides.warnings, ...check.warnings] },
  });
  return { revision, check: { report: check.report, warnings: check.warnings }, routeLabel: label };
}

// ---------------------------------------------------------------------------
// Importação com layout declarado
// ---------------------------------------------------------------------------

export const TilesetImportInput = z.strictObject({
  image: ImageRef,
  /** Payload do tipo do asset; `atlas.fileId` é reescrito para o arquivo importado. */
  payload: z.record(z.string(), z.unknown()),
});

export async function importTileset(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof TilesetImportInput>) {
  const input = TilesetImportInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "tileset") throw new DomainFailure("validation_failed", tx("Importação de atlas é para assets de tileset", "Atlas import is for tileset assets"));
  const image = resolveImageRef(studio, projectId, input.image);
  const candidate = { ...input.payload, atlas: { margin: 0, spacing: 0, ...((input.payload.atlas as object) ?? {}), fileId: "atlas" } };
  const parsed = parseRevisionPayload(asset.family, asset.kind, candidate);
  if (!parsed.success) throw new DomainFailure("validation_failed", tx("Layout declarado não confere com o tipo do tileset", "The declared layout does not match the tileset type"), { issues: parsed.issues.slice(0, 20) });
  const payload = parsed.entry.payload as AnyTilesetPayload;
  const check = await checkTilesetAtlas(studio, asset.kind as TilesetKind, payload, image.sha256);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "import",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [{ fileKey: "atlas", role: "atlas", idx: 0, blob: image }, ...(await previewFiles(studio, check, 0))],
    technicalReport: { operation: "tileset_import", kind: asset.kind, routeLabel: ROUTE_LABELS.import, check: check.report, warnings: check.warnings },
  });
  return { revision, check: { report: check.report, warnings: check.warnings } };
}

// ---------------------------------------------------------------------------
// Verificação sob demanda (bancada do tileset)
// ---------------------------------------------------------------------------

export async function checkTilesetRevision(studio: Studio, projectId: string, revisionId: string, opts: { threshold?: number } = {}) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "tileset") throw new DomainFailure("validation_failed", tx("A revisão não é de um tileset", "The revision is not a tileset"));
  const payload = revision.payload as AnyTilesetPayload;
  const { file } = atlasOf(revision, payload);
  const guide = (revision.technicalReport as { guide?: { sha256: string; lockedBandPx: number } } | null)?.guide;
  const check = await checkTilesetAtlas(studio, asset.kind as TilesetKind, payload, file.sha256, {
    ...(guide ? { guideSha: guide.sha256, lockedBandPx: guide.lockedBandPx } : {}),
    ...(opts.threshold ? { threshold: opts.threshold } : {}),
  });
  return {
    kind: asset.kind,
    report: check.report,
    warnings: check.warnings,
    previews: Object.fromEntries(check.outputs.map((o) => [o.role, dataUrl(o)])),
  };
}

// ---------------------------------------------------------------------------
// Geração guiada (generate_tileset)
// ---------------------------------------------------------------------------

export const TilesetPlanInput = z.strictObject({
  operation: z.literal("generate_tileset"),
  providerProfileId: Id,
  /** Revisão aprovada do gabarito, no mesmo asset que recebe o resultado. */
  guideRevisionId: Id,
  instruction: z.string().trim().min(1).max(500),
  lockedBandPx: z.number().int().min(0).max(8).default(4),
  /** Texturas aprovadas enviadas como referência de material, em ordem. */
  materialRevisionIds: z.array(Id).max(3).default([]),
  language: z.enum(["pt-BR", "en"]).optional(),
});
export type TilesetPlanInput = z.input<typeof TilesetPlanInput>;

export function buildTilesetPlan(studio: Studio, projectId: string, raw: TilesetPlanInput) {
  const input = TilesetPlanInput.parse(raw);
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", tx("Projeto sem estilo ativo", "Project has no active style"));
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(input.providerProfileId);
  const adapter = studio.providers.adapterFor(input.providerProfileId);
  const guide = getRevision(studio.db, projectId, input.guideRevisionId);
  if (guide.status !== "approved") throw new DomainFailure("source_not_approved", tx(`O gabarito r${guide.number} precisa estar aprovado`, `Template r${guide.number} must be approved`));
  const asset = getAsset(studio.db, projectId, guide.assetId);
  if (asset.family !== "tileset") throw new DomainFailure("validation_failed", tx("O gabarito precisa ser uma revisão de tileset", "The template must be a tileset revision"));
  const kind = asset.kind as TilesetKind;
  const payload = guide.payload as AnyTilesetPayload;
  const { file, size } = atlasOf(guide, payload);
  const band = kind === "isometric" ? 0 : input.lockedBandPx;
  const required = ["image_references", "image_edit"] as const;
  const offered = adapter.capabilities("generate_tileset");
  const missing = required.filter((c) => !offered.includes(c));
  if (missing.length) {
    throw new DomainFailure(
      "capability_missing",
      tx(
        `O perfil ${input.providerProfileId} não edita a partir de um gabarito (${missing.join(", ")}); geração nativa de tileset não está disponível neste perfil`,
        `Provider profile ${input.providerProfileId} cannot edit from a template (${missing.join(", ")}); native tileset generation is not available in this profile`,
      ),
      { missing, offered },
    );
  }
  const materials = input.materialRevisionIds.map((id) => textureSource(studio, projectId, id));
  const maxRefs = adapter.limits?.("generate_tileset").maxReferences;
  if (maxRefs !== undefined && 1 + materials.length > maxRefs) throw new DomainFailure("capability_missing", tx(`O perfil aceita até ${maxRefs} referências; o pedido tem ${1 + materials.length}`, `The provider profile accepts up to ${maxRefs} references; the request has ${1 + materials.length}`));
  const language = input.language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
  const guideRef = { revisionId: guide.id, atlasSize: size, lockedBandPx: band, geometry: geometryOf(kind, payload) };
  const params: Extract<GenerationPlan, { operation: "generate_tileset" }>["params"] =
    kind === "corner"
      ? {
          layout: "corner",
          projection: (payload as CornerTilesetPayload).projection,
          cellSize: (payload as CornerTilesetPayload).cellSize,
          terrainPair: [(payload as CornerTilesetPayload).terrains[0].terrainId, (payload as CornerTilesetPayload).terrains[1].terrainId],
          guide: guideRef,
        }
      : kind === "sidescroller"
        ? {
            layout: "sidescroller",
            cellSize: (payload as SideTilesetPayload).cellSize,
            platformMaterial: (payload as SideTilesetPayload).platformMaterial,
            surfaceMaterial: (payload as SideTilesetPayload).surfaceMaterial,
            requiredConfigurations: (payload as SideTilesetPayload).requiredConfigurations,
            guide: guideRef,
          }
        : { layout: "isometric", diamond: (payload as IsoTilesetPayload).groundDiamondSize, guide: guideRef };
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_tileset",
    styleRevisionId: project.activeStyleRevisionId,
    recipeRevisionId: `builtin-tileset-guided-${kind}-v1`,
    providerProfileId: input.providerProfileId,
    prompt: {
      brief: input.instruction,
      compiled: compileTilesetPrompt({
        kind,
        language,
        brief: input.instruction,
        payload,
        atlasSize: size,
        scale: guideUpscale(size),
        materials: materials.map((m) => TexturePayload.parse(m.revision.payload).material),
        keyColor: inpaintMarkColor(style),
        style,
      }),
      language,
    },
    sources: [
      { ordinal: 0, revisionId: guide.id, fileId: file.fileKey, sha256: file.sha256, role: "base" },
      ...materials.map((m, i) => ({ ordinal: i + 1, revisionId: m.revision.id, fileId: m.fileKey, sha256: m.sha256, role: "material" as const })),
    ],
    requiredCapabilities: [...required],
    parts: [{ partKey: "tileset:atlas", unit: "tileset", label: "Atlas guiado pelo gabarito" }],
    limits: { maxSubmissions: 1, costCeiling: null, estimate: adapter.estimate("generate_tileset", 1) },
    params,
  };
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  const profile = getProfileRow(studio.db, input.providerProfileId);
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    routeLabel: ROUTE_LABELS.guided,
    targetAssetId: asset.id,
  };
}

