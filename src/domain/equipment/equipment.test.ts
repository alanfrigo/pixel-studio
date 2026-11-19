import { describe, expect, it } from "vitest";
import { ClipPayload, LoadoutPayload, OverlayPayload, parseRevisionPayload, type RigPayload } from "@/contracts";
import { gripInView, marginsToFit, mirrorLayerOffset, mirrorPivot, mirrorSocket, overflow, rigidOrigin } from "./attach";
import { expandClipCell, shiftOverlayForExpansion } from "./cell";
import { lookupClip, requestedCombos } from "./clips";
import { equivalentCells, frameDigest, rebindOverlay } from "./digest";
import { buildFrameStack } from "./order";
import { exportBlockers, resolveLoadout } from "./resolve";
import { replaceConflicting, resolveStance, slotOccupancy } from "./slots";
import { defaultDrawIndex, planStrips, stripCanvas, stripLayout } from "./template";
import type { ClipRef, OverlayRef, RigRef } from "./types";

// ---------------------------------------------------------------------------
// Guerreiro de teste: rig, ataques de 4 (escudo) e 6 frames (duas mãos), peças
// ---------------------------------------------------------------------------

const RIG_ID = "rig-1";
const rigPayload: RigPayload = {
  baseRevisionId: "base-1",
  logicalCell: [64, 64],
  groundOrigin: [32, 60],
  directions: ["S", "E"],
  mirror: { policy: "none" },
  slots: [
    { slotId: "main_hand", label: "Mão principal" },
    { slotId: "off_hand", label: "Mão secundária" },
    { slotId: "torso", label: "Torso" },
  ],
  sockets: [
    { socketId: "hand_right", anatomicalSide: "right", purpose: "grip" },
    { socketId: "hand_left", anatomicalSide: "left", purpose: "grip" },
  ],
  parts: [
    { partId: "body", label: "Corpo" },
    { partId: "arm_near", label: "Braço próximo" },
    { partId: "torso", label: "Torso" },
    { partId: "sleeve_near", label: "Manga próxima" },
  ],
  stances: ["one_hand_shield", "two_handed"],
  socketTolerancePx: 1,
};
const rig: RigRef = { revisionId: RIG_ID, payload: rigPayload };

const OSH = { ids: ["windup", "advance", "contact", "recover"], ms: [140, 80, 60, 160] };
const TH = { ids: ["guard", "raise", "windup", "contact", "follow", "recover"], ms: [120, 100, 90, 60, 110, 180] };

function clip(id: string, stance: string, direction: "S" | "E", frames: { ids: string[]; ms: number[] }, extra: Partial<ClipPayload> = {}, assetId = `asset-${id}`): ClipRef {
  const payload: ClipPayload = {
    rigRevisionId: RIG_ID,
    motionRevisionId: null,
    action: "attack",
    state: null,
    stance,
    direction,
    logicalSize: [64, 64],
    pivot: [32, 60],
    margins: { left: 0, right: 0, top: 0, bottom: 0 },
    playback: "once",
    frames: frames.ids.map((frameId, i) => ({
      frameId,
      durationMs: frames.ms[i]!,
      layers: [
        { partId: "body", fileId: `${id}-body`, rect: [i * 64, 0, 64, 64], offset: [0, 0] },
        { partId: "arm_near", fileId: `${id}-arm`, rect: [i * 16, 0, 16, 24], offset: [36, 22] },
      ],
      sockets: [
        { socketId: "hand_right", at: [40 + i, 34], hidden: false },
        { socketId: "hand_left", at: stance === "two_handed" ? [40 + i, 37] : [22, 36], hidden: stance !== "two_handed" },
      ],
      rootOffset: [0, 0],
    })),
    events: [],
    ...extra,
  };
  return { revisionId: id, assetId, name: `Ataque ${stance} ${direction}`, number: 1, status: "approved", active: true, payload: ClipPayload.parse(payload) };
}

const clips: ClipRef[] = [clip("osh-s", "one_hand_shield", "S", OSH), clip("osh-e", "one_hand_shield", "E", OSH), clip("th-s", "two_handed", "S", TH), clip("th-e", "two_handed", "E", TH)];

