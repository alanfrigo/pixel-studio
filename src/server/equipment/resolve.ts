import { z } from "zod";
import { Direction, Id, LayerRef, type LoadoutPayload, Slug } from "@/contracts";
import { exportBlockers, type ResolvedCombo, type Resolution, resolveLoadout } from "@/domain/equipment/resolve";
import type { OverlayRef } from "@/domain/equipment/types";
import { getProject } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { blobOf, listClips, loadLoadout, loadOverlay, loadRig, mediaIdOf } from "./load";
import { type EquipmentEnv, runEquipmentPython } from "./python";

/**
 * Resolução de um conjunto (rascunho ou publicado) para a interface e para a
 * composição local. Nada aqui chama provedor: trocar de conjunto, de item ou
 * de clipe depois da aprovação é leitura de catálogo + composição local.
 */

export const DrawOrderInput = z.array(z.strictObject({ clipRevisionId: Id, frameId: Id, layers: z.array(LayerRef).min(1).max(32) })).max(256);

export const LoadoutConfig = z.strictObject({
  rigRevisionId: Id,
  overlayRevisionIds: z.array(Id).max(16),
  /** Postura escolhida pelo artista (`null` = automática pela combinação). */
  stance: Slug.nullable().default(null),
  /** Variante de clipe fixada pelo artista por combinação. */
  pins: z.array(z.strictObject({ action: Slug, direction: Direction, clipRevisionId: Id })).max(64).default([]),
  /** Combinações pedidas; ausente = toda ação com clipe aprovado × direções do rig. */
  combos: z.array(z.strictObject({ action: Slug, direction: Direction })).max(64).optional(),
  drawOrder: DrawOrderInput.optional(),
});
export type LoadoutConfig = z.input<typeof LoadoutConfig>;

export const ResolveRequest = z.union([z.strictObject({ loadoutRevisionId: Id }), z.strictObject({ config: LoadoutConfig })]);

export interface ResolvedContext {
  resolution: Resolution;
  overlays: OverlayRef[];
  rigName: string;
  /** Conjunto publicado que originou a resolução (modo congelado). */
  loadout: { revisionId: string; assetId: string; name: string; number: number; status: string; active: boolean; payload: LoadoutPayload } | null;
}

function loadOverlays(db: Db, projectId: string, ids: readonly string[]): OverlayRef[] {
  return ids.map((id) => {
    const o = loadOverlay(db, projectId, id);
    return { revisionId: o.revisionId, assetId: o.assetId, name: o.name, number: o.number, status: o.status, styleRevisionId: o.styleRevisionId, payload: o.payload };
  });
}

export function resolveConfig(studio: Pick<Studio, "db">, projectId: string, raw: LoadoutConfig): ResolvedContext {
  const config = LoadoutConfig.parse(raw);
  const rig = loadRig(studio.db, projectId, config.rigRevisionId);
  const overlays = loadOverlays(studio.db, projectId, config.overlayRevisionIds);
  const resolution = resolveLoadout({
    rig: rig.ref,
    overlays,
    clips: listClips(studio.db, projectId, rig.ref.revisionId),
    stance: config.stance,
    pins: config.pins,
    ...(config.combos ? { combos: config.combos } : {}),
    ...(config.drawOrder ? { drawOrder: config.drawOrder } : {}),
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
  });
  return { resolution, overlays, rigName: rig.name, loadout: null };
}

/** Conjunto publicado: overlays, postura e clipes do snapshot (sem nova busca). */
export function resolveLoadoutRevision(studio: Pick<Studio, "db">, projectId: string, loadoutRevisionId: string): ResolvedContext {
  const loadout = loadLoadout(studio.db, projectId, loadoutRevisionId);
  const p = loadout.payload;
  const rig = loadRig(studio.db, projectId, p.rigRevisionId);
  const overlays = loadOverlays(studio.db, projectId, p.overlayRevisionIds);
  const resolution = resolveLoadout({
    rig: rig.ref,
    overlays,
    clips: listClips(studio.db, projectId, rig.ref.revisionId),
    stance: p.stance,
    pins: p.clips,
    combos: p.clips.map((c) => ({ action: c.action, direction: c.direction })),
    frozen: true,
    ...(p.drawOrder ? { drawOrder: p.drawOrder } : {}),
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
  });
  return {
    resolution,
    overlays,
    rigName: rig.name,
    loadout: { revisionId: loadout.revisionId, assetId: loadout.assetId, name: loadout.name, number: loadout.number, status: loadout.status, active: loadout.active, payload: p },
  };
}

export function resolveRequest(studio: Pick<Studio, "db">, projectId: string, body: z.infer<typeof ResolveRequest>): ResolvedContext {
  return "loadoutRevisionId" in body ? resolveLoadoutRevision(studio, projectId, body.loadoutRevisionId) : resolveConfig(studio, projectId, body.config);
}

// ---------------------------------------------------------------------------
// Visão para a interface (camadas com o ID servível de cada arquivo)
// ---------------------------------------------------------------------------

