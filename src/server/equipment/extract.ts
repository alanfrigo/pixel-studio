import { z } from "zod";
import { type ClipPayload, CoverageZone, Id, type OverlayPayload, ProtectZone, Slug } from "@/contracts";
import { defaultDrawIndex } from "@/domain/equipment/template";
import { type LocalizedText, tx } from "@/i18n/locales";
import { createAsset, getAsset, getBlob, getProject, getRevision, getUpload, publishRevision, type PublishFile } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { blobOf, loadOverlay, loadRig } from "./load";
import { reuseFiles } from "./overlays";
import { coverageTemplate } from "./plans";
import { dataUrl, runEquipmentPython, storeOutput, uniqueFiles } from "./python";

/**
 * Extração local de cobertura (04 §criar uma roupa, item 4; zero chamadas
 * pagas): a partir de QUALQUER candidato vestido com os mesmos frames e a
 * mesma célula do clipe alvo — o clipe vestido da operação "transferir roupa"
 * (S3, `character/clip` com estado `outfit_*`), imagens importadas por frame ou
 * o candidato da própria rota de geração. A peça é a diferença contra a base
 * limpa dentro da zona autorizada, fora das proteções; a base limpa nunca é
 * substituída. Publica uma revisão CANDIDATA da peça.
 */

export const ExtractInput = z.strictObject({
  /** Clipe limpo (aprovado) que recebe a cobertura. */
  targetClipRevisionId: Id,
  source: z.discriminatedUnion("kind", [
    /** Clipe vestido: mesmos IDs de frame e mesmo tamanho lógico do alvo. */
    z.strictObject({ kind: z.literal("clip"), clipRevisionId: Id }),
    /** Uma imagem importada por frame, na célula do alvo. */
    z.strictObject({ kind: z.literal("uploads"), frames: z.array(z.strictObject({ frameId: Id, uploadId: Id })).min(1).max(64) }),
  ]),
  overlayRevisionId: Id.nullable().default(null),
  item: z.strictObject({ name: z.string().trim().min(1).max(120), slots: z.array(Slug).min(1).max(4), stances: z.array(Slug).min(1).max(8) }).optional(),
  parts: z.array(Slug).min(1).max(8),
  frameIds: z.array(Id).max(64).optional(),
  zones: z.array(CoverageZone).max(512).optional(),
  protect: z.array(ProtectZone).max(512).optional(),
  growZonePx: z.number().int().min(0).max(8).default(1),
  tolerance: z.number().int().min(0).max(128).default(24),
});
export type ExtractInput = z.input<typeof ExtractInput>;