function coverage(partId: string, drawIndex: number, skip: { clip: string; frame: string } | null = null, empty: string[] = []) {
  return {
    partId,
    coverage: clips.flatMap((c) =>
      c.payload.frames
        .filter((f) => !(skip && skip.clip === c.revisionId && skip.frame === f.frameId))
        .map((f, i) => ({
          clipRevisionId: c.revisionId,
          frameId: f.frameId,
          layer: empty.includes(f.frameId) && c.revisionId.startsWith("osh") ? null : { fileId: `mail-${partId}`, rect: [i * 20, 0, 20, 16] as [number, number, number, number], offset: [22, 22] as [number, number] },
          drawIndex,
        })),
    ),
  };
}

function overlay(id: string, name: string, payload: Omit<OverlayPayload, "itemRevisionId" | "rigRevisionId"> & { rigRevisionId?: string }): OverlayRef {
  return {
    revisionId: id,
    assetId: `asset-${id}`,
    name,
    number: 1,
    status: "approved",
    styleRevisionId: "style-1",
    payload: OverlayPayload.parse({ itemRevisionId: null, rigRevisionId: RIG_ID, ...payload }),
  };
}

const mail = (skip: { clip: string; frame: string } | null = null) =>
  overlay("mail", "Cota de malha", { slots: ["torso"], stances: ["one_hand_shield", "two_handed"], parts: [coverage("torso", 0), coverage("sleeve_near", 1, skip, ["contact"])], rigidViews: [] });

const placements = (stance: string, socket: string, drawIndex: number, view = "v") =>
  clips.filter((c) => c.payload.stance === stance).flatMap((c) => c.payload.frames.map((f) => ({ clipRevisionId: c.revisionId, frameId: f.frameId, viewId: view, anchorSocketId: socket, drawIndex })));

const shortSword = overlay("sword", "Espada curta", {
  slots: ["main_hand"],
  stances: ["one_hand_shield"],
  parts: [],
  rigidViews: [{ viewId: "v", fileId: "sword", rect: [0, 0, 6, 20], grips: [{ socketId: "hand_right", at: [2, 16] }] }],
  rigidPlacements: placements("one_hand_shield", "hand_right", 0),
});
const shield = overlay("shield", "Escudo", {
  slots: ["off_hand"],
  stances: ["one_hand_shield"],
  parts: [],
  rigidViews: [{ viewId: "v", fileId: "shield", rect: [0, 0, 10, 12], grips: [{ socketId: "hand_left", at: [5, 6] }] }],
  rigidPlacements: placements("one_hand_shield", "hand_left", 2),
});
const longSword = overlay("long", "Espada longa", {
  slots: ["main_hand", "off_hand"],
  stances: ["two_handed"],
  parts: [],
  // Duas empunhaduras: mão direita em (2, 20), esquerda 3 px abaixo.
  rigidViews: [{ viewId: "v", fileId: "long", rect: [0, 0, 6, 30], grips: [{ socketId: "hand_right", at: [2, 20] }, { socketId: "hand_left", at: [2, 23] }] }],
  rigidPlacements: placements("two_handed", "hand_right", 0),
});

// ---------------------------------------------------------------------------

describe("encaixe e espelho (04 §exemplo de encaixe)", () => {
  it("origem = socket − empunhadura; espelho usa W−1−x no índice e W−x no pivô", () => {
    expect(rigidOrigin([39, 34], [3, 22], 12, false)).toEqual([36, 12]);
    // Espada de 12 px espelhada: empunhadura x=3 vira 12−1−3 = 8 → origem 39−8 = 31.
    expect(gripInView([3, 22], 12, true)).toEqual([8, 22]);
    expect(rigidOrigin([39, 34], [3, 22], 12, true)).toEqual([31, 12]);
    expect(mirrorSocket([39, 34], 64)).toEqual([24, 34]);
    expect(mirrorPivot([32, 60], 64)).toEqual([32, 60]);
    expect(mirrorPivot([0, 60], 64)).toEqual([64, 60]);
    expect(mirrorLayerOffset([40, 24], 8, 64)).toEqual([16, 24]);
  });

  it("estouro por borda e margem que faz tudo caber", () => {
    expect(overflow([60, -2], [10, 10], [64, 64])).toEqual({ left: 0, top: 2, right: 6, bottom: 0 });
    expect(marginsToFit([overflow([60, -2], [10, 10], [64, 64]), overflow([-3, 10], [10, 10], [64, 64])])).toEqual({ left: 3, top: 2, right: 6, bottom: 0 });
  });
});

