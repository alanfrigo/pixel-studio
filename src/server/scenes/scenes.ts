import { z } from "zod";
import { BasePayload, Direction, Id, NonNegInt, ProjectionKind, SCENE_LAYER_DEPTHS, SceneLayerPayload, ScenePayload, Slug } from "@/contracts";
import { cameraSpan, layerLeavesGap } from "@/domain/scenes/parallax";
import { getAsset, getProject, getRevision, getUpload, insertUpload, markUploadReady, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { ImageRef, resolveLocalInput } from "../services";
import type { Studio } from "../studio";
import { resolveImageRef } from "../world/textures";
import { dataUrl, outputOf, runWorldPython, storeOutput } from "../world/python";
import { SCENE_ROUTE_LABELS } from "./core";
import { LAYER_SEAM_THRESHOLD, layerCheckPayload, layerVerdict, runLayerCheck } from "./layer-check";
import { carryFiles, fileBlob } from "./revision-files";

/**
 * Casos de uso da cena ilustrada (cartão T2): bancada e publicação de planos
 * (importado ou derivado de imagem plana com máscara revisada), composição da
 * cena em camadas com teste da câmera, e revisão com personagem em escala e
 * pontos de apoio anotados. Uma cena não vira mapa: sem colisões nem objetos.
 */

function sceneRevision(studio: Studio, projectId: string, revisionId: string, kind: "scene" | "scene_layer") {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "map" || asset.kind !== kind) throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} não é ${kind === "scene" ? "uma cena" : "um plano de paralaxe"}`);
  return { revision, asset };
}

// ---------------------------------------------------------------------------
// Planos de paralaxe
// ---------------------------------------------------------------------------

export const LayerCheckInput = z.strictObject({ image: ImageRef, repeatX: z.boolean().default(true), groundLineY: NonNegInt.nullable().default(null), ground: z.boolean().default(false) });

export async function checkSceneLayer(studio: Studio, projectId: string, raw: z.input<typeof LayerCheckInput>) {
  const input = LayerCheckInput.parse(raw);
  const image = resolveImageRef(studio, projectId, input.image);
  const check = await runLayerCheck(studio, image.sha256, { x: input.repeatX, y: false }, input.ground, input.groundLineY);
  return { report: check.report, warnings: check.warnings, verdict: layerVerdict(check.report, { x: input.repeatX, y: false }), previews: { mosaicLines: dataUrl(check.outputs.find((o) => o.role === "mosaic_lines")!) } };
}

export const PublishLayerInput = z.strictObject({
  image: ImageRef,
  depth: z.enum(SCENE_LAYER_DEPTHS),
  repeatX: z.boolean().default(true),
  groundLineY: NonNegInt.nullable().default(null),
  /**
   * Correção da emenda (bancada, como a textura do T1): a imagem vem do
   * inpainting da faixa central do plano deslocado; desfaz o deslocamento
   * cíclico de meia largura antes de medir a continuidade.
   */
  unshift: z.boolean().default(false),
  /** Revisão de origem quando a imagem é uma correção (proveniência). */
  sourceRevisionId: Id.optional(),
  /** Plano derivado de uma imagem plana: origem, máscara revisada e tratamento das áreas antes ocultas. */
  derivation: z
    .strictObject({
      sourceRevisionId: Id,
      maskUploadId: Id,
      hiddenAreas: z.enum(["reconstructed_inpaint", "transparent_reviewed"]),
      inpaintRevisionId: Id.nullable().default(null),
    })
    .optional(),
});

export async function publishSceneLayer(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof PublishLayerInput>) {
  const input = PublishLayerInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "scene_layer") throw new DomainFailure("validation_failed", `O asset é ${asset.family}/${asset.kind}; esperado map/scene_layer`);
  let image: ReturnType<typeof fileBlob> = resolveImageRef(studio, projectId, input.image);
  if (input.unshift) {
    // Meia largura de novo devolve a orientação original (largura par): a emenda corrigida volta às bordas.
    const back = await runWorldPython(studio, "texture_seams", [{ role: "source", sha256: image.sha256 }], { axes: { x: true, y: false }, threshold: LAYER_SEAM_THRESHOLD, zoom: 1 });
    image = await storeOutput(studio, outputOf(back, "shifted"));
  }
  const ground = input.depth === "ground" || input.groundLineY !== null;
  const check = await runLayerCheck(studio, image.sha256, { x: input.repeatX, y: false }, ground, input.groundLineY);
  let derivation: SceneLayerPayload["derivation"] = null;
  let mask = null;
  if (input.derivation) {
    const d = input.derivation;
    const source = sceneRevision(studio, projectId, d.sourceRevisionId, "scene");
    if (ScenePayload.parse(source.revision.payload).outputKind !== "flat_image") throw new DomainFailure("validation_failed", "Derivação de planos parte de uma imagem plana");
    if (d.hiddenAreas === "reconstructed_inpaint") {
      if (!d.inpaintRevisionId) throw new DomainFailure("validation_failed", "Área reconstruída cita a revisão de inpainting (E1)");
      assertInpaintOf(studio, projectId, d.inpaintRevisionId, source.revision, d.maskUploadId);
    }
    const upload = getUpload(studio.db, projectId, d.maskUploadId);
    if (upload.status !== "ready") throw new DomainFailure("validation_failed", "Máscara ainda não importada");
    mask = fileBlob(studio.db, upload.normalizedSha256 ?? upload.sha256);
    const { width: mw, height: mh } = mask.metadata as { width: number; height: number };
    derivation = { sourceRevisionId: d.sourceRevisionId, mask: { fileId: "mask", rect: [0, 0, mw, mh] }, hiddenAreas: d.hiddenAreas, inpaintRevisionId: d.hiddenAreas === "reconstructed_inpaint" ? d.inpaintRevisionId : null };
  }
  const obtained = derivation ? "derived_local_reviewed" : "imported";
  const payload = layerCheckPayload(check.report, { fileId: "layer", depth: input.depth, obtained, requested: { x: input.repeatX, y: false }, derivation, groundFromCheck: ground });
  const previews = [];
  for (const [idx, out] of check.outputs.entries()) previews.push({ fileKey: out.role.replaceAll("_", "-"), role: "preview", idx, blob: await storeOutput(studio, out) });
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: derivation ? "local_process" : input.image.from === "upload" ? "import" : "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [{ fileKey: "layer", role: "layer", idx: 0, blob: image }, ...(mask ? [{ fileKey: "mask", role: "mask", idx: 0, blob: mask }] : []), ...previews],
    ...(input.image.from === "revision" && !derivation ? { edges: [{ toRevisionId: input.image.revisionId, role: "source", ordinal: 0, runtime: false }] } : {}),
    technicalReport: {
      operation: "scene_layer",
      routeLabel: derivation ? SCENE_ROUTE_LABELS.layerDerived : input.unshift ? SCENE_ROUTE_LABELS.layerSeamFixed : SCENE_ROUTE_LABELS.layerImport,
      ...(input.sourceRevisionId ? { correctedFrom: input.sourceRevisionId } : {}),
      verdict: layerVerdict(check.report, { x: input.repeatX, y: false }),
      check: check.report,
      warnings: check.warnings,
      ...(derivation
        ? { hiddenAreas: derivation.hiddenAreas === "reconstructed_inpaint" ? "Área antes oculta reconstruída por inpainting (E1) a partir da imagem plana" : "Plano recortado pela máscara revisada; fora dela é transparente (nada estava atrás dentro deste plano)" }
        : {}),
    },
  });
  return { revision, report: check.report, verdict: layerVerdict(check.report, { x: input.repeatX, y: false }) };
}

/**
 * Bancada da emenda do plano (06 §repetição verificável, mesmo fluxo da
 * textura do T1): publica a etapa deslocada de meia largura (sem prometer
 * repetição) e a máscara da faixa central, onde a emenda ficou, para o
 * inpainting (E1). Depois, publicar com `unshift` desfaz o deslocamento.
 */
export const ShiftLayerInput = z.strictObject({ layerRevisionId: Id, bandPx: z.number().int().min(1).max(32).default(6) });

export async function shiftLayerForSeam(studio: Studio, projectId: string, raw: z.input<typeof ShiftLayerInput>) {
  const input = ShiftLayerInput.parse(raw);
  const { revision, asset } = sceneRevision(studio, projectId, input.layerRevisionId, "scene_layer");
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", `Aprove ${asset.name} r${revision.number} antes de corrigir a emenda`);
  const payload = SceneLayerPayload.parse(revision.payload);
  const [w, h] = payload.logicalSize;
  if (w % 2 !== 0) throw new DomainFailure("validation_failed", "O deslocamento de meia largura exige largura par");
  const file = revision.files.find((f) => f.fileKey === payload.fileId)!;
  const run = await runWorldPython(studio, "texture_seams", [{ role: "source", sha256: file.sha256 }], { axes: { x: true, y: false }, threshold: LAYER_SEAM_THRESHOLD, zoom: 1 });
  const shifted = await storeOutput(studio, outputOf(run, "shifted"));
  // Faixa central × pixels visíveis: a transparência do plano fica protegida pelo E1.
  const band = Math.min(input.bandPx, Math.floor(w / 4));
  const mask = await runWorldPython(studio, "tile_edit_mask", [{ role: "source", sha256: shifted.sha256 }], { regions: [{ rect: [w / 2 - band, 0, 2 * band, h], bandPx: 0 }], alphaEdgePx: 0 });
  const maskBlob = await storeOutput(studio, outputOf(mask, "edit_mask"));
  const maskUpload = registerMaskUpload(studio, projectId, maskBlob, `emenda-${revision.id}.png`, { layerRevisionId: revision.id, bandPx: band });
  const step = SceneLayerPayload.parse({ ...payload, requestedRepeat: { x: false, y: false }, repeat: { x: false, y: false }, continuity: { x: null, y: null } });
  const next = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "local_process",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload: step,
    files: [{ fileKey: payload.fileId, role: "layer", idx: 0, blob: shifted }],
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "layer_seam_shift",
      label: "Etapa de correção: deslocado meia largura para trazer a emenda ao centro (não usar na cena; não promete repetição)",
      bandPx: band,
    },
  });
  return { revision: next, maskUploadId: maskUpload.id, inpaint: { sourceRevisionId: next.id, sourceFileKey: payload.fileId }, previews: { shifted: dataUrl(outputOf(run, "shifted")) } };
}

/** A revisão é o inpainting (E1) da fonte com exatamente esta máscara? Apagar o alfa não conta. */
export function assertInpaintOf(studio: Studio, projectId: string, inpaintRevisionId: string, source: RevisionView, maskUploadId: string) {
  const inpaint = getRevision(studio.db, projectId, inpaintRevisionId);
  const report = inpaint.technicalReport as { operation?: string } | null;
  if (inpaint.assetId !== source.assetId || inpaint.predecessorId !== source.id || report?.operation !== "inpaint") {
    throw new DomainFailure("validation_failed", "A revisão citada não é um inpainting (E1) desta fonte");
  }
  if (inpaint.status !== "approved") throw new DomainFailure("source_not_approved", "Revise e aprove o inpainting (área antes oculta) antes de usá-lo");
  const upload = getUpload(studio.db, projectId, maskUploadId);
  const maskFile = inpaint.files.find((f) => f.fileKey === "inpaint-mask");
  if (!maskFile || maskFile.sha256 !== (upload.normalizedSha256 ?? upload.sha256)) throw new DomainFailure("validation_failed", "O inpainting não usou a máscara desta área");
  return inpaint;
}

/** Recorte de um plano a partir de uma imagem plana aprovada: o plano recortado e a máscara da área para o E1. */
export const CutLayerInput = z.strictObject({ sceneRevisionId: Id, maskUploadId: Id, dilatePx: z.number().int().min(0).max(8).default(1) });

export async function cutSceneLayer(studio: Studio, projectId: string, raw: z.input<typeof CutLayerInput>) {
  const input = CutLayerInput.parse(raw);
  const { revision } = sceneRevision(studio, projectId, input.sceneRevisionId, "scene");
  const scene = ScenePayload.parse(revision.payload);
  if (scene.outputKind !== "flat_image") throw new DomainFailure("validation_failed", "Recorte de plano parte de uma imagem plana");
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", "Aprove a imagem plana antes de derivar planos");
  const file = revision.files.find((f) => f.fileKey === scene.image.fileId)!;
  const maskSha = resolveLocalInput(studio, projectId, { kind: "upload", uploadId: input.maskUploadId });
  const run = await runWorldPython(studio, "room_cutout", [{ role: "source", sha256: file.sha256 }, { role: "editMask", sha256: maskSha }], { dilatePx: input.dilatePx, contextRingPx: 2, alphaThreshold: 128 });
  const area = await storeOutput(studio, outputOf(run, "area_mask"));
  const areaUpload = registerMaskUpload(studio, projectId, area, `area-${revision.id}.png`, { sceneRevisionId: revision.id });
  const piece = await storeOutput(studio, outputOf(run, "piece"));
  const report = run.report as { pieceRect: [number, number, number, number]; needsReconstruction: boolean; contextOpaque: number };
  return {
    report,
    warnings: run.warnings,
    layer: { uploadSha256: piece.sha256, offset: [report.pieceRect[0], report.pieceRect[1]] as [number, number] },
    pieceUploadId: registerMaskUpload(studio, projectId, piece, `plano-${revision.id}.png`, { derivedFrom: revision.id }).id,
    areaMaskUploadId: areaUpload.id,
    inpaint: { sourceRevisionId: revision.id, sourceFileKey: scene.image.fileId },
    previews: { piece: dataUrl(outputOf(run, "piece")), area: dataUrl(outputOf(run, "area_preview")) },
    label: "Derivação local revisada: o plano recortado fica com o que a máscara marcou; o fundo atrás dele nunca foi pintado e é reconstruído por inpainting (E1)",
  };
}

/** Saída local registrada como upload pronto (máscara/peça usada como entrada de outra etapa, ex.: E1). */
export function registerMaskUpload(studio: Studio, projectId: string, blob: ReturnType<typeof fileBlob>, name: string, metadata: Record<string, unknown>) {
  const upload = insertUpload(studio.db, studio.clock, { projectId, originalName: name, blob, expiresAt: null });
  markUploadReady(studio.db, studio.clock, upload.id, blob, { ...blob.metadata, ...metadata, origin: "local_process" });
  return getUpload(studio.db, projectId, upload.id);
}

// ---------------------------------------------------------------------------
// Cena em camadas
// ---------------------------------------------------------------------------

const LayerPlacementInput = z.strictObject({
  layerId: Slug,
  name: z.string().trim().min(1).max(64),
  layerRevisionId: Id,
  offset: z.tuple([z.number().int(), z.number().int()]).default([0, 0]),
  parallax: z.strictObject({ x: z.number().min(0).max(4), y: z.number().min(0).max(4) }),
  repeat: z.strictObject({ x: z.boolean(), y: z.boolean() }).default({ x: true, y: false }),
});

export const ComposeSceneInput = z.strictObject({
  projection: ProjectionKind.default("side"),
  logicalSize: z.tuple([z.number().int().min(32).max(1024), z.number().int().min(32).max(1024)]),
  /** Trás → frente. */
  layers: z.array(LayerPlacementInput).min(2).max(16),
  groundLineY: NonNegInt.nullable().default(null),
  steps: z.number().int().min(2).max(32).default(8),
});

async function composeRun(studio: Studio, projectId: string, input: z.output<typeof ComposeSceneInput>) {
  const layers = input.layers.map((l) => {
    const { revision, asset } = sceneRevision(studio, projectId, l.layerRevisionId, "scene_layer");
    if (revision.status !== "approved") throw new DomainFailure("source_not_approved", `Aprove o plano ${asset.name} r${revision.number} antes de compor (cada plano é revisado à parte)`);
    const payload = SceneLayerPayload.parse(revision.payload);
    for (const axis of ["x", "y"] as const) {
      if (l.repeat[axis] && !payload.repeat[axis]) {
        throw new DomainFailure("validation_failed", `${asset.name} r${revision.number} não é repetível em ${axis}: a emenda ${payload.requestedRepeat[axis] ? "foi reprovada" : "não foi pedida"}`);
      }
    }
    const file = revision.files.find((f) => f.fileKey === payload.fileId)!;
    return { input: l, payload, sha256: file.sha256, name: asset.name };
  });
  const geometry = layers.map((l) => ({ size: l.payload.logicalSize, offset: l.input.offset, parallax: l.input.parallax, repeat: l.input.repeat }));
  const span = Math.min(8192, cameraSpan(geometry, input.logicalSize));
  const gaps = layers.filter((_, i) => layerLeavesGap(geometry[i]!, span, input.logicalSize)).map((l) => l.input.name);
  const run = await runWorldPython(
    studio,
    "scene_compose",
    layers.map((l) => ({ role: "layer", sha256: l.sha256 })),
    { canvas: input.logicalSize, layers: layers.map((l, i) => ({ inputOrdinal: i, offset: l.input.offset, parallax: l.input.parallax, repeat: l.input.repeat })), spanPx: span, steps: input.steps, groundLineY: input.groundLineY, zoom: 1 },
  );
  const report = run.report as { spanPx: number; steps: number; uncoveredFrames: number; groundContinuous: boolean | null; frames: { camera: number; uncoveredPixels: number; groundGaps: number | null }[] };
  const continuityOk = layers.every((l) => (!l.input.repeat.x || l.payload.continuity.x?.passed) && (!l.input.repeat.y || l.payload.continuity.y?.passed));
  // Loop: planos repetidos sem emenda reprovada, nenhum quadro com buraco e nenhum plano saindo da tela.
  const cameraTest = { spanPx: Math.max(1, report.spanPx), steps: report.steps, uncoveredFrames: report.uncoveredFrames, loopPassed: continuityOk && report.uncoveredFrames === 0 && gaps.length === 0, groundContinuous: report.groundContinuous };
  return { run, layers, report, cameraTest, gaps };
}

/** Prévia da câmera deslocando por duas larguras do fundo (sem publicar). */
export async function previewScene(studio: Studio, projectId: string, raw: z.input<typeof ComposeSceneInput>) {
  const input = ComposeSceneInput.parse(raw);
  const { run, report, cameraTest, gaps } = await composeRun(studio, projectId, input);
  return { report, cameraTest, warnings: [...run.warnings, ...gaps.map((g) => `${g}: sem repetição, sai da tela durante a rolagem`)], previews: { image: dataUrl(outputOf(run, "image")), strip: dataUrl(outputOf(run, "strip")) } };
}

export async function composeScene(studio: Studio, projectId: string, assetId: string, raw: z.input<typeof ComposeSceneInput>) {
  const input = ComposeSceneInput.parse(raw);
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "map" || asset.kind !== "scene") throw new DomainFailure("validation_failed", `O asset é ${asset.family}/${asset.kind}; esperado map/scene`);
  const { run, report, cameraTest, gaps } = await composeRun(studio, projectId, input);
  const image = await storeOutput(studio, outputOf(run, "image"));
  const strip = await storeOutput(studio, outputOf(run, "strip"));
  const [w, h] = input.logicalSize;
  const payload = ScenePayload.parse({
    outputKind: "layers",
    projection: input.projection,
    logicalSize: [w, h],
    image: { fileId: "image", rect: [0, 0, w, h] },
    layers: input.layers,
    supportPoints: [],
    characterScale: null,
    groundLineY: input.groundLineY,
    editable: { map: false, collisions: false, objects: false },
    cameraTest,
  });
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    origin: "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [
      { fileKey: "image", role: "composite", idx: 0, blob: image },
      { fileKey: "camera-strip", role: "preview", idx: 0, blob: strip },
    ],
    technicalReport: {
      operation: "scene_compose",
      routeLabel: SCENE_ROUTE_LABELS.composed,
      camera: report,
      cameraTest,
      warnings: [...run.warnings, ...gaps.map((g) => `${g}: sem repetição, sai da tela durante a rolagem`)],
    },
  });
  return { revision, cameraTest, report };
}

// ---------------------------------------------------------------------------
// Revisão com personagem em escala e pontos de apoio
// ---------------------------------------------------------------------------

export const SceneReviewInput = z.strictObject({
  sceneRevisionId: Id,
  characterRevisionId: Id,
  direction: Direction.optional(),
  supportPoints: z.array(z.strictObject({ pointId: Slug, label: z.string().trim().min(1).max(64), at: z.tuple([NonNegInt, NonNegInt]) })).min(1).max(16),
});

async function overlayRun(studio: Studio, projectId: string, input: z.output<typeof SceneReviewInput>) {
  const { revision } = sceneRevision(studio, projectId, input.sceneRevisionId, "scene");
  const scene = ScenePayload.parse(revision.payload);
  const char = getRevision(studio.db, projectId, input.characterRevisionId);
  const charAsset = getAsset(studio.db, projectId, char.assetId);
  if (charAsset.family !== "character" || charAsset.kind !== "base") throw new DomainFailure("validation_failed", "O personagem de escala é uma base de personagem aprovada");
  if (char.status !== "approved") throw new DomainFailure("source_not_approved", `${charAsset.name} r${char.number} precisa estar aprovado`);
  const base = BasePayload.parse(char.payload);
  const view = base.views.find((v) => v.direction === (input.direction ?? (scene.projection === "side" ? "E" : "S"))) ?? base.views[0]!;
  const viewFile = char.files.find((f) => f.fileKey === view.fileId)!;
  const sceneFile = revision.files.find((f) => f.fileKey === scene.image.fileId)!;
  for (const p of input.supportPoints) {
    if (p.at[0] > scene.logicalSize[0] || p.at[1] > scene.logicalSize[1]) throw new DomainFailure("validation_failed", `Ponto ${p.pointId} fora da cena`);
  }
  const run = await runWorldPython(studio, "scene_overlay", [{ role: "source", sha256: sceneFile.sha256 }, { role: "layer", sha256: viewFile.sha256 }], {
    points: input.supportPoints.map((p) => p.at),
    character: { logicalSize: base.logicalSize, rect: view.rect, offset: view.sourceOffset, pivot: base.groundOrigin },
    zoom: 3,
  });
  return { run, revision, scene, view, charAsset, char };
}

export async function overlaySceneCharacter(studio: Studio, projectId: string, raw: z.input<typeof SceneReviewInput>) {
  const input = SceneReviewInput.parse(raw);
  const { run, view } = await overlayRun(studio, projectId, input);
  return { report: run.report, view: view.direction, previews: { overlay: dataUrl(outputOf(run, "overlay")), zoom: dataUrl(outputOf(run, "overlay_zoom")) } };
}

/** Nova revisão da cena com pontos de apoio anotados e a escala revisada do personagem (a imagem não muda). */
export async function annotateScene(studio: Studio, projectId: string, raw: z.input<typeof SceneReviewInput>) {
  const input = SceneReviewInput.parse(raw);
  const { run, revision, scene, char, charAsset, view } = await overlayRun(studio, projectId, input);
  const overlay = await storeOutput(studio, outputOf(run, "overlay"));
  const height = (run.report as { characterHeightPx: number }).characterHeightPx;
  const payload = ScenePayload.parse({ ...scene, supportPoints: input.supportPoints, characterScale: { characterRevisionId: char.id, heightPx: Math.max(1, height) } });
  const next = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: revision.assetId,
    origin: "composition",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload,
    files: [...carryFiles(studio.db, revision, "map", "scene", payload, { keep: (k) => k === "raw" || k === "camera-strip" }), { fileKey: "scale-overlay", role: "scale_preview", idx: 0, blob: overlay }],
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "scene_review",
      label: `Escala revisada com ${charAsset.name} r${char.number} (vista ${view.direction}, ${height} px de altura) e ${input.supportPoints.length} ponto(s) de apoio; pontos de apoio não são colisão nem mapa`,
      supportPoints: input.supportPoints,
      outputKind: scene.outputKind,
    },
  });
  return { revision: next, report: run.report };
}
