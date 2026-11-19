import { tx } from "@/i18n/locales";
import { z } from "zod";
import { type BasePayload, type ClipPayload, Direction, DIRECTIONS_8, Id, parseRevisionPayload, type Rect, Slug } from "@/contracts";
import { type CanvasMargins, marginsAreZero, resizeBaseCanvas, resizeClipCanvas } from "@/domain/animation/canvas";
import { frameDigest, MIRROR_PAIR, mirrorGridPoint, mirrorPixel, removeFrames, removePart } from "@/domain/animation/temporal";
import { entryRefs } from "@/domain/manifest/refs";
import { failureText } from "../animation/base";
import { type AssetView, createAsset, getAsset, getRevision, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { mustBlob } from "../jobs/handlers/pipelines/shared";
import type { Studio } from "../studio";
import { iso } from "../util";
import { affectedByFrames } from "./affected";
import { runLocal } from "./local";

/**
 * Operações de biblioteca (cartão S3; 02a §rotas: "Nome/tags são metadados
 * editoriais; duplicar, separar estado, redimensionar canvas ou remover parte
 * publica revisão, preservando dependentes anteriores").
 *
 * - Etiquetar nunca cria revisão (tabela `asset_tags`).
 * - Duplicar, separar, excluir parte, espelhar e mudar o canvas publicam
 *   revisões CANDIDATAS novas; as anteriores ficam intactas, então um pacote
 *   exportado antes continua resolvendo os mesmos IDs e hashes.
 * - Nada aqui chama provedor: `providerCalls: 0`, `generated: false`.
 */

// ---------------------------------------------------------------------------
// Etiquetas (sem revisão)
// ---------------------------------------------------------------------------

export const Tag = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .transform((t) => t.toLowerCase());

export const SetTagsInput = z.strictObject({ assetId: Id, tags: z.array(Tag).max(20) });

export function assetTags(studio: Studio, projectId: string, assetId: string): string[] {
  return studio.db.all<{ tag: string }>("SELECT tag FROM asset_tags WHERE project_id = :p AND asset_id = :a ORDER BY tag", { p: projectId, a: assetId }).map((r) => r.tag);
}

/** Substitui as etiquetas do asset. Não toca revisões, arquivos nem pacotes. */
export function setAssetTags(studio: Studio, projectId: string, raw: z.input<typeof SetTagsInput>) {
  const input = SetTagsInput.parse(raw);
  getAsset(studio.db, projectId, input.assetId);
  const tags = [...new Set(input.tags)];
  const now = iso(studio.clock.now());
  studio.db.transaction(() => {
    studio.db.run("DELETE FROM asset_tags WHERE project_id = :p AND asset_id = :a", { p: projectId, a: input.assetId });
    for (const tag of tags) studio.db.run("INSERT INTO asset_tags (asset_id, project_id, tag, created_at) VALUES (:a, :p, :t, :now)", { a: input.assetId, p: projectId, t: tag, now });
  });
  return { assetId: input.assetId, tags: assetTags(studio, projectId, input.assetId) };
}

export function listTags(studio: Studio, projectId: string): { tag: string; assets: number }[] {
  return studio.db.all<{ tag: string; assets: number }>("SELECT tag, COUNT(*) AS assets FROM asset_tags WHERE project_id = :p GROUP BY tag ORDER BY tag", { p: projectId });
}

export function tagsByAsset(studio: Studio, projectId: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of studio.db.all<{ asset_id: string; tag: string }>("SELECT asset_id, tag FROM asset_tags WHERE project_id = :p ORDER BY tag", { p: projectId })) (out[row.asset_id] ??= []).push(row.tag);
  return out;
}

export function assetsWithTag(studio: Studio, projectId: string, tag: string): string[] {
  return studio.db.all<{ asset_id: string }>("SELECT asset_id FROM asset_tags WHERE project_id = :p AND tag = :t ORDER BY asset_id", { p: projectId, t: tag.toLowerCase() }).map((r) => r.asset_id);
}

// ---------------------------------------------------------------------------
// Peças comuns
// ---------------------------------------------------------------------------

