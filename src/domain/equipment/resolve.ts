import type { LoadoutPayload } from "@/contracts";
import { tx } from "@/i18n/locales";
import { type ClipLookup, lookupClip, requestedCombos } from "./clips";
import { coverageMatrix, type CoverageMatrix } from "./coverage";
import { buildFrameStack, type FrameStack } from "./order";
import { type Occupancy, resolveStance, slotOccupancy, slotPendencies, type StanceResolution } from "./slots";
import { ACTION_LABEL, type ClipRef, type Combo, comboKey, type OverlayRef, type Pendency, type RigRef } from "./types";

/**
 * Resolvedor do conjunto equipado (04 §caso de ponta a ponta): ocupação de
 * slots → revisão de base de cada peça → postura pela combinação → clipe pela
 * chave `(rig, ação, postura, direção)` → pilha de camadas por frame. Cada
 * pendência aponta peça, direção, ação, postura e frame exatos; uma lacuna
 * bloqueia só a combinação (ação/direção) em que aparece.
 *
 * Modo `frozen` (conjunto publicado): os clipes vêm do snapshot, sem nova
 * busca; a busca viva só informa se há versão mais nova a revisar.
 */

export interface ResolveInput {
  rig: RigRef;
  overlays: readonly OverlayRef[];
  /** Todas as revisões de clipe conhecidas do rig (para busca, variantes e revisões anteriores). */
  clips: readonly ClipRef[];
  stance?: string | null;
  pins?: readonly { action: string; direction: Combo["direction"]; clipRevisionId: string }[];
  combos?: readonly Combo[];
  frozen?: boolean;
  drawOrder?: LoadoutPayload["drawOrder"];
  /** Estilo da base, para avisar peças feitas com outro guia de estilo. */
  styleRevisionId?: string | null;
}

export interface ResolvedCombo extends Combo {
  key: string;
  stance: string | null;
  lookup: ClipLookup | null;
  clip: ClipRef | null;
  frames: FrameStack[];
  status: "ready" | "blocked" | "no_clip";
  pendencies: Pendency[];
  /** Busca viva diferente do snapshot (modo frozen): revisão nova disponível. */
  update: { clipRevisionId: string } | null;
}

export interface Resolution {
  rigRevisionId: string;
  occupancy: Occupancy;
  stance: StanceResolution;
  incompatible: string[];
  combos: ResolvedCombo[];
  matrix: CoverageMatrix;
  /** Pendências que afetam o conjunto inteiro (slots, base, postura, estilo). */
  pendencies: Pendency[];
  ready: boolean;
  /** Snapshot publicável (sem as folhas achatadas), ou `null` se a postura não resolveu. */
  snapshot: Omit<LoadoutPayload, "sheets"> | null;
}

