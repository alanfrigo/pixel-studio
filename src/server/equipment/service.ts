import { z } from "zod";
import { Direction, Id, type OverlayPayload, Slug } from "@/contracts";
import { createAsset, getProject, publishRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { listProfiles } from "../providers/registry";
import { jobView, submitJob } from "../services";
import type { Studio } from "../studio";
import { DEMO_NAMES } from "./demo";
import { listClips, listLoadouts, listOverlays, listRigs, loadOverlay, loadRig, mediaIdOf } from "./load";
import { reuseFiles } from "./overlays";
import { buildOverlayCoveragePlan, OverlayCoveragePlanInput } from "./plans";
import { EQUIPMENT_ROUTE_LABELS, genericEquipmentCapabilities } from "./provider-caps";
import { dataUrl } from "./python";
import { composeCombo, resolveRequest, ResolveRequest } from "./resolve";

/**
 * Casos de uso das rotas `/equipment` (cartão S2). Gerar é a única ação que
 * fala com provedor (e passa pelo plano congelado); resolver, trocar, compor,
 * editar, ampliar, revincular e extrair são locais.
 */

export function equipmentOverview(studio: Studio, projectId: string) {
  getProject(studio.db, projectId);
  const allClips = listClips(studio.db, projectId);
  const rigs = listRigs(studio.db, projectId).map((r) => ({
    /** Partes desenhadas pela própria base nos clipes (não são peças a gerar). */
    baseParts: [...new Set(allClips.filter((c) => c.payload.rigRevisionId === r.ref.revisionId).flatMap((c) => c.payload.frames.flatMap((f) => f.layers.map((l) => l.partId))))],
    revisionId: r.ref.revisionId,
    assetId: r.assetId,
    name: r.name,
    number: r.number,
    cell: r.ref.payload.logicalCell,
    directions: r.ref.payload.directions,
    slots: r.ref.payload.slots,
    sockets: r.ref.payload.sockets,
    parts: r.ref.payload.parts,
    stances: r.ref.payload.stances,
    tolerancePx: r.ref.payload.socketTolerancePx,
    base: r.base && {
      revisionId: r.base.revisionId,
      name: r.base.name,
      views: r.base.payload.views.map((v) => ({ direction: v.direction, mediaId: mediaIdOf(studio.db, r.base!.revisionId, v.fileId), rect: v.rect })),
    },
  }));
  const clips = allClips
    .filter((c) => c.payload.rigRevisionId)
    .map((c) => ({
      revisionId: c.revisionId,
      assetId: c.assetId,
      name: c.name,
      number: c.number,
      status: c.status,
      active: c.active,
      rigRevisionId: c.payload.rigRevisionId,
      action: c.payload.action,
      state: c.payload.state,
      stance: c.payload.stance,
      sharedStances: c.payload.sharedStances ?? [],
      direction: c.payload.direction,
      frames: c.payload.frames.map((f) => ({ frameId: f.frameId, durationMs: f.durationMs })),
      logicalSize: c.payload.logicalSize,
      margins: c.payload.margins,
    }));
  const overlays = groupByAsset(
    listOverlays(studio.db, projectId).map((o) => ({
      revisionId: o.revisionId,
      assetId: o.assetId,
      name: o.name,
      number: o.number,
      status: o.status,
      active: o.active,
      rigRevisionId: o.payload.rigRevisionId,
      itemRevisionId: o.payload.itemRevisionId,
      slots: o.payload.slots,
      stances: o.payload.stances,
      parts: o.payload.parts.map((p) => ({ partId: p.partId, cells: p.coverage.length, empty: p.coverage.filter((c) => !c.layer).length })),
      rigidViews: o.payload.rigidViews.map((v) => ({ viewId: v.viewId, rect: v.rect, grips: v.grips, mirrorAllowed: Boolean(v.mirrorAllowed), mediaId: mediaIdOf(studio.db, o.revisionId, v.fileId) })),
      placements: (o.payload.rigidPlacements ?? []).length,
    })),
  );
  const loadouts = groupByAsset(
    listLoadouts(studio.db, projectId).map((l) => ({
      revisionId: l.revisionId,
      assetId: l.assetId,
      name: l.name,
      number: l.number,
      status: l.status,
      active: l.active,
      rigRevisionId: l.payload.rigRevisionId,
      overlayRevisionIds: l.payload.overlayRevisionIds,
      stance: l.payload.stance,
      stancePolicy: l.payload.stancePolicy ?? "auto",
      clips: l.payload.clips,
      omitted: l.payload.omitted ?? [],
      drawOrder: l.payload.drawOrder ?? [],
      sheets: (l.payload.sheets ?? []).map((s) => ({ clipRevisionId: s.clipRevisionId, mediaId: mediaIdOf(studio.db, l.revisionId, s.fileId), frames: s.frames })),
    })),
  );
  const profiles = listProfiles(studio.db).map((p) => {
    let unavailable: string | null = null;
    let capabilities: string[] = [];
    let estimate = null;
    try {
      studio.providers.assertReady(p.id);
      const adapter = studio.providers.adapterFor(p.id);
      capabilities = adapter.capabilities("generate_overlay_coverage");
      estimate = adapter.estimate("generate_overlay_coverage", 1);
      if (capabilities.length === 0) unavailable = "Sem rota para criar peças (use uma rota de imagem + referências ou extraia de um clipe vestido)";
    } catch (err) {
      unavailable = err instanceof Error ? err.message : String(err);
    }
    return {
      id: p.id,
      name: p.name,
      transport: p.transport,
      simulated: p.simulated,
      unavailable,
      capabilities,
      estimate,
      routes: {
        coverage: capabilities.includes("image_references") ? EQUIPMENT_ROUTE_LABELS.dressed_candidate : null,
        rigid: capabilities.includes("text_to_image") ? EQUIPMENT_ROUTE_LABELS.rigid_view : null,
      },
    };
  });
  const jobs = studio.queue
    .list(projectId, { active: false })
    .filter((j) => {
      try {
        return (JSON.parse(j.request_json) as { plan?: { operation?: string } }).plan?.operation === "generate_overlay_coverage";
      } catch {
        return false;
      }
    })
    .slice(0, 20)
    .map((j) => jobView(studio, j));
  // Itens de inventário (ícone) que uma peça pode representar.
  const items = studio.db
    .all<{ asset_id: string; name: string; rev: string; payload_json: string }>(
      `SELECT a.id AS asset_id, a.name, r.id AS rev, r.payload_json FROM assets a JOIN asset_revisions r ON r.id = a.approved_revision_id
       WHERE a.project_id = :p AND a.family = 'item' AND a.archived_at IS NULL ORDER BY a.name`,
      { p: projectId },
    )
    .map((i) => {
      const icon = (JSON.parse(i.payload_json) as { representations: { role: string; fileId: string; rect: [number, number, number, number] }[] }).representations.find((r) => r.role === "icon");
      return { assetId: i.asset_id, name: i.name, revisionId: i.rev, icon: icon ? { mediaId: mediaIdOf(studio.db, i.rev, icon.fileId), rect: icon.rect } : null };
    });
  const seeded = Boolean(studio.db.get<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND name = :n AND kind = 'loadout'", { p: projectId, n: DEMO_NAMES.loadoutA }));
  return { projectId, rigs, clips, overlays, loadouts, items, profiles, jobs, demo: { seeded }, genericCapabilities: genericEquipmentCapabilities(2) };
}

function groupByAsset<T extends { assetId: string; name: string; active: boolean; number: number }>(rows: T[]) {
  const map = new Map<string, { assetId: string; name: string; activeRevisionId: string | null; revisions: T[] }>();
  for (const r of rows) {
    const g = map.get(r.assetId) ?? { assetId: r.assetId, name: r.name, activeRevisionId: null, revisions: [] };
    g.revisions.push(r);
    if (r.active) g.activeRevisionId = (r as unknown as { revisionId: string }).revisionId;
    map.set(r.assetId, g);
  }
  return [...map.values()].map((g) => ({ ...g, revisions: g.revisions.sort((a, b) => b.number - a.number) }));
}

// ---------------------------------------------------------------------------
// Prévia composta no servidor (pixel a pixel, igual à folha exportada)
// ---------------------------------------------------------------------------

export const ComposeInput = z.strictObject({ request: ResolveRequest, action: Slug, direction: Direction, baseOnly: z.boolean().default(false) });

export async function composePreview(studio: Studio, projectId: string, raw: z.input<typeof ComposeInput>) {
  const input = ComposeInput.parse(raw);
  const ctx = resolveRequest(studio, projectId, input.request);
  const combo = ctx.resolution.combos.find((c) => c.action === input.action && c.direction === input.direction);
  if (!combo?.clip) throw new DomainFailure("coverage_incomplete", `Sem clipe resolvido para ${input.action}/${input.direction}`);
  const tolerance = loadRig(studio.db, projectId, ctx.resolution.rigRevisionId).ref.payload.socketTolerancePx;
  const run = await composeCombo({ config: studio.config, blobs: studio.blobs, db: studio.db }, combo, tolerance, { baseOnly: input.baseOnly });
  const sheet = run.outputs.find((o) => o.role === "sheet")!;
  return {
    status: combo.status,
    sheet: dataUrl(sheet.bytes),
    sheetSha256: sheet.sha256,
    frames: run.report.frames,
    warnings: run.warnings,
    providerCalls: 0,
  };
}

// ---------------------------------------------------------------------------
// Geração: plano congelado + job (a única ação paga)
// ---------------------------------------------------------------------------

export const RunCoverageInput = z.strictObject({
  plan: OverlayCoveragePlanInput,
  /** Peça nova: nome do item (o asset é criado no envio). */
  newItemName: z.string().trim().min(1).max(120).optional(),
  /** Custo desconhecido precisa de aceite explícito. */
  allowUnknownCost: z.boolean().default(false),
  variation: z.number().int().min(0).max(999).default(0),
});

export async function runCoverage(studio: Studio, projectId: string, raw: z.input<typeof RunCoverageInput>) {
  const input = RunCoverageInput.parse(raw);
  const planned = await buildOverlayCoveragePlan(studio, projectId, input.plan);
  if (planned.costCheck.kind === "unknown" && !input.allowUnknownCost) {
    throw new DomainFailure("budget_exceeded", "Custo desconhecido nesta rota: aceite o custo desconhecido explicitamente antes de enviar", { needsConfiguration: true, estimate: planned.plan.limits.estimate });
  }
  if (planned.costCheck.withinCeiling === false) throw new DomainFailure("budget_exceeded", "A estimativa passa do teto autorizado", { estimate: planned.plan.limits.estimate });
  let targetAssetId: string;
  if (planned.plan.operation !== "generate_overlay_coverage") throw new Error("inalcançável");
  if (planned.plan.params.overlayRevisionId) {
    targetAssetId = loadOverlay(studio.db, projectId, planned.plan.params.overlayRevisionId).assetId;
  } else {
    const name = input.newItemName ?? planned.plan.params.itemDescription.slice(0, 60);
    const existing = studio.db.get<{ id: string }>("SELECT id FROM assets WHERE project_id = :p AND family = 'equipment' AND kind = 'overlay' AND name = :n AND archived_at IS NULL", { p: projectId, n: name });
    targetAssetId = existing?.id ?? createAsset(studio.db, studio.clock, { projectId, family: "equipment", kind: "overlay", name }).id;
  }
  const key = `equipment:${planned.digest}:${input.variation}`;
  const { job, created } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId } }, key);
  return { ...planned, job, created, targetAssetId, idempotencyKey: key };
}