describe("slots, substituição e postura", () => {
  it("espada longa ocupa as duas mãos: conflito com o escudo e substituição em uma operação", () => {
    const occ = slotOccupancy(rigPayload, [mail(), shortSword, shield, longSword]);
    expect(occ.conflicts.map((c) => c.slotId).sort()).toEqual(["main_hand", "off_hand"]);
    const swap = replaceConflicting([mail(), shortSword, shield], longSword);
    expect(swap.removed).toEqual(["sword", "shield"]);
    expect(swap.overlayRevisionIds).toEqual(["mail", "long"]);
    expect(swap.freedSlots).toEqual([]);
    const back = replaceConflicting([mail(), longSword], shield);
    expect(back.removed).toEqual(["long"]);
    expect(back.freedSlots).toEqual(["main_hand"]);
  });

  it("postura pela combinação; cota sozinha é ambígua; escudo + espada longa não tem postura", () => {
    expect(resolveStance(rigPayload, [mail(), shortSword, shield])).toMatchObject({ status: "resolved", stance: "one_hand_shield", policy: "auto" });
    expect(resolveStance(rigPayload, [mail(), longSword])).toMatchObject({ status: "resolved", stance: "two_handed" });
    expect(resolveStance(rigPayload, [mail()])).toMatchObject({ status: "ambiguous", candidates: ["one_hand_shield", "two_handed"] });
    expect(resolveStance(rigPayload, [mail()], "two_handed")).toMatchObject({ status: "resolved", policy: "pinned" });
    expect(resolveStance(rigPayload, [shield, longSword])).toMatchObject({ status: "none" });
  });
});

describe("busca de clipe pela chave (rig, ação, postura, direção)", () => {
  it("exato, variante fixada pelo artista e vínculo compartilhado explícito", () => {
    const key = { rigRevisionId: RIG_ID, action: "attack", stance: "two_handed", direction: "S" as const };
    expect(lookupClip(clips, key)).toMatchObject({ status: "resolved", clipRevisionId: "th-s", link: "exact" });
    const variant = clip("th-s-b", "two_handed", "S", TH);
    expect(lookupClip([...clips, variant], key)).toMatchObject({ status: "ambiguous", link: "variant", candidates: ["th-s", "th-s-b"] });
    expect(lookupClip([...clips, variant], key, "th-s-b")).toMatchObject({ status: "resolved", clipRevisionId: "th-s-b", link: "variant", pinned: true });
    const walk = { ...clip("walk-s", "one_hand_shield", "S", OSH), payload: { ...clip("walk-s", "one_hand_shield", "S", OSH).payload, action: "walk" } };
    const walkKey = { ...key, action: "walk" };
    expect(lookupClip([walk], walkKey)).toMatchObject({ status: "missing", linkable: ["walk-s"] });
    const shared = { ...walk, payload: { ...walk.payload, sharedStances: ["two_handed"] } };
    expect(lookupClip([shared], walkKey)).toMatchObject({ status: "resolved", link: "shared" });
    expect(requestedCombos(rigPayload, RIG_ID, clips)).toEqual([
      { action: "attack", direction: "S" },
      { action: "attack", direction: "E" },
    ]);
  });
});