function sourceOf(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (revision.status === "rejected") throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} foi reprovada; parta de uma revisão válida`, `${asset.name} r${revision.number} was rejected; start from a valid revision`));
  return { revision, asset };
}

/** Arquivos citados pelo payload, com as mesmas chaves e blobs. */
function referencedFiles(studio: Studio, asset: AssetView, revision: RevisionView, payload: unknown) {
  const parsed = parseRevisionPayload(asset.family, asset.kind, payload);
  if (!parsed.success) throw new DomainFailure("validation_failed", tx("Payload resultante não passa no schema", "Resulting payload does not match the schema"), { issues: parsed.issues.slice(0, 10) });
  const referenced = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  return revision.files.filter((f) => referenced.has(f.fileKey)).map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: mustBlob(studio.db, f.sha256) }));
}

function localReport(operation: string, extra: Record<string, unknown>) {
  return { operation, providerCalls: 0, generated: false, ...extra };
}

// ---------------------------------------------------------------------------
// Duplicar asset ou clipe
// ---------------------------------------------------------------------------

export const DuplicateInput = z.strictObject({ revisionId: Id, name: z.string().trim().min(1).max(120).optional() });

/** Asset novo com uma revisão que reaproveita payload e blobs da origem; a origem não muda. */
export function duplicateAsset(studio: Studio, projectId: string, raw: z.input<typeof DuplicateInput>) {
  const input = DuplicateInput.parse(raw);
  const { revision, asset } = sourceOf(studio, projectId, input.revisionId);
  const copy = createAsset(studio.db, studio.clock, { projectId, family: asset.family, kind: asset.kind, name: input.name ?? `${asset.name} (cópia)`.slice(0, 120) });
  const created = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: copy.id,
    origin: "composition",
    styleRevisionId: revision.styleRevisionId,
    payload: revision.payload,
    files: referencedFiles(studio, asset, revision, revision.payload),
    edges: [{ toRevisionId: revision.id, role: "duplicate_of", ordinal: 0, runtime: false }],
    technicalReport: localReport("duplicate", { fromAssetId: asset.id, fromRevisionId: revision.id }),
  });
  return { asset: copy, revision: created };
}

// ---------------------------------------------------------------------------
// Separar direções (um asset por direção)
// ---------------------------------------------------------------------------

export const UngroupInput = z.strictObject({ revisionId: Id, directions: z.array(Direction).min(1).max(8).optional() });

export function ungroupDirections(studio: Studio, projectId: string, raw: z.input<typeof UngroupInput>) {
  const input = UngroupInput.parse(raw);
  const { revision, asset } = sourceOf(studio, projectId, input.revisionId);
  if (asset.family !== "character" || asset.kind !== "base") throw new DomainFailure("validation_failed", tx("Separar direções vale para bases, objetos e estados (character/base)", "Splitting directions applies to bases, objects and states (character/base)"));
  const payload = revision.payload as BasePayload;
  const directions = input.directions ?? payload.views.map((v) => v.direction);
  const created = [];
  for (const direction of directions) {
    const view = payload.views.find((v) => v.direction === direction);
    if (!view) throw new DomainFailure("not_found", tx(`A revisão r${revision.number} não tem a vista ${direction}`, `Revision r${revision.number} has no ${direction} view`));
    const file = revision.files.find((f) => f.fileKey === view.fileId)!;
    const target = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: `${asset.name} · ${direction}`.slice(0, 120) });
    const rev = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: target.id,
      origin: "composition",
      styleRevisionId: revision.styleRevisionId,
      payload: { ...payload, views: [view] },
      files: [{ fileKey: file.fileKey, role: file.role, idx: 0, blob: mustBlob(studio.db, file.sha256) }],
      edges: [{ toRevisionId: revision.id, role: "ungrouped_from", ordinal: 0, runtime: false }],
      technicalReport: localReport("ungroup", { fromAssetId: asset.id, fromRevisionId: revision.id, direction }),
    });
    created.push({ asset: target, revision: rev });
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Excluir parte, direção ou quadro (revisão nova)
// ---------------------------------------------------------------------------

export const RemovePartInput = z.strictObject({
  revisionId: Id,
  /** Base/objeto/estado: direções a retirar. */
  directions: z.array(Direction).max(8).optional(),
  /** Clipe: quadros a retirar (evento em quadro retirado exige `eventRemap`). */
  frameIds: z.array(Id).max(256).optional(),
  /** Clipe: parte desenhável (camada) a retirar de todos os quadros. */
  partId: Slug.optional(),
  /** Evento → novo quadro, ou `null` para retirar o evento junto. */
  eventRemap: z.record(Id, Id.nullable()).optional(),
});

export function removeParts(studio: Studio, projectId: string, raw: z.input<typeof RemovePartInput>) {
  const input = RemovePartInput.parse(raw);
  const { revision, asset } = sourceOf(studio, projectId, input.revisionId);
  let payload: BasePayload | ClipPayload;
  let report: Record<string, unknown>;
  if (asset.family === "character" && asset.kind === "base") {
    const base = revision.payload as BasePayload;
    const drop = new Set(input.directions ?? []);
    if (drop.size === 0) throw new DomainFailure("validation_failed", tx("Informe as direções a retirar", "Choose the directions to remove"));
    for (const d of drop) if (!base.views.some((v) => v.direction === d)) throw new DomainFailure("not_found", tx(`A revisão não tem a vista ${d}`, `The revision has no ${d} view`));
    const views = base.views.filter((v) => !drop.has(v.direction));
    if (views.length === 0) throw new DomainFailure("validation_failed", tx("Uma base precisa de ao menos uma vista; arquive o asset em vez de retirar todas", "A base needs at least one view; archive the asset instead of removing them all"));
    payload = { ...base, views };
    report = localReport("remove_directions", { removedDirections: [...drop], keptDirections: views.map((v) => v.direction) });
  } else if (asset.family === "character" && asset.kind === "clip") {
    let clip = revision.payload as ClipPayload;
    const removed: Record<string, unknown> = {};
    try {
      if (input.frameIds?.length) {
        const result = removeFrames(clip, input.frameIds, input.eventRemap ?? {});
        clip = result.clip;
        Object.assign(removed, { removedFrames: input.frameIds, removedEvents: result.removedEvents, remappedEvents: result.remappedEvents });
      }
      if (input.partId) {
        clip = removePart(clip, input.partId);
        removed.removedPart = input.partId;
      }
    } catch (err) {
      throw new DomainFailure("validation_failed", failureText(err), { needsRemap: err instanceof RangeError && /remapeie/.test(err.message) });
    }
    if (!input.frameIds?.length && !input.partId) throw new DomainFailure("validation_failed", tx("Informe quadros ou parte a retirar", "Choose frames or a part to remove"));
    payload = clip;
    report = localReport("remove_part", { ...removed, affected: affectedByFrames(studio.db, projectId, revision.id, input.frameIds ?? []) });
  } else {
    throw new DomainFailure("validation_failed", tx(`Excluir parte vale para bases e clipes; ${asset.name} é ${asset.family}/${asset.kind}`, `Removing a part applies to bases and clips; ${asset.name} is ${asset.family}/${asset.kind}`));
  }
  const created = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "edit",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload,
    files: referencedFiles(studio, asset, revision, payload),
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: report,
  });
  return { revision: created };
}

// ---------------------------------------------------------------------------
// Espelho explícito (derivação local autorizada; nunca conta como geração)
// ---------------------------------------------------------------------------

export const MirrorInput = z.strictObject({
  revisionId: Id,
  /** Base/objeto: vista de origem (a de destino é o par horizontal: E↔W, NE↔NW, SE↔SW). Clipe: a direção do próprio clipe. */
  source: Direction.optional(),
  /** Confirmação explícita para arte assimétrica (escudo, marca lateral, luz direcional), com motivo. */
  confirmAsymmetric: z.strictObject({ reason: z.string().trim().min(3).max(300) }).optional(),
});

const ASYMMETRY_THRESHOLD = 0.08;

/** Vista frontal (S, senão N) mede a simetria do sujeito; assimetrias declaradas em gerações também contam. */
function asymmetryProbe(base: BasePayload, revision: RevisionView): { sha256: string | null; declared: string[] } {
  const front = base.views.find((v) => v.direction === "S") ?? base.views.find((v) => v.direction === "N");
  const file = front ? revision.files.find((f) => f.fileKey === front.fileId) : undefined;
  const declared = ((revision.technicalReport as { asymmetries?: string[] } | null)?.asymmetries ?? []).filter(Boolean);
  return { sha256: file?.sha256 ?? null, declared };
}

function guardAsymmetry(report: { asymmetry: number | null; asymmetric: boolean | null }, declared: string[], confirm: { reason: string } | undefined) {
  const asymmetric = report.asymmetric === true || declared.length > 0 || report.asymmetric === null;
  if (asymmetric && !confirm) {
    throw new DomainFailure(
      "validation_failed",
      report.asymmetric === null
        ? tx(
            "Sem vista frontal para medir a simetria do sujeito: o espelho exige confirmação explícita (arte simétrica, sem luz direcional ou marca lateral)",
            "No front view to measure the subject's symmetry: mirroring requires explicit confirmation (symmetric art, no directional light or side marking)",
          )
        : tx(
            `Arte assimétrica (${declared.length ? `assimetrias declaradas: ${declared.join("; ")}` : `${Math.round((report.asymmetry ?? 0) * 100)}% da vista frontal difere do próprio espelho`}): espelhar trocaria escudo, marcas e luz de lado. Confirme com um motivo para derivar mesmo assim`,
            `Asymmetric art (${declared.length ? `declared asymmetries: ${declared.join("; ")}` : `${Math.round((report.asymmetry ?? 0) * 100)}% of the front view differs from its own mirror`}): mirroring would swap the shield, markings and light to the other side. Confirm with a reason to derive it anyway`,
          ),
      { needsConfirmation: true, asymmetry: report.asymmetry, declared },
    );
  }
  return asymmetric;
}

export async function mirrorExplicit(studio: Studio, projectId: string, raw: z.input<typeof MirrorInput>) {
  const input = MirrorInput.parse(raw);
  const { revision, asset } = sourceOf(studio, projectId, input.revisionId);
  if (asset.family === "character" && asset.kind === "base") return mirrorBaseView(studio, projectId, asset, revision, input);
  if (asset.family === "character" && asset.kind === "clip") return mirrorClip(studio, projectId, asset, revision, input);
  throw new DomainFailure("validation_failed", tx("Espelho explícito vale para vistas de base/objeto e para clipes", "Explicit mirroring applies to base/object views and to clips"));
}

async function mirrorBaseView(studio: Studio, projectId: string, asset: AssetView, revision: RevisionView, input: z.infer<typeof MirrorInput>) {
  const base = revision.payload as BasePayload;
  const source = input.source;
  if (!source) throw new DomainFailure("validation_failed", tx("Informe a vista de origem do espelho", "Choose the source view to mirror"));
  const target = MIRROR_PAIR[source];
  if (!target) throw new DomainFailure("validation_failed", tx(`${source} encara a câmera e não tem par de espelho (só E↔W, NE↔NW, SE↔SW)`, `${source} faces the camera and has no mirror pair (only E↔W, NE↔NW, SE↔SW)`));
  if (base.views.some((v) => v.direction === target)) throw new DomainFailure("validation_failed", tx(`A vista ${target} já existe: espelho não substitui arte aprovada`, `View ${target} already exists: a mirror does not replace approved art`));
  const view = base.views.find((v) => v.direction === source);
  if (!view) throw new DomainFailure("not_found", tx(`A revisão não tem a vista ${source}`, `The revision has no ${source} view`));
  const file = revision.files.find((f) => f.fileKey === view.fileId)!;
  const probe = asymmetryProbe(base, revision);
  const out = await runLocal(studio, "mirror_frames", [...(probe.sha256 ? [{ role: "source", sha256: probe.sha256 }] : []), { role: "layer", sha256: file.sha256 }], { version: 1, asymmetryThreshold: ASYMMETRY_THRESHOLD });
  const measured = out.report as { asymmetry: number | null; asymmetric: boolean | null };
  const asymmetric = guardAsymmetry(measured, probe.declared, input.confirmAsymmetric);
  const mirrored = out.outputs.find((o) => o.role === "mirrored")!;
  const fileKey = `mirror-${target.toLowerCase()}`;
  // Região espelhada na célula: x' = W − (x + w).
  const [W] = base.logicalSize;
  const newView = { direction: target, fileId: fileKey, rect: [0, 0, mirrored.width!, mirrored.height!] as Rect, sourceOffset: [W - (view.sourceOffset[0] + view.rect[2]), view.sourceOffset[1]] as [number, number] };
  if (view.rect[0] !== 0 || view.rect[1] !== 0 || view.rect[2] !== mirrored.width || view.rect[3] !== mirrored.height) {
    throw new DomainFailure("validation_failed", tx("A vista está num atlas; recorte-a para a célula antes de espelhar", "The view is in an atlas; crop it to the cell before mirroring"));
  }
  const views = [...base.views, newView].sort((a, b) => DIRECTIONS_8.indexOf(a.direction) - DIRECTIONS_8.indexOf(b.direction));
  const files = [...referencedFiles(studio, asset, revision, base), { fileKey, role: "mirror", idx: 0, blob: mirrored.blob }];
  const created = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "local_process",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload: { ...base, views },
    files,
    edges: [{ toRevisionId: revision.id, role: "mirrored_from", ordinal: 0, runtime: false }],
    technicalReport: localReport("mirror", {
      mirrored: true,
      from: source,
      to: target,
      asymmetry: measured.asymmetry,
      asymmetric,
      confirmedAsymmetric: input.confirmAsymmetric ?? null,
      note: tx("Derivação local autorizada e registrada como espelho; não conta como geração de vista", "Authorized local derivation recorded as a mirror; it does not count as view generation"),
    }),
  });
  return { revision: created, mirrored: { from: source, to: target }, asymmetry: measured.asymmetry };
}

/** Espelho de um clipe inteiro: quadros espelhados, sockets por `W − 1 − x`, pivô por `W − x`, lados anatômicos trocados no rig. */
async function mirrorClip(studio: Studio, projectId: string, asset: AssetView, revision: RevisionView, input: z.infer<typeof MirrorInput>) {
  const clip = revision.payload as ClipPayload;
  const target = MIRROR_PAIR[clip.direction];
  if (!target) throw new DomainFailure("validation_failed", tx(`Clipe ${clip.direction} encara a câmera e não tem par de espelho`, `Clip ${clip.direction} faces the camera and has no mirror pair`));
  const [W, H] = clip.logicalSize;
  // Recompõe cada quadro na célula e espelha a célula inteira (camadas viram uma só, desenhada na mesma ordem).
  const files = [...new Set(clip.frames.flatMap((f) => f.layers.map((l) => l.fileId)))];
  const inputs = files.map((fileId) => ({ role: "layer", sha256: revision.files.find((f) => f.fileKey === fileId)!.sha256 }));
  const composed = await runLocal(studio, "compose_frames", inputs, {
    version: 1,
    cell: [W, H],
    frames: clip.frames.map((f) => ({ key: f.frameId, layers: f.layers.map((l) => ({ input: files.indexOf(l.fileId), rect: l.rect, offset: l.offset })) })),
    sheet: null,
    emitFrames: true,
  });
  const frameBlobs = clip.frames.map((f) => composed.outputs.find((o) => o.role === "frame" && o.key === f.frameId)!);
  // Simetria: a vista frontal da base do clipe, quando conhecida.
  const baseRevisionId = (revision.technicalReport as { baseRevisionId?: string } | null)?.baseRevisionId;
  let probe: { sha256: string | null; declared: string[] } = { sha256: null, declared: [] };
  if (baseRevisionId) {
    try {
      const baseRev = getRevision(studio.db, projectId, baseRevisionId);
      probe = asymmetryProbe(baseRev.payload as BasePayload, baseRev);
    } catch {
      /* base fora do projeto: confirmação explícita */
    }
  }
  const mirroredOut = await runLocal(studio, "mirror_frames", [...(probe.sha256 ? [{ role: "source", sha256: probe.sha256 }] : []), ...frameBlobs.map((o) => ({ role: "layer", sha256: o.blob.sha256 }))], {
    version: 1,
    asymmetryThreshold: ASYMMETRY_THRESHOLD,
  });
  const measured = mirroredOut.report as { asymmetry: number | null; asymmetric: boolean | null };
  const asymmetric = guardAsymmetry(measured, probe.declared, input.confirmAsymmetric);
  const offset = probe.sha256 ? 1 : 0;
  const mirrored = clip.frames.map((_, i) => mirroredOut.outputs.find((o) => o.role === "mirrored" && o.key === String(i + offset))!);
  // Lados anatômicos: num espelho, a mão desenhada perto da câmera passa a ser a outra mão.
  let swaps = new Map<string, string>();
  if (clip.rigRevisionId) {
    try {
      const rig = getRevision(studio.db, projectId, clip.rigRevisionId).payload as { sockets: { socketId: string; anatomicalSide: string; purpose: string }[] };
      for (const s of rig.sockets.filter((x) => x.anatomicalSide === "right")) {
        const pair = rig.sockets.find((x) => x.anatomicalSide === "left" && x.purpose === s.purpose);
        if (pair) swaps = new Map([...swaps, [s.socketId, pair.socketId], [pair.socketId, s.socketId]]);
      }
    } catch {
      /* rig fora do projeto */
    }
  }
  const payload: ClipPayload = {
    ...clip,
    direction: target,
    pivot: mirrorGridPoint(clip.pivot, W),
    margins: { ...clip.margins, left: clip.margins.right, right: clip.margins.left },
    frames: clip.frames.map((f) => ({
      ...f,
      layers: [{ partId: f.layers[0]!.partId, fileId: `mirror-${f.frameId}`, rect: [0, 0, W, H], offset: [0, 0] }],
      sockets: f.sockets.map((s) => ({ ...s, socketId: swaps.get(s.socketId) ?? s.socketId, at: mirrorPixel(s.at, W) })),
      rootOffset: [-f.rootOffset[0], f.rootOffset[1]],
    })),
    events: clip.events.map((e) => ({ ...e, vfx: e.vfx ? { ...e.vfx, socketId: e.vfx.socketId ? (swaps.get(e.vfx.socketId) ?? e.vfx.socketId) : null, offset: [-e.vfx.offset[0], e.vfx.offset[1]] } : null })),
  };
  const name = asset.name.endsWith(` · ${clip.direction}`) ? `${asset.name.slice(0, -clip.direction.length)}${target}` : `${asset.name} · espelho ${target}`;
  const targetAsset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "clip", name: name.slice(0, 120) });
  const created = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: targetAsset.id,
    origin: "local_process",
    styleRevisionId: revision.styleRevisionId,
    payload,
    files: mirrored.map((o, i) => ({ fileKey: `mirror-${clip.frames[i]!.frameId}`, role: "mirror", idx: i, blob: o.blob })),
    edges: [{ toRevisionId: revision.id, role: "mirrored_from", ordinal: 0, runtime: false }],
    technicalReport: localReport("mirror", {
      mirrored: true,
      from: clip.direction,
      to: target,
      asymmetry: measured.asymmetry,
      asymmetric,
      confirmedAsymmetric: input.confirmAsymmetric ?? null,
      socketSwaps: Object.fromEntries(swaps),
      flattenedLayers: clip.frames.filter((f) => f.layers.length > 1).map((f) => f.frameId),
      note: tx("Derivação local autorizada e registrada como espelho; não conta como geração", "Authorized local derivation recorded as a mirror; it does not count as generation"),
    }),
  });
  return { asset: targetAsset, revision: created, mirrored: { from: clip.direction, to: target }, asymmetry: measured.asymmetry };
}

// ---------------------------------------------------------------------------
// Canvas (sem gerar pixels)
// ---------------------------------------------------------------------------

const Margin = z.number().int().min(-512).max(512);
export const CanvasInput = z.strictObject({ revisionId: Id, margins: z.strictObject({ left: Margin, right: Margin, top: Margin, bottom: Margin }) });

export async function resizeCanvas(studio: Studio, projectId: string, raw: z.input<typeof CanvasInput>) {
  const input = CanvasInput.parse(raw);
  const { revision, asset } = sourceOf(studio, projectId, input.revisionId);
  const m: CanvasMargins = input.margins;
  if (marginsAreZero(m)) throw new DomainFailure("validation_failed", tx("Nada a mudar: todas as margens são zero", "Nothing to change: all margins are zero"));
  const shrinking = m.left < 0 || m.right < 0 || m.top < 0 || m.bottom < 0;
  if (asset.family === "character" && asset.kind === "clip") {
    const clip = revision.payload as ClipPayload;
    let boxes: Record<string, Rect | null> | undefined;
    if (shrinking) {
      const files = [...new Set(clip.frames.flatMap((f) => f.layers.map((l) => l.fileId)))];
      const { report } = await runLocal(
        studio,
        "compose_frames",
        files.map((fileId) => ({ role: "layer", sha256: revision.files.find((f) => f.fileKey === fileId)!.sha256 })),
        { version: 1, cell: clip.logicalSize, frames: clip.frames.map((f) => ({ key: f.frameId, layers: f.layers.map((l) => ({ input: files.indexOf(l.fileId), rect: l.rect, offset: l.offset })) })), sheet: null, emitFrames: false },
      );
      boxes = Object.fromEntries((report.frames as { key: string; contentBox: Rect | null }[]).map((f) => [f.key, f.contentBox]));
    }
    const result = resizeClipCanvas(clip, m, boxes);
    if (result.problems.length) throw new DomainFailure("validation_failed", result.problems[0]!, { problems: result.problems });
    const sha = (fileId: string) => revision.files.find((f) => f.fileKey === fileId)?.sha256 ?? fileId;
    const created = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: asset.id,
      origin: "edit",
      styleRevisionId: revision.styleRevisionId,
      predecessorId: revision.id,
      payload: result.payload,
      files: referencedFiles(studio, asset, revision, result.payload),
      edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
      technicalReport: localReport("canvas", {
        margins: m,
        shift: result.shift,
        from: clip.logicalSize,
        to: result.size,
        // Coberturas de overlay (S2) se deslocam pelo mesmo `shift`; eventos ancorados a socket/pivô acompanham sem mudar o offset local.
        coverageShift: result.shift,
        frames: clip.frames.map((f, i) => ({ frameId: f.frameId, before: frameDigest(f, sha), after: frameDigest(result.payload.frames[i]!, sha) })),
        affected: affectedByFrames(studio.db, projectId, revision.id, clip.frames.map((f) => f.frameId)),
      }),
    });
    return { revision: created, shift: result.shift, size: result.size };
  }
  if (asset.family === "character" && asset.kind === "base") {
    const base = revision.payload as BasePayload;
    const result = resizeBaseCanvas(base, m);
    if (result.problems.length) throw new DomainFailure("validation_failed", result.problems[0]!, { problems: result.problems });
    const files = [];
    for (const [i, placement] of result.placements.entries()) {
      const file = revision.files.find((f) => f.fileKey === placement.fileId)!;
      const { width, height } = file.metadata as { width?: number; height?: number };
      if (placement.rect[0] !== 0 || placement.rect[1] !== 0 || placement.rect[2] !== width || placement.rect[3] !== height) {
        throw new DomainFailure("validation_failed", tx(`A vista ${placement.direction} está num atlas; recorte-a para a célula antes de mudar o canvas`, `View ${placement.direction} is in an atlas; crop it to the cell before changing the canvas`));
      }
      // Mesmos pixels numa tela nova: recortar pixel visível falha no processador local.
      const out = await runLocal(studio, "canvas_fit", [{ role: "source", sha256: file.sha256 }], { version: 1, size: result.size, offset: placement.offset });
      files.push({ fileKey: `canvas-${placement.direction.toLowerCase()}`, role: "view", idx: i, blob: out.outputs[0]!.blob });
    }
    const payload: BasePayload = { ...result.payload, views: result.payload.views.map((v) => ({ ...v, fileId: `canvas-${v.direction.toLowerCase()}` })) };
    const created = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: asset.id,
      origin: "edit",
      styleRevisionId: revision.styleRevisionId,
      predecessorId: revision.id,
      payload,
      files,
      edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
      technicalReport: localReport("canvas", { margins: m, shift: result.shift, from: base.logicalSize, to: result.size, groundOrigin: { from: base.groundOrigin, to: payload.groundOrigin } }),
    });
    return { revision: created, shift: result.shift, size: result.size };
  }
  throw new DomainFailure("validation_failed", tx(`Canvas vale para clipes e bases/objetos; ${asset.name} é ${asset.family}/${asset.kind}`, `Canvas changes apply to clips and bases/objects; ${asset.name} is ${asset.family}/${asset.kind}`));
}