export function resolveLoadout(input: ResolveInput): Resolution {
  const { rig } = input;
  const names = new Map(input.overlays.map((o) => [o.revisionId, o.name]));
  const occupancy = slotOccupancy(rig.payload, input.overlays);
  const global: Pendency[] = slotPendencies(occupancy, names);

  const incompatible = input.overlays.filter((o) => o.payload.rigRevisionId !== rig.revisionId).map((o) => o.revisionId);
  for (const o of input.overlays.filter((x) => incompatible.includes(x.revisionId))) {
    global.push({
      kind: "incompatible_rig",
      blocking: true,
      message: tx(
        `${o.name} r${o.number} foi feita para outra base (rig ${o.payload.rigRevisionId}); este conjunto usa ${rig.revisionId}`,
        `${o.name} r${o.number} was made for another base (rig ${o.payload.rigRevisionId}); this loadout uses ${rig.revisionId}`,
      ),
      where: { overlayRevisionId: o.revisionId, overlayName: o.name },
      action: { kind: "create_coverage", label: ACTION_LABEL.create_coverage },
    });
  }
  if (input.styleRevisionId) {
    for (const o of input.overlays) {
      if (o.styleRevisionId && o.styleRevisionId !== input.styleRevisionId) {
        global.push({
          kind: "style_mismatch",
          blocking: false,
          message: tx(`${o.name} r${o.number} foi gerada com outro guia de estilo`, `${o.name} r${o.number} was generated with a different style guide`),
          where: { overlayRevisionId: o.revisionId, overlayName: o.name },
          action: { kind: "review", label: ACTION_LABEL.review },
        });
      }
    }
  }

  const stance = resolveStance(rig.payload, input.overlays, input.stance ?? null);
  if (stance.status === "none") {
    const detail = stance.reasons.map((r) => `${names.get(r.overlayRevisionId) ?? r.overlayRevisionId}: ${r.stances.join("/")}`).join("; ");
    global.push({
      kind: stance.pinnedRejected ? "stance_incompatible" : "stance_none",
      blocking: true,
      message: stance.pinnedRejected
        ? tx(`A postura ${stance.pinnedRejected} não é aceita por todas as peças (${detail})`, `Stance ${stance.pinnedRejected} is not accepted by every piece (${detail})`)
        : tx(`Nenhuma postura do rig serve a todas as peças (${detail})`, `No rig stance fits every piece (${detail})`),
      where: stance.pinnedRejected ? { stance: stance.pinnedRejected } : {},
      action: { kind: "replace_item", label: ACTION_LABEL.replace_item },
    });
  } else if (stance.status === "ambiguous") {
    global.push({
      kind: "stance_ambiguous",
      blocking: true,
      message: tx(`As peças servem a mais de uma postura (${stance.candidates.join(", ")}): escolha uma`, `The pieces fit more than one stance (${stance.candidates.join(", ")}): choose one`),
      where: {},
      action: { kind: "pick_stance", label: ACTION_LABEL.pick_stance },
    });
  }
  const stanceKey = stance.status === "resolved" ? stance.stance : null;
  const globallyBlocked = global.some((p) => p.blocking);
  const compatibleOverlays = input.overlays.filter((o) => !incompatible.includes(o.revisionId));

  const pins = new Map((input.pins ?? []).map((p) => [`${p.action}/${p.direction}`, p.clipRevisionId]));
  const combos = (input.combos ?? requestedCombos(rig.payload, rig.revisionId, input.clips)).map((c) => ({ action: c.action, direction: c.direction }));
  const clipById = new Map(input.clips.map((c) => [c.revisionId, c]));
  const overridesOf = (clipRevisionId: string, frameId: string) => input.drawOrder?.find((o) => o.clipRevisionId === clipRevisionId && o.frameId === frameId)?.layers ?? null;

  const resolved: ResolvedCombo[] = combos.map((combo) => {
    const key = comboKey(combo);
    const pendencies: Pendency[] = [];
    let lookup: ClipLookup | null = null;
    let clip: ClipRef | null = null;
    let update: ResolvedCombo["update"] = null;
    const where = { action: combo.action, direction: combo.direction, ...(stanceKey ? { stance: stanceKey } : {}) };
    if (stanceKey) {
      const pinned = pins.get(key) ?? null;
      if (input.frozen && pinned) {
        clip = clipById.get(pinned) ?? null;
        lookup = clip ? { status: "resolved", clipRevisionId: pinned, link: "exact", candidates: [pinned], pinned: true, outdated: !clip.active } : null;
        const live = lookupClip(input.clips, { rigRevisionId: rig.revisionId, stance: stanceKey, ...combo });
        if (live.status === "resolved" && live.clipRevisionId !== pinned) update = { clipRevisionId: live.clipRevisionId };
        if (!clip) {
          pendencies.push({ kind: "missing_clip", blocking: true, message: tx(`Clipe ${pinned} do snapshot não está disponível`, `Snapshot clip ${pinned} is not available`), where, action: { kind: "review", label: ACTION_LABEL.review } });
        }
      } else {
        lookup = lookupClip(input.clips, { rigRevisionId: rig.revisionId, stance: stanceKey, ...combo }, pinned);
        if (lookup.status === "resolved") clip = clipById.get(lookup.clipRevisionId) ?? null;
        else if (lookup.status === "ambiguous") {
          pendencies.push({
            kind: "ambiguous_clip",
            blocking: true,
            message: tx(
              `${lookup.candidates.length} clipes aprovados servem a ${combo.action}/${combo.direction} em ${stanceKey}: escolha a variante`,
              `${lookup.candidates.length} approved clips fit ${combo.action}/${combo.direction} in ${stanceKey}: choose the variant`,
            ),
            where,
            action: { kind: "pick_variant", label: ACTION_LABEL.pick_variant },
          });
        } else {
          pendencies.push({
            kind: "missing_clip",
            blocking: true,
            message: tx(
              `Falta o clipe ${combo.action} na postura ${stanceKey}, direção ${combo.direction}${
                lookup.linkable.length ? ` (há ${lookup.linkable.length} clipe(s) de outra postura que podem ser vinculados como compartilhados, se a pose servir)` : ""
              }`,
              `Missing clip ${combo.action} in stance ${stanceKey}, direction ${combo.direction}${
                lookup.linkable.length ? ` (${lookup.linkable.length} clip(s) from another stance can be linked as shared, if the pose fits)` : ""
              }`,
            ),
            where,
            action: { kind: "create_variant", label: ACTION_LABEL.create_variant },
          });
        }
      }
    }
    const frames: FrameStack[] = [];
    if (clip) {
      clip.payload.frames.forEach((_, frameIndex) => {
        const stack = buildFrameStack({
          rig: rig.payload,
          clipRevisionId: clip!.revisionId,
          clip: clip!.payload,
          frameIndex,
          overlays: compatibleOverlays,
          override: overridesOf(clip!.revisionId, clip!.payload.frames[frameIndex]!.frameId),
        });
        frames.push(stack);
        const fw = { ...where, clipRevisionId: clip!.revisionId, frameId: stack.frameId };
        for (const gap of stack.gaps) {
          const staleCell = staleFor(compatibleOverlays, gap, clip!, stack.frameId, input.clips);
          pendencies.push(
            staleCell
              ? {
                  kind: "stale_coverage",
                  blocking: true,
                  message: tx(
                    `${gap.overlayName} cobre ${gap.partId === "rigid" ? "a vista rígida" : `a parte ${gap.partId}`} só numa revisão anterior deste clipe (frame ${stack.frameId}): revise ou revincule`,
                    `${gap.overlayName} covers ${gap.partId === "rigid" ? "the rigid view" : `part ${gap.partId}`} only in an earlier revision of this clip (frame ${stack.frameId}): review or rebind`,
                  ),
                  where: { ...fw, overlayRevisionId: gap.overlayRevisionId, overlayName: gap.overlayName, partId: gap.partId },
                  action: { kind: "rebind", label: ACTION_LABEL.rebind },
                }
              : {
                  kind: gap.kind === "rigid" ? "missing_placement" : "missing_coverage",
                  blocking: true,
                  message:
                    gap.kind === "rigid"
                      ? tx(
                          `${gap.overlayName} não está posicionada no frame ${stack.frameId} (${combo.action}/${combo.direction}, ${stanceKey})`,
                          `${gap.overlayName} is not placed in frame ${stack.frameId} (${combo.action}/${combo.direction}, ${stanceKey})`,
                        )
                      : tx(
                          `Falta ${gap.partId} de ${gap.overlayName} no frame ${stack.frameId} (${combo.action}/${combo.direction}, ${stanceKey})`,
                          `Missing ${gap.partId} of ${gap.overlayName} in frame ${stack.frameId} (${combo.action}/${combo.direction}, ${stanceKey})`,
                        ),
                  where: { ...fw, overlayRevisionId: gap.overlayRevisionId, overlayName: gap.overlayName, partId: gap.partId },
                  action: { kind: "create_coverage", label: gap.kind === "rigid" ? tx("Posicionar vista", "Place view") : tx("Criar cobertura", "Create coverage") },
                },
          );
        }
        for (const issue of stack.issues) {
          pendencies.push({
            kind: issue.kind,
            blocking: issue.kind !== "socket_deviation",
            message: issue.message,
            where: { ...fw, overlayRevisionId: issue.overlayRevisionId, overlayName: issue.overlayName },
            action:
              issue.kind === "clipped_outline"
                ? { kind: "expand_cell", label: ACTION_LABEL.expand_cell }
                : { kind: "fix_grips", label: ACTION_LABEL.fix_grips },
          });
        }
        for (const problem of stack.override.problems) {
          pendencies.push({ kind: "invalid_override", blocking: true, message: problem, where: fw, action: { kind: "reset_order", label: ACTION_LABEL.reset_order } });
        }
      });
    }
    const blocking = globallyBlocked || pendencies.some((p) => p.blocking);
    return {
      ...combo,
      key,
      stance: stanceKey,
      lookup,
      clip,
      frames,
      status: !clip ? "no_clip" : blocking ? "blocked" : "ready",
      pendencies,
      update,
    };
  });

  const matrix = coverageMatrix({
    rigRevisionId: rig.revisionId,
    overlays: input.overlays,
    combos: resolved.filter((c) => c.clip).map((c) => ({ action: c.action, direction: c.direction, stance: c.stance, clip: c.clip! })),
    clipAssetOf: (id) => clipById.get(id)?.assetId,
  });

  const snapshot: Resolution["snapshot"] =
    stance.status === "resolved"
      ? {
          rigRevisionId: rig.revisionId,
          overlayRevisionIds: input.overlays.map((o) => o.revisionId),
          stance: stance.stance,
          stancePolicy: stance.policy,
          clips: resolved
            .filter((c) => c.clip)
            .map((c) => ({
              action: c.action,
              direction: c.direction,
              clipRevisionId: c.clip!.revisionId,
              link: c.lookup?.status === "resolved" ? c.lookup.link : "exact",
            })),
          ...(input.drawOrder?.length ? { drawOrder: input.drawOrder.filter((o) => resolved.some((c) => c.clip?.revisionId === o.clipRevisionId)) } : {}),
        }
      : null;

  return {
    rigRevisionId: rig.revisionId,
    occupancy,
    stance,
    incompatible,
    combos: resolved,
    matrix,
    pendencies: global,
    ready: !globallyBlocked && resolved.every((c) => c.status === "ready"),
    snapshot,
  };
}