describe("pilha do frame: ordem, vazio explícito e override", () => {
  it("a mão próxima cobre a empunhadura; célula vazia não é lacuna; override reordena", () => {
    const osh = clips[0]!;
    const contact = buildFrameStack({ rig: rigPayload, clipRevisionId: osh.revisionId, clip: osh.payload, frameIndex: 2, overlays: [mail(), shortSword, shield] });
    expect(contact.layers.map((l) => l.key)).toEqual(["base:body", "part:mail:torso", "rigid:sword", "base:arm_near", "rigid:shield"]);
    expect(contact.empty).toEqual([{ overlayRevisionId: "mail", partId: "sleeve_near" }]);
    expect(contact.gaps).toEqual([]);
    const sword = contact.layers.find((l) => l.key === "rigid:sword")!;
    expect(sword.offset).toEqual([42 - 2, 34 - 16]);
    const swapped = buildFrameStack({
      rig: rigPayload,
      clipRevisionId: osh.revisionId,
      clip: osh.payload,
      frameIndex: 2,
      overlays: [mail(), shortSword, shield],
      override: [
        { kind: "base", partId: "body" },
        { kind: "part", overlayRevisionId: "mail", partId: "torso" },
        { kind: "base", partId: "arm_near" },
        { kind: "rigid", overlayRevisionId: "sword" },
        { kind: "rigid", overlayRevisionId: "shield" },
      ],
    });
    expect(swapped.override.applied).toBe(true);
    expect(swapped.layers.map((l) => l.key).slice(2, 4)).toEqual(["base:arm_near", "rigid:sword"]);
    const stale = buildFrameStack({ rig: rigPayload, clipRevisionId: osh.revisionId, clip: osh.payload, frameIndex: 2, overlays: [mail()], override: [{ kind: "base", partId: "body" }] });
    expect(stale.override.applied).toBe(false);
    expect(stale.override.problems[0]).toMatch(/não posiciona/);
  });

  it("segunda mão acima da tolerância sinaliza desvio; contorno cortado mostra os limites", () => {
    const th = clips[2]!;
    const ok = buildFrameStack({ rig: rigPayload, clipRevisionId: th.revisionId, clip: th.payload, frameIndex: 0, overlays: [longSword] });
    expect(ok.layers.find((l) => l.key === "rigid:long")!.grips.find((g) => !g.anchor)).toMatchObject({ deviation: 0, exceeds: false });
    const moved = { ...th.payload, frames: th.payload.frames.map((f, i) => (i === 3 ? { ...f, sockets: f.sockets.map((s) => (s.socketId === "hand_left" ? { ...s, at: [s.at[0] + 2, s.at[1]] as [number, number] } : s)) } : f)) };
    const bad = buildFrameStack({ rig: rigPayload, clipRevisionId: th.revisionId, clip: moved, frameIndex: 3, overlays: [longSword] });
    expect(bad.issues).toEqual([expect.objectContaining({ kind: "socket_deviation", socketId: "hand_left", deviation: 2 })]);
    const oneOff = { ...th.payload, frames: th.payload.frames.map((f) => ({ ...f, sockets: f.sockets.map((s) => (s.socketId === "hand_left" ? { ...s, at: [s.at[0] + 1, s.at[1]] as [number, number] } : s)) })) };
    expect(buildFrameStack({ rig: rigPayload, clipRevisionId: th.revisionId, clip: oneOff, frameIndex: 1, overlays: [longSword] }).issues).toEqual([]);
    const high = { ...th.payload, frames: th.payload.frames.map((f) => ({ ...f, sockets: f.sockets.map((s) => ({ ...s, at: [s.at[0], 12] as [number, number] })) })) };
    const clipped = buildFrameStack({ rig: rigPayload, clipRevisionId: th.revisionId, clip: high, frameIndex: 0, overlays: [longSword] });
    expect(clipped.issues[0]).toMatchObject({ kind: "clipped_outline", overflow: { top: 8 } });
  });
});