/** Reaproveitamento de poses equivalentes sem gerar nada (zero chamadas). */
export const ApplyReuseInput = z.strictObject({
  overlayRevisionId: Id,
  reused: z
    .array(z.strictObject({ clipRevisionId: Id, frameId: Id, partId: Slug, from: z.strictObject({ clipRevisionId: Id, frameId: Id }), reason: z.enum(["existing", "equivalent_pose"]) }))
    .min(1)
    .max(512),
});

export function applyReuse(studio: Studio, projectId: string, raw: z.input<typeof ApplyReuseInput>) {
  const input = ApplyReuseInput.parse(raw);
  const ov = loadOverlay(studio.db, projectId, input.overlayRevisionId);
  const payload: OverlayPayload = structuredClone(ov.payload);
  let applied = 0;
  for (const r of input.reused) {
    const part = payload.parts.find((p) => p.partId === r.partId);
    const source = part?.coverage.find((c) => c.clipRevisionId === r.from.clipRevisionId && c.frameId === r.from.frameId);
    if (!part || !source) continue;
    part.coverage = [...part.coverage.filter((c) => !(c.clipRevisionId === r.clipRevisionId && c.frameId === r.frameId)), { ...source, clipRevisionId: r.clipRevisionId, frameId: r.frameId }];
    applied += 1;
  }
  if (applied === 0) throw new DomainFailure("validation_failed", "Nenhuma célula de origem encontrada para reaproveitar");
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: ov.assetId,
    payload,
    origin: "edit",
    styleRevisionId: ov.styleRevisionId,
    predecessorId: ov.revisionId,
    files: reuseFiles(studio.db, ov.revision, "equipment", "overlay", payload),
    edges: [{ toRevisionId: ov.revisionId, role: "source", ordinal: 0, runtime: false }],
    technicalReport: { operation: "reuse_equivalent_poses", providerCalls: 0, applied, reused: input.reused },
  });
  return { revision, applied };
}