export function resolutionView(db: Db, projectId: string, ctx: ResolvedContext) {
  const { resolution } = ctx;
  const media = new Map<string, string | null>();
  const mediaOf = (revisionId: string, fileKey: string) => {
    const k = `${revisionId}|${fileKey}`;
    if (!media.has(k)) media.set(k, mediaIdOf(db, revisionId, fileKey));
    return media.get(k)!;
  };
  const clipInfo = (id: string) => {
    const row = db.get<{ number: number; status: string; name: string }>(
      "SELECT r.number, r.status, a.name FROM asset_revisions r JOIN assets a ON a.id = r.asset_id WHERE r.id = :id AND r.project_id = :p",
      { id, p: projectId },
    );
    return { revisionId: id, number: row?.number ?? 0, status: row?.status ?? "unknown", name: row?.name ?? id };
  };
  return {
    rig: { revisionId: resolution.rigRevisionId, name: ctx.rigName },
    loadout: ctx.loadout && { revisionId: ctx.loadout.revisionId, assetId: ctx.loadout.assetId, name: ctx.loadout.name, number: ctx.loadout.number, status: ctx.loadout.status, active: ctx.loadout.active, hasSheets: Boolean(ctx.loadout.payload.sheets?.length), omitted: ctx.loadout.payload.omitted ?? [] },
    overlays: ctx.overlays.map((o) => ({
      revisionId: o.revisionId,
      assetId: o.assetId,
      name: o.name,
      number: o.number,
      status: o.status,
      slots: o.payload.slots,
      stances: o.payload.stances,
      compatible: !resolution.incompatible.includes(o.revisionId),
      rigRevisionId: o.payload.rigRevisionId,
      parts: o.payload.parts.map((p) => p.partId),
      rigidViews: o.payload.rigidViews.map((v) => ({ viewId: v.viewId, size: [v.rect[2], v.rect[3]], grips: v.grips, mirrorAllowed: Boolean(v.mirrorAllowed), mediaId: mediaOf(o.revisionId, v.fileId), rect: v.rect })),
    })),
    occupancy: resolution.occupancy,
    stance: resolution.stance,
    pendencies: resolution.pendencies,
    ready: resolution.ready,
    snapshot: resolution.snapshot,
    blockers: exportBlockers(resolution),
    matrix: resolution.matrix,
    combos: resolution.combos.map((c) => comboView(c, mediaOf, clipInfo)),
  };
}

function comboView(c: ResolvedCombo, mediaOf: (revisionId: string, fileKey: string) => string | null, clipInfo: (id: string) => { revisionId: string; number: number; status: string; name: string }) {
  return {
    key: c.key,
    action: c.action,
    direction: c.direction,
    stance: c.stance,
    status: c.status,
    lookup: c.lookup,
    candidates: (c.lookup && c.lookup.status !== "missing" ? c.lookup.candidates : []).map(clipInfo),
    linkable: (c.lookup?.status === "missing" ? c.lookup.linkable : []).map(clipInfo),
    update: c.update,
    clip: c.clip && {
      revisionId: c.clip.revisionId,
      assetId: c.clip.assetId,
      name: c.clip.name,
      number: c.clip.number,
      active: c.clip.active,
      logicalSize: c.clip.payload.logicalSize,
      pivot: c.clip.payload.pivot,
      margins: c.clip.payload.margins,
      playback: c.clip.payload.playback,
      sharedStances: c.clip.payload.sharedStances ?? [],
    },
    pendencies: c.pendencies,
    frames: c.frames.map((f) => ({
      frameId: f.frameId,
      durationMs: f.durationMs,
      sockets: f.sockets,
      gaps: f.gaps,
      empty: f.empty,
      issues: f.issues,
      override: f.override,
      layers: f.layers.map((l) => ({
        key: l.key,
        ref: l.ref,
        label: l.label,
        kind: l.ref.kind,
        drawIndex: l.drawIndex,
        mediaId: mediaOf(l.ownerRevisionId, l.fileId),
        rect: l.rect,
        offset: l.offset,
        size: l.size,
        mirrored: l.mirrored,
        overlayRevisionId: l.overlayRevisionId,
        partId: l.partId,
        viewId: l.viewId,
        grips: l.grips,
      })),
    })),
  };
}

export type ResolutionView = ReturnType<typeof resolutionView>;

// ---------------------------------------------------------------------------
// Composição local (Python): prévia por frame e folha achatada
// ---------------------------------------------------------------------------

export async function composeCombo(env: EquipmentEnv & { db: Db }, combo: ResolvedCombo, tolerancePx: number, opts: { baseOnly?: boolean } = {}) {
  if (!combo.clip) throw new DomainFailure("coverage_incomplete", `Sem clipe para ${combo.key}`);
  const inputs: { role: "layer"; sha256: string }[] = [];
  const ordinal = new Map<string, number>();
  const inputFor = (revisionId: string, fileKey: string) => {
    const sha = blobOf(env.db, revisionId, fileKey);
    if (!ordinal.has(sha)) {
      ordinal.set(sha, inputs.length);
      inputs.push({ role: "layer", sha256: sha });
    }
    return ordinal.get(sha)!;
  };
  const frames = combo.frames.map((f) => ({
    frameId: f.frameId,
    layers: f.layers
      .filter((l) => !opts.baseOnly || l.ref.kind === "base")
      .map((l) => ({
        key: l.key,
        inputOrdinal: inputFor(l.ownerRevisionId, l.fileId),
        rect: l.rect,
        offset: l.offset,
        mirrored: l.mirrored,
        ...(l.grips.some((g) => g.expected) ? { grips: l.grips.filter((g) => g.expected).map((g) => ({ socketId: g.socketId, at: g.at, expected: g.expected! })) } : {}),
      })),
  }));
  return runEquipmentPython(env, "equipment_compose", inputs, { cell: combo.clip.payload.logicalSize, frames, tolerancePx });
}