describe("resolvedor do conjunto e matriz de cobertura", () => {
  it("mesma cota nos dois conjuntos: ataques distintos (4 e 6 frames) e 40 poses quando há 4 vistas", () => {
    const a = resolveLoadout({ rig, overlays: [mail(), shortSword, shield], clips });
    const b = resolveLoadout({ rig, overlays: [mail(), longSword], clips });
    expect(a.ready && b.ready).toBe(true);
    expect(a.combos.map((c) => [c.key, c.clip!.revisionId, c.frames.map((f) => f.durationMs)])).toEqual([
      ["attack/S", "osh-s", OSH.ms],
      ["attack/E", "osh-e", OSH.ms],
    ]);
    expect(b.combos.map((c) => c.clip!.payload.frames.map((f) => f.durationMs))).toEqual([TH.ms, TH.ms]);
    // Duas vistas aqui: 2 × (4 + 6) = 20 poses por parte da cota; com 4 vistas seriam 40.
    const torsoRowA = a.matrix.rows.findIndex((r) => r.partId === "torso");
    const combined = resolveLoadout({ rig, overlays: [mail()], clips, stance: "two_handed" });
    expect(a.matrix.counts[torsoRowA]!.total + combined.matrix.counts[0]!.total).toBe(2 * (4 + 6));
    expect(a.snapshot).toMatchObject({ stance: "one_hand_shield", stancePolicy: "auto", overlayRevisionIds: ["mail", "sword", "shield"] });
    expect(LoadoutPayload.safeParse(a.snapshot).success).toBe(true);
  });

  it("lacuna de uma manga bloqueia só a composição afetada, com ponteiro exato", () => {
    const gap = mail({ clip: "th-e", frame: "follow" });
    const b = resolveLoadout({ rig, overlays: [gap, longSword], clips });
    expect(b.combos.map((c) => [c.key, c.status])).toEqual([
      ["attack/S", "ready"],
      ["attack/E", "blocked"],
    ]);
    const blockers = exportBlockers(b);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      kind: "missing_coverage",
      where: { overlayName: "Cota de malha", partId: "sleeve_near", direction: "E", action: "attack", stance: "two_handed", frameId: "follow" },
      action: { kind: "create_coverage" },
    });
    // O conjunto A, com a mesma cota, continua completo.
    expect(resolveLoadout({ rig, overlays: [gap, shortSword, shield], clips }).ready).toBe(true);
    const e = b.matrix.columns.findIndex((c) => c.clipRevisionId === "th-e" && c.frameId === "follow");
    expect(b.matrix.cells[b.matrix.rows.findIndex((r) => r.partId === "sleeve_near")]![e]).toBe("missing");
  });

  it("peça de outra base: revisão incompatível com ação de criar cobertura; conflito pede substituição", () => {
    const foreign = { ...mail(), revisionId: "mail-other", payload: { ...mail().payload, rigRevisionId: "rig-other" } };
    const r = resolveLoadout({ rig, overlays: [foreign, longSword], clips });
    expect(r.pendencies[0]).toMatchObject({ kind: "incompatible_rig", action: { kind: "create_coverage" } });
    expect(r.ready).toBe(false);
    const conflict = resolveLoadout({ rig, overlays: [mail(), shield, longSword], clips });
    expect(conflict.pendencies.filter((p) => p.kind === "slot_conflict").map((p) => p.action.label)).toEqual(["Substituir Escudo por Espada longa"]);
  });

  it("clipe faltante produz pendência Criar variante só naquela combinação", () => {
    const r = resolveLoadout({ rig, overlays: [mail(), longSword], clips: clips.filter((c) => c.revisionId !== "th-e") });
    expect(r.combos.find((c) => c.direction === "E")).toMatchObject({ status: "no_clip", pendencies: [expect.objectContaining({ kind: "missing_clip", action: { kind: "create_variant", label: "Criar variante" } })] });
    expect(r.combos.find((c) => c.direction === "S")!.status).toBe("ready");
  });
});