export async function extractCoverage(studio: Studio, projectId: string, raw: ExtractInput) {
  const input = ExtractInput.parse(raw);
  const target = getRevision(studio.db, projectId, input.targetClipRevisionId);
  const targetAsset = getAsset(studio.db, projectId, target.assetId);
  if (targetAsset.family !== "character" || targetAsset.kind !== "clip") throw new DomainFailure("validation_failed", tx(`${targetAsset.name} não é um clipe`, `${targetAsset.name} is not a clip`));
  if (target.status !== "approved") throw new DomainFailure("source_not_approved", tx(`Aprove a animação limpa (${targetAsset.name} r${target.number}) antes de extrair coberturas`, `Approve the clean animation (${targetAsset.name} r${target.number}) before extracting coverage`));
  const clip = target.payload as ClipPayload;
  if (!clip.rigRevisionId) throw new DomainFailure("validation_failed", tx("O clipe alvo não tem rig de equipamento", "The target clip has no equipment rig"));
  const rig = loadRig(studio.db, projectId, clip.rigRevisionId);
  const base = input.overlayRevisionId ? loadOverlay(studio.db, projectId, input.overlayRevisionId) : null;
  if (base && base.payload.rigRevisionId !== rig.ref.revisionId) throw new DomainFailure("validation_failed", tx(`${base.name} foi feita para outra base`, `${base.name} was made for another base`));
  const slots = base?.payload.slots ?? input.item?.slots;
  const stances = base?.payload.stances ?? input.item?.stances;
  if (!slots || !stances) throw new DomainFailure("validation_failed", tx("Peça nova precisa de nome, slots e posturas", "A new piece needs a name, slots and stances"));
  for (const p of input.parts) if (!rig.ref.payload.parts.some((x) => x.partId === p)) throw new DomainFailure("validation_failed", tx(`Parte ${p} não existe no rig`, `Part ${p} does not exist in the rig`));

  const frameIds = input.frameIds?.length ? input.frameIds : clip.frames.map((f) => f.frameId);
  const [cw, ch] = clip.logicalSize;

  // ---- candidatos por frame ----
  const candidates: { frameId: string; sha256: string }[] = [];
  let sourceLabel: LocalizedText;
  if (input.source.kind === "clip") {
    const dressedRev = getRevision(studio.db, projectId, input.source.clipRevisionId);
    const dressed = dressedRev.payload as ClipPayload;
    const dressedName = getAsset(studio.db, projectId, dressedRev.assetId).name;
    if (dressed.logicalSize[0] !== cw || dressed.logicalSize[1] !== ch) {
      throw new DomainFailure("validation_failed", tx(`O clipe vestido tem célula ${dressed.logicalSize.join("×")}; o alvo tem ${cw}×${ch}`, `The dressed clip has a ${dressed.logicalSize.join("×")} cell; the target has ${cw}×${ch}`));
    }
    const missing = frameIds.filter((f) => !dressed.frames.some((x) => x.frameId === f));
    if (missing.length) throw new DomainFailure("validation_failed", tx(`O clipe vestido não tem os frames ${missing.join(", ")} do alvo`, `The dressed clip lacks the target frames ${missing.join(", ")}`));
    const composed = await composeFrames(studio, dressedRev.id, dressed, frameIds);
    candidates.push(...composed);
    const outfit = dressed.state?.startsWith("outfit_");
    sourceLabel = tx(`clipe vestido ${dressedName} r${dressedRev.number}${outfit ? " (transferir roupa)" : ""}`, `dressed clip ${dressedName} r${dressedRev.number}${outfit ? " (outfit transfer)" : ""}`);
  } else {
    for (const f of input.source.frames) {
      if (!frameIds.includes(f.frameId)) continue;
      const upload = getUpload(studio.db, projectId, f.uploadId);
      if (upload.status !== "ready" || upload.modality !== "raster") throw new DomainFailure("validation_failed", tx(`O upload de ${f.frameId} precisa ser uma imagem já importada`, `The upload for ${f.frameId} must be an already imported image`));
      const sha = upload.normalizedSha256 ?? upload.sha256;
      const { width, height } = (getBlob(studio.db, sha)?.metadata ?? {}) as { width?: number; height?: number };
      if (width !== cw || height !== ch) throw new DomainFailure("validation_failed", tx(`A imagem de ${f.frameId} tem ${width}×${height}; a célula do clipe é ${cw}×${ch} (sem reescala implícita)`, `The image for ${f.frameId} is ${width}×${height}; the clip cell is ${cw}×${ch} (no implicit rescaling)`));
      candidates.push({ frameId: f.frameId, sha256: sha });
    }
    sourceLabel = tx("imagens importadas", "imported images");
  }
  const usable = frameIds.filter((f) => candidates.some((c) => c.frameId === f));
  if (usable.length === 0) throw new DomainFailure("validation_failed", tx("Nenhum frame do alvo tem candidato", "No target frame has a candidate"));

  // ---- base limpa, gabarito e extração ----
  const baseFrames = await composeFrames(studio, target.id, clip, usable);
  const template = await coverageTemplate(studio, projectId, {
    rig: rig.ref,
    slots,
    base: base?.payload ?? null,
    baseRevisionId: base?.revisionId ?? null,
    cells: usable.map((frameId) => ({ clipRevisionId: target.id, frameId })),
    parts: input.parts,
    zones: input.zones,
    protect: input.protect,
    grow: input.growZonePx,
  });
  const inputs = [...baseFrames.map((f) => ({ role: "layer" as const, sha256: f.sha256 })), ...usable.map((f) => ({ role: "candidate" as const, sha256: candidates.find((c) => c.frameId === f)!.sha256 }))];
  const run = await runEquipmentPython(studio, "equipment_extract", inputs, {
    cell: clip.logicalSize,
    frames: usable.map((frameId, i) => ({
      frameId,
      baseOrdinal: i,
      candidateOrdinal: baseFrames.length + i,
      candidateRect: [0, 0, cw, ch],
      parts: input.parts.map((partId) => ({ partId, zones: template.zones.find((z) => z.frameId === frameId && z.partId === partId)!.rects })),
      protect: template.protect.find((p) => p.frameId === frameId)?.rects ?? [],
    })),
    tolerance: input.tolerance,
    alphaThreshold: 128,
    maxShift: 2,
    minComponentPx: 2,
  });

  // ---- publicação ----
  const payload: OverlayPayload = base ? structuredClone(base.payload) : { itemRevisionId: null, rigRevisionId: rig.ref.revisionId, slots, stances, parts: [], rigidViews: [] };
  const files: PublishFile[] = base ? reuseFiles(studio.db, base.revision, "equipment", "overlay", base.payload) : [];
  const reportFrames = run.report.frames as { frameId: string; shift: [number, number]; parts: { partId: string; empty: boolean; rect: [number, number, number, number] | null; offset: [number, number] | null; pixels: number }[] }[];
  const assetLabel = targetAsset.name.replace(/[^A-Za-z0-9]+/g, "-").toLowerCase().slice(0, 40);
  const previews: Record<string, string> = {};
  for (const f of reportFrames) {
    for (const p of f.parts) {
      if (p.empty) continue;
      const out = run.outputs.find((o) => o.role === "layer" && o.key === `${f.frameId}|${p.partId}`)!;
      const blob = await storeOutput(studio.blobs, out);
      const fileKey = `ext-${assetLabel}-r${target.number}-${f.frameId}-${p.partId}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 120);
      files.push({ fileKey, role: "coverage", idx: files.length, blob });
      let entry = payload.parts.find((x) => x.partId === p.partId);
      if (!entry) payload.parts.push((entry = { partId: p.partId, coverage: [] }));
      const frame = clip.frames.find((x) => x.frameId === f.frameId)!;
      entry.coverage = [
        ...entry.coverage.filter((c) => !(c.clipRevisionId === target.id && c.frameId === f.frameId)),
        { clipRevisionId: target.id, frameId: f.frameId, layer: { fileId: fileKey, rect: p.rect!, offset: p.offset! }, drawIndex: defaultDrawIndex(p.partId, frame) },
      ];
    }
    const preview = run.outputs.find((o) => o.role === "preview" && o.key === f.frameId);
    if (preview) previews[f.frameId] = dataUrl(preview.bytes);
  }
  if (payload.parts.length === 0) throw new DomainFailure("validation_failed", tx("Nada da peça foi encontrado dentro das zonas: revise o gabarito ou o candidato", "Nothing of the piece was found inside the zones: review the template or the candidate"), { report: run.report, warnings: run.warnings });

  let assetId = base?.assetId;
  if (!assetId) {
    if (!input.item) throw new DomainFailure("validation_failed", tx("Peça nova precisa de nome", "A new piece needs a name"));
    assetId = createAsset(studio.db, studio.clock, { projectId, family: "equipment", kind: "overlay", name: input.item.name }).id;
  }
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    payload,
    origin: "local_process",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    ...(base ? { predecessorId: base.revisionId, edges: [{ toRevisionId: base.revisionId, role: "source", ordinal: 0, runtime: false }] } : {}),
    files: uniqueFiles(files),
    technicalReport: {
      operation: "extract_coverage",
      providerCalls: 0,
      source: sourceLabel,
      sourceRevisionId: input.source.kind === "clip" ? input.source.clipRevisionId : null,
      targetClipRevisionId: target.id,
      note: tx(
        "Candidato vestido → diferença contra a base limpa dentro da zona autorizada; mãos e o resto da base protegidos",
        "Dressed candidate → difference against the clean base inside the authorized zone; hands and the rest of the base protected",
      ),
      frames: reportFrames,
      warnings: run.warnings,
      estimatedZones: template.estimated,
    },
  });
  return { revision, report: reportFrames, warnings: [...template.warnings, ...run.warnings], previews };
}

/** Composição das camadas de um clipe (todas) por frame, com os blobs vinculados à revisão. */
async function composeFrames(studio: Studio, revisionId: string, clip: ClipPayload, frameIds: readonly string[]) {
  const inputs: { role: "layer"; sha256: string }[] = [];
  const ordinal = new Map<string, number>();
  const frames = frameIds.map((frameId) => {
    const frame = clip.frames.find((f) => f.frameId === frameId)!;
    return {
      frameId,
      layers: frame.layers.map((l, i) => {
        const sha = blobOf(studio.db, revisionId, l.fileId);
        if (!ordinal.has(sha)) {
          ordinal.set(sha, inputs.length);
          inputs.push({ role: "layer", sha256: sha });
        }
        return { key: `base:${i}`, inputOrdinal: ordinal.get(sha)!, rect: l.rect, offset: l.offset, mirrored: false };
      }),
    };
  });
  const run = await runEquipmentPython(studio, "equipment_compose", inputs, { cell: clip.logicalSize, frames, tolerancePx: 1 });
  const out: { frameId: string; sha256: string }[] = [];
  for (const o of run.outputs.filter((x) => x.role === "frame")) {
    const stored = await studio.blobs.putBytes(o.bytes);
    out.push({ frameId: o.key!, sha256: stored.sha256 });
  }
  return out;
}
