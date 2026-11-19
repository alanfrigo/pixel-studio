import { z } from "zod";
import { type AssetFamily, type ClipPayload, Id, Insets, type OverlayPayload, parseRevisionPayload, PixelIndex, Slug } from "@/contracts";
import { expandClipCell, isZeroInsets, shiftOverlayForExpansion } from "@/domain/equipment/cell";
import { frameDigest, rebindOverlay } from "@/domain/equipment/digest";
import { entryRefs } from "@/domain/manifest/refs";
import { getAsset, getBlob, getProject, getRevision, type PublishFile, publishRevision, type RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { blobOf, listOverlays, loadOverlay } from "./load";
import { runEquipmentPython, uniqueFiles } from "./python";

/**
 * Edições locais de peças e clipes do cartão S2 (zero chamadas pagas): célula
 * vazia explícita, lacuna, empunhaduras, uso de vista rígida, ampliação de
 * célula, vínculo de clipe compartilhado e revinculação por digest. Cada uma
 * publica uma revisão CANDIDATA com os mesmos blobs; a aprovação segue o fluxo
 * de revisão.
 */

/** Arquivos citados pelo payload, reaproveitados da revisão de origem (mesmos blobs). */
export function reuseFiles(db: Db, from: RevisionView, family: AssetFamily, kind: string, payload: unknown): PublishFile[] {
  const parsed = parseRevisionPayload(family, kind, payload);
  if (!parsed.success) throw new DomainFailure("validation_failed", parsed.issues[0]?.message ?? "Payload inválido", { issues: parsed.issues.slice(0, 10) });
  const keys = new Set(entryRefs(parsed.entry).files.map((f) => f.fileId));
  return from.files
    .filter((f) => keys.has(f.fileKey))
    .map((f) => {
      const blob = getBlob(db, f.sha256);
      if (!blob) throw new DomainFailure("internal", `Blob ${f.sha256} sem registro`);
      return { fileKey: f.fileKey, role: f.role, idx: f.idx, blob };
    });
}

function republish(studio: Studio, projectId: string, from: RevisionView, payload: unknown, report: Record<string, unknown>, extraFiles: PublishFile[] = []) {
  const asset = getAsset(studio.db, projectId, from.assetId);
  const files = uniqueFiles([...reuseFiles(studio.db, from, asset.family, asset.kind, payload), ...extraFiles]);
  return publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    payload,
    origin: "edit",
    styleRevisionId: from.styleRevisionId ?? getProject(studio.db, projectId).activeStyleRevisionId,
    predecessorId: from.id,
    files,
    edges: [{ toRevisionId: from.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: { providerCalls: 0, ...report },
  });
}

// ---------------------------------------------------------------------------
// Edições da peça
// ---------------------------------------------------------------------------

export const OverlayEditInput = z.discriminatedUnion("op", [
  /** A pose encobre a parte por completo: célula vazia explícita (`rigid` = vista oculta). */
  z.strictObject({ op: z.literal("mark_empty"), overlayRevisionId: Id, clipRevisionId: Id, frameId: Id, partId: Slug }),
  /** Remove a célula (vira lacuna, apontada pelo verificador). */
  z.strictObject({ op: z.literal("remove_cell"), overlayRevisionId: Id, clipRevisionId: Id, frameId: Id, partId: Slug }),
  z.strictObject({ op: z.literal("set_draw_index"), overlayRevisionId: Id, clipRevisionId: Id, frameId: Id, partId: Slug, drawIndex: z.number().int().min(-16).max(64) }),
  z.strictObject({ op: z.literal("set_grips"), overlayRevisionId: Id, viewId: Id, grips: z.array(z.strictObject({ socketId: Id, at: PixelIndex })).min(1).max(2) }),
  /** Liga a peça ao item de inventário (ícone e arte equipada são variantes do mesmo item). */
  z.strictObject({ op: z.literal("set_item"), overlayRevisionId: Id, itemRevisionId: Id.nullable() }),
  /** Troca o desenho num frame (ex.: vista de escorço), oculta a peça ou ajusta ordem/espelho. */
  z.strictObject({
    op: z.literal("set_placement"),
    overlayRevisionId: Id,
    clipRevisionId: Id,
    frameId: Id,
    viewId: Id.nullable(),
    anchorSocketId: Id,
    drawIndex: z.number().int().min(-16).max(64),
    mirrored: z.boolean().default(false),
  }),
]);
export type OverlayEditInput = z.input<typeof OverlayEditInput>;

export function editOverlay(studio: Studio, projectId: string, raw: OverlayEditInput) {
  const input = OverlayEditInput.parse(raw);
  const ov = loadOverlay(studio.db, projectId, input.overlayRevisionId);
  const p: OverlayPayload = structuredClone(ov.payload);
  const same = (c: { clipRevisionId: string; frameId: string }) => "clipRevisionId" in input && c.clipRevisionId === input.clipRevisionId && c.frameId === input.frameId;
  const partOf = (partId: string) => {
    const part = p.parts.find((x) => x.partId === partId);
    if (!part) throw new DomainFailure("not_found", `A peça ${ov.name} não tem a parte ${partId}`);
    return part;
  };
  let summary: string;
  switch (input.op) {
    case "mark_empty":
      if (input.partId === "rigid") {
        const list = (p.rigidPlacements ??= []);
        const at = list.findIndex(same);
        const anchor = list[at]?.anchorSocketId ?? p.rigidViews[0]?.grips[0]?.socketId;
        if (!anchor) throw new DomainFailure("validation_failed", `${ov.name} não tem vista rígida`);
        const placement = { clipRevisionId: input.clipRevisionId, frameId: input.frameId, viewId: null, anchorSocketId: anchor, drawIndex: list[at]?.drawIndex ?? 0 };
        if (at >= 0) list[at] = placement;
        else list.push(placement);
      } else {
        const part = partOf(input.partId);
        const at = part.coverage.findIndex(same);
        const cell = { clipRevisionId: input.clipRevisionId, frameId: input.frameId, layer: null, drawIndex: part.coverage[at]?.drawIndex ?? 0 };
        if (at >= 0) part.coverage[at] = cell;
        else part.coverage.push(cell);
      }
      summary = `Célula vazia explícita: ${input.partId} em ${input.frameId}`;
      break;
    case "remove_cell":
      if (input.partId === "rigid") p.rigidPlacements = (p.rigidPlacements ?? []).filter((x) => !same(x));
      else partOf(input.partId).coverage = partOf(input.partId).coverage.filter((x) => !same(x));
      summary = `Cobertura removida: ${input.partId} em ${input.frameId} (lacuna)`;
      break;
    case "set_draw_index": {
      if (input.partId === "rigid") {
        const pl = (p.rigidPlacements ?? []).find(same);
        if (!pl) throw new DomainFailure("not_found", "Sem uso de vista rígida neste frame");
        pl.drawIndex = input.drawIndex;
      } else {
        const cell = partOf(input.partId).coverage.find(same);
        if (!cell) throw new DomainFailure("not_found", "Sem cobertura neste frame");
        cell.drawIndex = input.drawIndex;
      }
      summary = `Ordem de ${input.partId} em ${input.frameId}: ${input.drawIndex}`;
      break;
    }
    case "set_grips": {
      const view = p.rigidViews.find((v) => v.viewId === input.viewId);
      if (!view) throw new DomainFailure("not_found", `Vista ${input.viewId} inexistente`);
      const [w, h] = [view.rect[2], view.rect[3]];
      for (const g of input.grips) {
        if (g.at[0] >= w || g.at[1] >= h) throw new DomainFailure("validation_failed", `Empunhadura ${g.socketId} fora da vista ${w}×${h}`);
      }
      view.grips = input.grips;
      summary = `Empunhaduras da vista ${input.viewId}: ${input.grips.map((g) => `${g.socketId}@${g.at.join(",")}`).join("; ")}`;
      break;
    }
    case "set_item": {
      if (input.itemRevisionId) {
        const item = getRevision(studio.db, projectId, input.itemRevisionId);
        if (getAsset(studio.db, projectId, item.assetId).family !== "item") throw new DomainFailure("validation_failed", "O vínculo precisa apontar uma revisão de item de inventário");
      }
      p.itemRevisionId = input.itemRevisionId;
      summary = input.itemRevisionId ? `Ligada ao item ${input.itemRevisionId}` : "Sem item de inventário";
      break;
    }
    case "set_placement": {
      const list = (p.rigidPlacements ??= []);
      const placement = {
        clipRevisionId: input.clipRevisionId,
        frameId: input.frameId,
        viewId: input.viewId,
        anchorSocketId: input.anchorSocketId,
        drawIndex: input.drawIndex,
        ...(input.mirrored ? { mirrored: true } : {}),
      };
      const at = list.findIndex(same);
      if (at >= 0) list[at] = placement;
      else list.push(placement);
      summary = `Vista ${input.viewId ?? "oculta"} em ${input.frameId}${input.mirrored ? " (espelhada)" : ""}`;
      break;
    }
  }
  const revision = republish(studio, projectId, ov.revision, p, { operation: `overlay_${input.op}`, summary, edit: input });
  return { revision, summary };
}

// ---------------------------------------------------------------------------
// Ampliar a célula de clipes (e copiar as coberturas deslocadas)
// ---------------------------------------------------------------------------

export const ExpandCellInput = z.strictObject({
  clips: z.array(z.strictObject({ clipRevisionId: Id, margins: Insets })).min(1).max(16),
  /** Peças a acompanhar; ausente = todas cuja revisão ativa (ou mais recente) cobre o clipe. */
  overlayRevisionIds: z.array(Id).max(32).optional(),
});

export function expandCell(studio: Studio, projectId: string, raw: z.input<typeof ExpandCellInput>) {
  const input = ExpandCellInput.parse(raw);
  const moved: { from: string; to: RevisionView; margins: z.infer<typeof Insets> }[] = [];
  for (const c of input.clips) {
    if (isZeroInsets(c.margins)) throw new DomainFailure("validation_failed", "Margens zeradas: nada a ampliar");
    const rev = getRevision(studio.db, projectId, c.clipRevisionId);
    const asset = getAsset(studio.db, projectId, rev.assetId);
    if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", `${asset.name} não é um clipe`);
    const before = rev.payload as ClipPayload;
    const payload = expandClipCell(before, c.margins);
    const to = republish(studio, projectId, rev, payload, {
      operation: "expand_cell",
      margins: c.margins,
      fromSize: before.logicalSize,
      toSize: payload.logicalSize,
      pivot: { from: before.pivot, to: payload.pivot },
      note: "Camadas, sockets e pivô deslocados pela mesma margem; posição em cena preservada",
    });
    moved.push({ from: rev.id, to, margins: c.margins });
  }
  const candidates = input.overlayRevisionIds
    ? input.overlayRevisionIds.map((id) => loadOverlay(studio.db, projectId, id))
    : latestOverlays(studio.db, projectId).map((o) => loadOverlay(studio.db, projectId, o.revisionId));
  const overlays: { overlayRevisionId: string; name: string; revision: RevisionView; copied: number }[] = [];
  for (const ov of candidates) {
    let payload = ov.payload;
    let copied = 0;
    for (const m of moved) {
      const r = shiftOverlayForExpansion(payload, m.from, m.to.id, m.margins);
      payload = r.payload;
      copied += r.copied;
    }
    if (copied === 0) continue;
    const revision = republish(studio, projectId, ov.revision, payload, { operation: "expand_cell_coverage", clips: moved.map((m) => ({ from: m.from, to: m.to.id, margins: m.margins })), copied });
    overlays.push({ overlayRevisionId: ov.revisionId, name: ov.name, revision, copied });
  }
  return { clips: moved.map((m) => ({ from: m.from, revision: m.to })), overlays };
}

/** Revisão de referência de cada peça: a ativa ou, sem aprovada, a mais recente. */
export function latestOverlays(db: Db, projectId: string) {
  const all = listOverlays(db, projectId);
  const byAsset = new Map<string, (typeof all)[number]>();
  for (const o of all) {
    const cur = byAsset.get(o.assetId);
    if (o.active) byAsset.set(o.assetId, o);
    else if (!cur || (!cur.active && o.number > cur.number)) byAsset.set(o.assetId, o);
  }
  return [...byAsset.values()];
}

// ---------------------------------------------------------------------------
// Vínculo explícito de clipe compartilhado
// ---------------------------------------------------------------------------

export const ShareClipInput = z.strictObject({ clipRevisionId: Id, stance: Slug });

export function shareClip(studio: Studio, projectId: string, raw: z.input<typeof ShareClipInput>) {
  const input = ShareClipInput.parse(raw);
  const rev = getRevision(studio.db, projectId, input.clipRevisionId);
  const clip = rev.payload as ClipPayload;
  if (clip.stance === input.stance || clip.sharedStances?.includes(input.stance)) throw new DomainFailure("validation_failed", `O clipe já serve à postura ${input.stance}`);
  const payload: ClipPayload = { ...clip, sharedStances: [...(clip.sharedStances ?? []), input.stance] };
  return republish(studio, projectId, rev, payload, { operation: "share_clip", stance: input.stance, note: "Vínculo explícito: revise e aprove para o resolvedor usar" });
}

// ---------------------------------------------------------------------------
// Digest de geometria e revinculação
// ---------------------------------------------------------------------------

/** Digest de cada frame do clipe (pixels das camadas da base pelo hash RGBA da região). */
export async function clipDigests(studio: Pick<Studio, "db" | "config" | "blobs">, projectId: string, clipRevisionId: string): Promise<Record<string, string>> {
  const rev = getRevision(studio.db, projectId, clipRevisionId);
  const clip = rev.payload as ClipPayload;
  const inputs: { role: "layer"; sha256: string }[] = [];
  const ordinal = new Map<string, number>();
  const regions = clip.frames.flatMap((f, fi) =>
    f.layers.map((l, li) => {
      const sha = blobOf(studio.db, rev.id, l.fileId);
      if (!ordinal.has(sha)) {
        ordinal.set(sha, inputs.length);
        inputs.push({ role: "layer", sha256: sha });
      }
      return { key: `${fi}:${li}`, inputOrdinal: ordinal.get(sha)!, rect: l.rect };
    }),
  );
  const run = await runEquipmentPython(studio, "equipment_region_hashes", inputs, { regions });
  const hashes = run.report.hashes as Record<string, string>;
  return Object.fromEntries(clip.frames.map((f, fi) => [f.frameId, frameDigest(clip, fi, f.layers.map((_, li) => hashes[`${fi}:${li}`]!))]));
}

export const RebindInput = z.strictObject({
  overlayRevisionId: Id,
  /** Revisão anterior coberta; ausente = a mais recente do mesmo clipe com cobertura na peça. */
  fromClipRevisionId: Id.optional(),
  toClipRevisionId: Id,
});

/**
 * Nova revisão do clipe (retime, título, evento ou pose de um frame): copia a
 * cobertura para ela onde o frame tem o mesmo ID e o mesmo digest de geometria
 * (mesmos blobs) e lista o que precisa de revisão. Os vínculos anteriores
 * ficam: o pacote antigo continua resolvendo suas revisões originais.
 */
export async function rebindCoverage(studio: Studio, projectId: string, raw: z.input<typeof RebindInput>) {
  const input = RebindInput.parse(raw);
  const ov = loadOverlay(studio.db, projectId, input.overlayRevisionId);
  const to = getRevision(studio.db, projectId, input.toClipRevisionId);
  let fromId = input.fromClipRevisionId;
  if (!fromId) {
    const covered = new Set([...ov.payload.parts.flatMap((p) => p.coverage.map((c) => c.clipRevisionId)), ...(ov.payload.rigidPlacements ?? []).map((p) => p.clipRevisionId)]);
    const candidates = [...covered].filter((id) => id !== to.id).map((id) => getRevision(studio.db, projectId, id)).filter((r) => r.assetId === to.assetId).sort((a, b) => b.number - a.number);
    if (!candidates[0]) throw new DomainFailure("not_found", `${ov.name} não cobre nenhuma revisão anterior deste clipe`);
    fromId = candidates[0].id;
  }
  const from = getRevision(studio.db, projectId, fromId);
  if (from.assetId !== to.assetId) throw new DomainFailure("validation_failed", "Revincular só entre revisões do mesmo clipe");
  const [fromDigests, toDigests] = await Promise.all([clipDigests(studio, projectId, from.id), clipDigests(studio, projectId, to.id)]);
  const result = rebindOverlay(ov.payload, { revisionId: from.id, digests: fromDigests }, { revisionId: to.id, frameIds: (to.payload as ClipPayload).frames.map((f) => f.frameId), digests: toDigests });
  const revision =
    result.rebound.length > 0
      ? republish(studio, projectId, ov.revision, result.payload, { operation: "rebind_coverage", from: from.id, to: to.id, rebound: result.rebound, review: result.review, reusedBlobs: true })
      : null;
  return { revision, rebound: result.rebound, review: result.review, digests: { from: fromDigests, to: toDigests } };
}
