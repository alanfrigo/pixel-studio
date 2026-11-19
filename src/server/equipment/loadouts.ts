import { z } from "zod";
import { Direction, Id, type LoadoutPayload, Slug } from "@/contracts";
import { exportBlockers, type ResolvedCombo } from "@/domain/equipment/resolve";
import { replaceConflicting } from "@/domain/equipment/slots";
import { comboKey, describeWhere } from "@/domain/equipment/types";
import { tx } from "@/i18n/locales";
import { createAsset, getAsset, getProject, publishRevision, type PublishFile } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { loadLoadout, loadOverlay, loadRig } from "./load";
import { storeOutput } from "./python";
import { composeCombo, LoadoutConfig, resolveConfig, resolutionView } from "./resolve";

/**
 * Conjuntos equipados (04 §contratos: "referências às revisões de peças
 * escolhidas e política de resolução da postura"). Publicar congela o
 * snapshot — peças, postura e o clipe de cada combinação — e, sob demanda, a
 * folha achatada de cada combinação completa. Tudo local: zero chamadas pagas.
 * A aprovação segue o fluxo de revisão existente.
 */

export const PublishLoadoutInput = z.strictObject({
  /** Conjunto existente que recebe a nova revisão; ausente = conjunto novo. */
  assetId: Id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  config: LoadoutConfig,
  /** Folha achatada de cada combinação completa (consumidores que só leem PNG). */
  flatten: z.boolean().default(true),
  /** Subconjunto explicitamente completo: só estas combinações; as demais ficam declaradas como omitidas. */
  subset: z
    .strictObject({
      combos: z.array(z.strictObject({ action: Slug, direction: Direction })).min(1).max(64),
      reason: z.string().trim().min(1).max(300),
    })
    .optional(),
});
export type PublishLoadoutInput = z.input<typeof PublishLoadoutInput>;

export async function publishLoadout(studio: Studio, projectId: string, raw: PublishLoadoutInput) {
  const input = PublishLoadoutInput.parse(raw);
  const ctx = resolveConfig(studio, projectId, input.config);
  const { resolution } = ctx;
  const global = resolution.pendencies.filter((p) => p.blocking);
  if (global.length > 0 || !resolution.snapshot) {
    throw new DomainFailure("validation_failed", global[0]?.message ?? tx("Conjunto sem postura resolvida", "Loadout has no resolved stance"), { pendencies: global });
  }
  const wanted = input.subset ? new Set(input.subset.combos.map(comboKey)) : new Set(resolution.combos.map((c) => c.key));
  const unknown = [...wanted].filter((k) => !resolution.combos.some((c) => c.key === k));
  if (unknown.length) throw new DomainFailure("validation_failed", tx(`Combinações fora do pedido: ${unknown.join(", ")}`, `Combinations not in the request: ${unknown.join(", ")}`));
  const included = resolution.combos.filter((c) => wanted.has(c.key));
  const noClip = included.filter((c) => !c.clip);
  if (noClip.length > 0) {
    const pend = noClip.flatMap((c) => c.pendencies);
    throw new DomainFailure(
      "coverage_incomplete",
      tx(
        `Sem clipe para ${noClip.map((c) => c.key).join(", ")}: crie a variante ou publique um subconjunto explícito`,
        `No clip for ${noClip.map((c) => c.key).join(", ")}: create the variant or publish an explicit subset`,
      ),
      { pendencies: pend },
    );
  }
  if (input.subset) {
    const notReady = included.filter((c) => c.status !== "ready");
    if (notReady.length > 0) {
      const blockers = notReady.flatMap((c) => c.pendencies.filter((p) => p.blocking));
      const first = blockers[0];
      const where = first ? describeWhere(first.where) : null;
      throw new DomainFailure(
        "coverage_incomplete",
        tx(
          `O subconjunto não está completo: ${first ? `${first.message["pt-BR"]} (${where!["pt-BR"]})` : notReady[0]!.key}`,
          `The subset is not complete: ${first ? `${first.message.en} (${where!.en})` : notReady[0]!.key}`,
        ),
        { pendencies: blockers },
      );
    }
  }

  const files: PublishFile[] = [];
  const sheets: NonNullable<LoadoutPayload["sheets"]> = [];
  const flattenReports: Record<string, unknown>[] = [];
  if (input.flatten) {
    const rig = loadRig(studio.db, projectId, input.config.rigRevisionId);
    for (const combo of included.filter((c) => c.status === "ready")) {
      const run = await composeCombo({ config: studio.config, blobs: studio.blobs, db: studio.db }, combo, rig.ref.payload.socketTolerancePx);
      const sheet = run.outputs.find((o) => o.role === "sheet")!;
      const blob = await storeOutput(studio.blobs, sheet);
      const fileKey = `sheet-${combo.action}-${combo.direction}`.toLowerCase();
      files.push({ fileKey, role: "flattened", idx: sheets.length, blob });
      const frames = (run.report.frames as { frameId: string; rect: [number, number, number, number]; rgbaSha256: string }[]).map((f) => ({ frameId: f.frameId, rect: f.rect }));
      sheets.push({ clipRevisionId: combo.clip!.revisionId, fileId: fileKey, frames });
      flattenReports.push({ combo: combo.key, sheetSha256: blob.sha256, frames: run.report.frames, warnings: run.warnings });
    }
  }

  const snapshot = resolution.snapshot;
  const includedClips = new Set(included.map((c) => c.clip!.revisionId));
  const omitted = resolution.combos.filter((c) => !wanted.has(c.key)).map((c) => ({ action: c.action, direction: c.direction, reason: input.subset!.reason }));
  const payload: LoadoutPayload = {
    ...snapshot,
    clips: snapshot.clips.filter((c) => wanted.has(comboKey(c))),
    ...(snapshot.drawOrder ? { drawOrder: snapshot.drawOrder.filter((o) => includedClips.has(o.clipRevisionId)) } : {}),
    ...(omitted.length ? { omitted } : {}),
    ...(sheets.length ? { sheets } : {}),
  };
  if (payload.drawOrder && payload.drawOrder.length === 0) delete payload.drawOrder;

  let assetId = input.assetId;
  if (assetId) {
    const asset = getAsset(studio.db, projectId, assetId);
    if (asset.family !== "equipment" || asset.kind !== "loadout") throw new DomainFailure("validation_failed", tx(`${asset.name} não é um conjunto`, `${asset.name} is not a loadout`));
  } else {
    const names = ctx.overlays.map((o) => o.name).join(" + ");
    assetId = createAsset(studio.db, studio.clock, { projectId, family: "equipment", kind: "loadout", name: (input.name ?? `Conjunto: ${names || "sem peças"}`).slice(0, 120) }).id;
  }
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId,
    payload,
    origin: "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    files,
    technicalReport: {
      operation: "publish_loadout",
      providerCalls: 0,
      stance: resolution.stance,
      combos: resolution.combos.map((c) => ({ key: c.key, status: c.status, clipRevisionId: c.clip?.revisionId ?? null, link: c.lookup?.status === "resolved" ? c.lookup.link : null })),
      subset: input.subset ?? null,
      blockers: exportBlockers(resolution).filter((p) => included.some((c) => c.pendencies.includes(p)) || resolution.pendencies.includes(p)),
      flattened: flattenReports,
    },
  });
  return { revision, view: resolutionView(studio.db, projectId, ctx), included: included.map((c) => c.key), omitted };
}