describe("ampliar célula, digest e revinculação", () => {
  it("ampliar desloca camadas, sockets, pivô e coberturas pela mesma margem", () => {
    const th = clips[2]!;
    const add = { left: 4, right: 6, top: 8, bottom: 0 };
    const big = expandClipCell(th.payload, add);
    expect(big.logicalSize).toEqual([74, 72]);
    expect(big.pivot).toEqual([36, 68]);
    expect(big.margins).toEqual(add);
    expect(big.frames[0]!.sockets[0]!.at).toEqual([44, 42]);
    expect(big.frames[0]!.layers[1]!.offset).toEqual([40, 30]);
    expect(ClipPayload.safeParse(big).success).toBe(true);
    const moved = shiftOverlayForExpansion(mail().payload, "th-s", "th-s-big", add);
    const cell = moved.payload.parts[0]!.coverage.find((c) => c.clipRevisionId === "th-s-big" && c.frameId === "guard")!;
    expect(cell.layer!.offset).toEqual([26, 30]);
    expect(moved.payload.parts[0]!.coverage.some((c) => c.clipRevisionId === "th-s")).toBe(true);
    const placed = shiftOverlayForExpansion(longSword.payload, "th-s", "th-s-big", add).payload.rigidPlacements!.filter((p) => p.clipRevisionId === "th-s-big");
    expect(placed).toHaveLength(6);
    // Vista rígida segue o socket (já deslocado): origem desloca a mesma margem.
    const before = buildFrameStack({ rig: rigPayload, clipRevisionId: "th-s", clip: th.payload, frameIndex: 0, overlays: [longSword] }).layers.at(-1)!.offset;
    const after = buildFrameStack({
      rig: rigPayload,
      clipRevisionId: "th-s-big",
      clip: big,
      frameIndex: 0,
      overlays: [{ ...longSword, payload: shiftOverlayForExpansion(longSword.payload, "th-s", "th-s-big", add).payload }],
    }).layers.at(-1)!.offset;
    expect([after[0] - before[0], after[1] - before[1]]).toEqual([4, 8]);
  });

  it("retimar mantém o digest; mudar a pose de contato pede revisão só daquele frame", () => {
    const osh = clips[0]!.payload;
    const hashes = (i: number) => [`body-${i}`, `arm-${i}`];
    const digests = (c: ClipPayload, override: Record<number, string[]> = {}) =>
      Object.fromEntries(c.frames.map((f, i) => [f.frameId, frameDigest(c, i, override[i] ?? hashes(i))]));
    const retimed = { ...osh, frames: osh.frames.map((f) => ({ ...f, durationMs: f.durationMs + 20 })) };
    expect(digests(retimed)).toEqual(digests(osh));
    const newContact = digests(osh, { 2: ["body-2-novo", "arm-2"] });
    const r = rebindOverlay(mail().payload, { revisionId: "osh-s", digests: digests(osh) }, { revisionId: "osh-s-v2", frameIds: OSH.ids, digests: newContact });
    expect(r.review).toEqual([
      { partId: "torso", frameId: "contact", reason: "geometry_changed" },
      { partId: "sleeve_near", frameId: "contact", reason: "geometry_changed" },
    ]);
    expect(r.rebound).toHaveLength(6);
    const torso = r.payload.parts[0]!.coverage;
    expect(torso.filter((c) => c.clipRevisionId === "osh-s")).toHaveLength(4);
    expect(torso.find((c) => c.clipRevisionId === "osh-s-v2" && c.frameId === "windup")!.layer).toEqual(torso.find((c) => c.clipRevisionId === "osh-s" && c.frameId === "windup")!.layer);
    expect(OverlayPayload.safeParse(r.payload).success).toBe(true);
  });

  it("poses equivalentes reaproveitam a cobertura pelo digest", () => {
    const hits = equivalentCells(
      [
        { clipRevisionId: "th-e", frameId: "recover", partId: "torso", digest: "d1" },
        { clipRevisionId: "th-e", frameId: "guard", partId: "torso", digest: "d9" },
      ],
      [{ clipRevisionId: "th-s", frameId: "recover", partId: "torso", digest: "d1" }],
    );
    expect([...hits.entries()]).toEqual([["th-e#recover#torso", { clipRevisionId: "th-s", frameId: "recover" }]]);
  });
});

describe("gabarito", () => {
  it("tiras em grade por clipe e posição padrão da parte na pilha", () => {
    expect(stripLayout(4)).toEqual({ columns: 2, rows: 2 });
    expect(stripLayout(6)).toEqual({ columns: 3, rows: 2 });
    expect(planStrips([{ clipRevisionId: "th-s", clipKey: "th-s", frameIds: TH.ids }], 4).map((s) => [s.frameIds.length, s.columns, s.rows])).toEqual([
      [4, 2, 2],
      [2, 2, 1],
    ]);
    const f = clips[0]!.payload.frames[0]!;
    expect(defaultDrawIndex("sleeve_near", f)).toBe(1);
    expect(defaultDrawIndex("torso", f)).toBe(0);
    expect(defaultDrawIndex("cape", f)).toBe(2);
    // Só proporções aceitas pelas rotas de imagem (1:1, 3:2, 2:3); grade centrada.
    expect(stripCanvas([68, 72], 3, 2, 6)).toMatchObject({ canvas: [216, 144] });
    expect(stripCanvas([64, 64], 2, 2, 3)).toEqual({ canvas: [128, 128], at: [[0, 0], [64, 0], [0, 64]] });
    expect(stripCanvas([64, 64], 1, 1, 1).canvas).toEqual([64, 64]);
  });

  it("contratos novos são opcionais: a peça e o conjunto da fixture continuam válidos", () => {
    expect(parseRevisionPayload("equipment", "overlay", { itemRevisionId: null, rigRevisionId: "r", slots: ["torso"], stances: ["a"], parts: [{ partId: "torso", coverage: [] }], rigidViews: [] }).success).toBe(true);
    expect(
      parseRevisionPayload("equipment", "overlay", {
        ...shortSword.payload,
        rigidPlacements: [{ clipRevisionId: "c", frameId: "f", viewId: "v", anchorSocketId: "hand_right", drawIndex: 0, mirrored: true }],
      }).success,
    ).toBe(false);
  });
});