function staleFor(overlays: readonly OverlayRef[], gap: { overlayRevisionId: string; partId: string; kind: "part" | "rigid" }, clip: ClipRef, frameId: string, clips: readonly ClipRef[]): boolean {
  const ov = overlays.find((o) => o.revisionId === gap.overlayRevisionId);
  if (!ov) return false;
  const assetOf = (id: string) => clips.find((c) => c.revisionId === id)?.assetId;
  const refs =
    gap.kind === "rigid"
      ? (ov.payload.rigidPlacements ?? []).map((p) => ({ clipRevisionId: p.clipRevisionId, frameId: p.frameId }))
      : (ov.payload.parts.find((p) => p.partId === gap.partId)?.coverage ?? []);
  return refs.some((c) => c.frameId === frameId && c.clipRevisionId !== clip.revisionId && assetOf(c.clipRevisionId) === clip.assetId);
}

/**
 * Verificador da exportação (04 §critérios: "o verificador aponta peça,
 * direção, ação, postura e frame exatos"): pendências bloqueantes das
 * combinações congeladas no conjunto. Avisos não bloqueiam.
 */
export function exportBlockers(resolution: Resolution): Pendency[] {
  return [...resolution.pendencies, ...resolution.combos.flatMap((c) => c.pendencies)].filter((p) => p.blocking);
}