// ---------------------------------------------------------------------------
// Troca de item em uma operação
// ---------------------------------------------------------------------------

export const SwapInput = z.strictObject({
  loadoutRevisionId: Id,
  incomingOverlayRevisionId: Id,
  flatten: z.boolean().default(true),
});

/**
 * Equipa a peça retirando quem disputa os slots (ex.: espada longa tira o
 * escudo), recalcula a postura e os clipes e publica a revisão nova do mesmo
 * conjunto. Overrides de ordem que citavam a peça retirada são descartados e
 * relatados. Nenhuma geração.
 */
export async function swapItem(studio: Studio, projectId: string, raw: z.input<typeof SwapInput>) {
  const input = SwapInput.parse(raw);
  const loadout = loadLoadout(studio.db, projectId, input.loadoutRevisionId);
  const current = loadout.payload.overlayRevisionIds.map((id) => loadOverlay(studio.db, projectId, id));
  const incoming = loadOverlay(studio.db, projectId, input.incomingOverlayRevisionId);
  const replacement = replaceConflicting(current, incoming);
  const removed = new Set(replacement.removed);
  const keptOrder = (loadout.payload.drawOrder ?? []).filter((o) => !o.layers.some((l) => l.kind !== "base" && removed.has(l.overlayRevisionId)));
  const droppedOrder = (loadout.payload.drawOrder ?? []).length - keptOrder.length;
  const config = {
    rigRevisionId: loadout.payload.rigRevisionId,
    overlayRevisionIds: replacement.overlayRevisionIds,
    stance: null,
    pins: loadout.payload.clips.map((c) => ({ action: c.action, direction: c.direction, clipRevisionId: c.clipRevisionId })),
    combos: [...loadout.payload.clips, ...(loadout.payload.omitted ?? [])].map((c) => ({ action: c.action, direction: c.direction })),
    ...(keptOrder.length ? { drawOrder: keptOrder } : {}),
  };
  const published = await publishLoadout(studio, projectId, { assetId: loadout.assetId, config, flatten: input.flatten });
  return { ...published, replacement, droppedOrderOverrides: droppedOrder };
}

/** Rascunho: equipar sem publicar (o editor mostra o conflito resolvido antes de salvar). */
export function equipInConfig(studio: Pick<Studio, "db">, projectId: string, config: z.input<typeof LoadoutConfig>, incomingOverlayRevisionId: string) {
  const parsed = LoadoutConfig.parse(config);
  const current = parsed.overlayRevisionIds.map((id) => loadOverlay(studio.db, projectId, id));
  const incoming = loadOverlay(studio.db, projectId, incomingOverlayRevisionId);
  const replacement = replaceConflicting(current, incoming);
  const removed = new Set(replacement.removed);
  return {
    replacement,
    config: {
      ...parsed,
      overlayRevisionIds: replacement.overlayRevisionIds,
      stance: null,
      ...(parsed.drawOrder ? { drawOrder: parsed.drawOrder.filter((o) => !o.layers.some((l) => l.kind !== "base" && removed.has(l.overlayRevisionId))) } : {}),
    },
  };
}

export function comboReady(c: ResolvedCombo): boolean {
  return c.status === "ready";
}
