import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClipPayload, LoadoutPayload, OverlayPayload } from "@/contracts";
import { buildFrameStack } from "@/domain/equipment/order";
import { readZip } from "@/lib/zip";
import { createAsset, getAsset, getRevision, publishRevision, reviewRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { buildPortablePackage } from "../export/package";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { saveProfile } from "../providers/profiles";
import type { ProviderAdapter } from "../providers/types";
import { makeTestStudio, type TestStudio } from "../testing";
import { createProject } from "../catalog/catalog";
import { baseLayers, packRow, POSES } from "./demo-art";
import { DEMO_NAMES, type DemoSummary, seedEquipmentDemo } from "./demo";
import { extractCoverage } from "./extract";
import { loadRig } from "./load";
import { equipInConfig, publishLoadout, swapItem } from "./loadouts";
import { editOverlay, expandCell, rebindCoverage } from "./overlays";
import { buildOverlayCoveragePlan } from "./plans";
import { decodePng, encodePngDeflate } from "./png";
import { composeCombo, resolveConfig, resolveLoadoutRevision } from "./resolve";
import { applyReuse, composePreview, runCoverage } from "./service";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

// Semeia o guerreiro (Python) em cada teste: mais lento que o padrão de 5 s sob carga.
vi.setConfig({ testTimeout: 60_000 });

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Guerreiro" });
  const demo = await seedEquipmentDemo(studio, project.id);
  return { projectId: project.id, demo };
}

function approve(projectId: string, revisionId: string) {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: "teste", expectedActiveRevisionId: asset.approvedRevisionId });
}

/** "Provedor desligado": qualquer acesso a adaptador conta e falha. */
function providerOff() {
  const calls: string[] = [];
  const spy: ProviderAdapter = {
    transport: "simulated",
    idempotentSubmit: false,
    pollIntervalMs: 10,
    capabilities: () => {
      calls.push("capabilities");
      return [];
    },
    estimate: () => {
      calls.push("estimate");
      return { kind: "unknown", reason: "desligado" };
    },
    submit: async () => {
      calls.push("submit");
      throw new Error("provedor desligado");
    },
    poll: async () => {
      calls.push("poll");
      throw new Error("provedor desligado");
    },
    fetchResult: async () => {
      calls.push("fetchResult");
      throw new Error("provedor desligado");
    },
  };
  studio.providers.adapterFor = () => {
    calls.push("adapterFor");
    throw new Error("provedor desligado");
  };
  return { calls, spy };
}

async function drain(adapter?: ProviderAdapter) {
  while (await studio.runner("worker-test", adapter).runOnce()) {
    /* processa a fila */
  }
}

function frameDurations(ctx: ReturnType<typeof resolveLoadoutRevision>) {
  return ctx.resolution.combos.map((c) => c.frames.map((f) => f.durationMs));
}

describe("aceite S2: mesma cota nos dois conjuntos e troca sem provedor", () => {
  it("ataques distintos (4 e 6 frames), mesma revisão da cota, 4 × (4 + 6) = 40 poses por parte", async () => {
    const { projectId, demo } = await setup();
    const a = resolveLoadoutRevision(studio, projectId, demo.loadouts.a);
    const b = resolveLoadoutRevision(studio, projectId, demo.loadouts.b);
    expect(a.loadout?.status).toBe("approved");
    expect(b.loadout?.status).toBe("approved");
    expect(a.resolution.ready && b.resolution.ready).toBe(true);
    expect(a.resolution.stance).toMatchObject({ stance: "one_hand_shield" });
    expect(b.resolution.stance).toMatchObject({ stance: "two_handed" });
    expect(a.loadout!.payload.overlayRevisionIds[0]).toBe(demo.overlays.mail);
    expect(b.loadout!.payload.overlayRevisionIds[0]).toBe(demo.overlays.mail);
    expect(frameDurations(a)).toEqual(Array(4).fill([140, 80, 60, 160]));
    expect(frameDurations(b)).toEqual(Array(4).fill([120, 100, 90, 60, 110, 180]));
    // A cota está desenhada em todos os frames dos dois ataques (torso sempre; manga coberta ou vazia explícita).
    for (const ctx of [a, b]) {
      for (const combo of ctx.resolution.combos) {
        for (const f of combo.frames) {
          expect(f.layers.some((l) => l.key === `part:${demo.overlays.mail}:torso`)).toBe(true);
          expect(f.gaps).toEqual([]);
        }
      }
    }
    const torso = (ctx: typeof a) => ctx.resolution.matrix.counts[ctx.resolution.matrix.rows.findIndex((r) => r.overlayRevisionId === demo.overlays.mail && r.partId === "torso")]!;
    expect(torso(a).total + torso(b).total).toBe(4 * (4 + 6));
    expect(torso(a).covered + torso(b).covered).toBe(40);
    // A espada longa cabe no quadro: a célula da família do golpe amplo foi ampliada, e as duas mãos seguem seus encaixes.
    const th = b.resolution.combos[0]!.clip!.payload;
    expect(th.logicalSize[0]).toBeGreaterThan(64);
    expect(b.resolution.combos.flatMap((c) => c.frames.flatMap((f) => f.issues))).toEqual([]);
    for (const f of b.resolution.combos.flatMap((c) => c.frames)) {
      const long = f.layers.find((l) => l.key === `rigid:${demo.overlays.longSword}`)!;
      expect(long.grips.map((g) => g.deviation)).toEqual([0, 0]);
    }
  });

  it("alternar conjuntos, compor, trocar item e exportar com o provedor desligado: zero chamadas", async () => {
    const { projectId, demo } = await setup();
    const { calls, spy } = providerOff();
    for (const id of [demo.loadouts.a, demo.loadouts.b, demo.loadouts.a]) {
      const ctx = resolveLoadoutRevision(studio, projectId, id);
      for (const combo of ctx.resolution.combos) {
        const preview = await composePreview(studio, projectId, { request: { loadoutRevisionId: id }, action: combo.action, direction: combo.direction });
        expect(preview.providerCalls).toBe(0);
        expect(preview.status).toBe("ready");
      }
    }
    // O editor lista o escudo e a espada curta a retirar e aplica a troca como uma operação.
    const swapped = await swapItem(studio, projectId, { loadoutRevisionId: demo.loadouts.a, incomingOverlayRevisionId: demo.overlays.longSword });
    expect(swapped.replacement.removed.sort()).toEqual([demo.overlays.shield, demo.overlays.shortSword].sort());
    expect((swapped.revision.payload as LoadoutPayload).stance).toBe("two_handed");
    expect((swapped.revision.payload as LoadoutPayload).clips).toHaveLength(4);
    const { export: exp } = requestExport(studio, projectId, { revisionIds: [demo.loadouts.a, demo.loadouts.b], profile: "portable-v1" });
    await drain(spy);
    expect(getExport(studio.db, projectId, exp.id).state).toBe("ready");
    expect(calls).toEqual([]);
    expect(studio.simulatedStore.read().submissions).toBe(0);
  });
});

describe("conflitos e peça de outra base", () => {
  it("escudo com espada longa: slot em conflito e substituição em uma operação", async () => {
    const { projectId, demo } = await setup();
    const conflict = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.mail, demo.overlays.longSword, demo.overlays.shield] });
    const pend = conflict.resolution.pendencies.find((p) => p.kind === "slot_conflict")!;
    expect(pend).toMatchObject({ where: { slotId: "off_hand" }, action: { kind: "replace_item" } });
    expect(pend.action.label).toBe(`Substituir ${DEMO_NAMES.longSword} por ${DEMO_NAMES.shield}`);
    expect(conflict.resolution.ready).toBe(false);
    const fixed = equipInConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.mail, demo.overlays.longSword] }, demo.overlays.shield);
    expect(fixed.replacement.removed).toEqual([demo.overlays.longSword]);
    const after = resolveConfig(studio, projectId, { ...fixed.config, overlayRevisionIds: [...fixed.config.overlayRevisionIds, demo.overlays.shortSword] });
    expect(after.resolution.stance).toMatchObject({ status: "resolved", stance: "one_hand_shield" });
    expect(after.resolution.ready).toBe(true);
  });

  it("a peça liga-se a um item de inventário (ícone e arte equipada do mesmo item)", async () => {
    const { projectId, demo } = await setup();
    const potion = studio.db.get<{ id: string }>("SELECT approved_revision_id AS id FROM assets WHERE project_id = :p AND family = 'item'", { p: projectId })!.id;
    const linked = editOverlay(studio, projectId, { op: "set_item", overlayRevisionId: demo.overlays.shortSword, itemRevisionId: potion });
    expect((linked.revision.payload as OverlayPayload).itemRevisionId).toBe(potion);
    expect(() => editOverlay(studio, projectId, { op: "set_item", overlayRevisionId: demo.overlays.shortSword, itemRevisionId: demo.rigRevisionId })).toThrow(/item de inventário/);
  });

  it("peça feita para outra base aponta a revisão incompatível e oferece criar cobertura", async () => {
    const { projectId, demo } = await setup();
    expect(demo.overlays.foreignMail).toBeTruthy();
    const r = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.foreignMail!, demo.overlays.longSword] });
    expect(r.resolution.pendencies[0]).toMatchObject({ kind: "incompatible_rig", blocking: true, action: { kind: "create_coverage", label: "Criar cobertura para esta base" } });
    expect(r.resolution.matrix.cells[0]!.every((c) => c === "incompatible")).toBe(true);
    await expect(publishLoadout(studio, projectId, { config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.foreignMail!] } })).rejects.toThrow(/outra base/);
  });
});

async function gapInSleeve(projectId: string, demo: DemoSummary) {
  const th = resolveLoadoutRevision(studio, projectId, demo.loadouts.b).resolution.combos.find((c) => c.direction === "E")!.clip!;
  const edited = editOverlay(studio, projectId, { op: "remove_cell", overlayRevisionId: demo.overlays.mail, clipRevisionId: th.revisionId, frameId: "follow", partId: "sleeve_near" });
  approve(projectId, edited.revision.id);
  return edited.revision.id;
}

describe("lacuna de uma manga: bloqueia só a composição afetada", () => {
  it("o verificador aponta peça, direção, ação, postura e frame; o outro conjunto e um subconjunto explícito exportam", async () => {
    const { projectId, demo } = await setup();
    const mail = await gapInSleeve(projectId, demo);
    const b = await publishLoadout(studio, projectId, { assetId: getRevision(studio.db, projectId, demo.loadouts.b).assetId, config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [mail, demo.overlays.longSword] } });
    approve(projectId, b.revision.id);
    const resolved = resolveLoadoutRevision(studio, projectId, b.revision.id);
    expect(resolved.resolution.combos.map((c) => [c.direction, c.status])).toEqual([
      ["N", "ready"],
      ["E", "blocked"],
      ["S", "ready"],
      ["W", "ready"],
    ]);
    // Sem folha achatada para a combinação bloqueada.
    expect((b.revision.payload as LoadoutPayload).sheets!.map((s) => s.clipRevisionId)).not.toContain(resolved.resolution.combos[1]!.clip!.revisionId);
    let error: unknown;
    try {
      requestExport(studio, projectId, { revisionIds: [b.revision.id], profile: "portable-v1" });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(DomainFailure);
    expect((error as DomainFailure).code).toBe("coverage_incomplete");
    const problems = (error as DomainFailure).details!.problems as { where: Record<string, string>; pointer: string }[];
    expect(problems).toHaveLength(1);
    expect(problems[0]!.where).toMatchObject({ overlayName: DEMO_NAMES.mail, partId: "sleeve_near", direction: "E", action: "attack", stance: "two_handed", frameId: "follow" });
    expect((error as DomainFailure).message).toContain("frame follow");

    // O conjunto A, com a MESMA revisão da cota (só o golpe amplo perdeu a manga), continua completo.
    const a = await publishLoadout(studio, projectId, { config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [mail, demo.overlays.shortSword, demo.overlays.shield] } });
    approve(projectId, a.revision.id);
    expect(() => requestExport(studio, projectId, { revisionIds: [a.revision.id], profile: "portable-v1" })).not.toThrow();

    // Subconjunto explicitamente completo: N, S e W; E declarada como omitida.
    await expect(
      publishLoadout(studio, projectId, { config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [mail, demo.overlays.longSword] }, subset: { combos: [{ action: "attack", direction: "E" }], reason: "x" } }),
    ).rejects.toThrow(/não está completo/);
    const subset = await publishLoadout(studio, projectId, {
      name: "Conjunto B (sem leste)",
      config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [mail, demo.overlays.longSword] },
      subset: { combos: ["N", "S", "W"].map((d) => ({ action: "attack", direction: d as "N" | "S" | "W" })), reason: "Manga do frame follow (leste) em revisão" },
    });
    approve(projectId, subset.revision.id);
    expect((subset.revision.payload as LoadoutPayload).omitted).toEqual([{ action: "attack", direction: "E", reason: "Manga do frame follow (leste) em revisão" }]);
    const { export: exp } = requestExport(studio, projectId, { revisionIds: [subset.revision.id], profile: "portable-v1" });
    await drain();
    expect(getExport(studio.db, projectId, exp.id).state).toBe("ready");
  });
});

describe("guias: encaixes, segunda mão e contorno cortado", () => {
  it("segunda mão acima de 1 px sinaliza; 1 px é tolerado", async () => {
    const { projectId, demo } = await setup();
    const long = getRevision(studio.db, projectId, demo.overlays.longSword).payload as OverlayPayload;
    const up = long.rigidViews.find((v) => v.viewId === "up")!;
    const shifted = (dx: number) =>
      editOverlay(studio, projectId, { op: "set_grips", overlayRevisionId: demo.overlays.longSword, viewId: "up", grips: up.grips.map((g) => (g.socketId === "hand_left" ? { ...g, at: [g.at[0] + dx, g.at[1]] as [number, number] } : g)) });
    const one = shifted(1).revision.id;
    const two = shifted(2).revision.id;
    const issues = (overlay: string) =>
      resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.mail, overlay] }).resolution.combos.flatMap((c) => c.pendencies.filter((p) => p.kind === "socket_deviation"));
    expect(issues(one)).toEqual([]);
    const flagged = issues(two);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged[0]).toMatchObject({ blocking: false, action: { kind: "fix_grips" } });
    expect(flagged[0]!.message).toMatch(/hand_left.*a 2 px.*tolerância do rig 1 px/);
  });

  it("contorno cortado mostra os limites; ampliar a célula desloca camadas, sockets, pivô e coberturas pela mesma margem", async () => {
    const { projectId, demo } = await setup();
    // Revisão original de 64 × 64 do golpe amplo (antes da ampliação feita na demonstração).
    const thS = demo.clips["th-s"]!;
    const original = getRevision(studio.db, projectId, thS).predecessorId!;
    const oldClip = getRevision(studio.db, projectId, original).payload as ClipPayload;
    expect(oldClip.logicalSize).toEqual([64, 64]);
    const longOld = getRevision(studio.db, projectId, demo.overlays.longSword).predecessorId!;
    const rig = loadRig(studio.db, projectId, demo.rigRevisionId).ref.payload;
    const overlays = [{ revisionId: longOld, name: "Espada longa", payload: getRevision(studio.db, projectId, longOld).payload as OverlayPayload }];
    const windup = oldClip.frames.findIndex((f) => f.frameId === "windup");
    const stack = buildFrameStack({ rig, clipRevisionId: original, clip: oldClip, frameIndex: windup, overlays });
    const clipped = stack.issues.find((i) => i.kind === "clipped_outline")!;
    expect(clipped.overflow!.top).toBeGreaterThan(0);

    const margins = { left: 0, right: 0, top: clipped.overflow!.top, bottom: 0 };
    const expanded = expandCell(studio, projectId, { clips: [{ clipRevisionId: original, margins }], overlayRevisionIds: [longOld, getRevision(studio.db, projectId, demo.overlays.mail).predecessorId!] });
    const newClip = expanded.clips[0]!.revision.payload as ClipPayload;
    expect(newClip.logicalSize).toEqual([64, 64 + margins.top]);
    expect(newClip.pivot).toEqual([oldClip.pivot[0], oldClip.pivot[1] + margins.top]);
    expect(newClip.frames[windup]!.sockets[0]!.at).toEqual([oldClip.frames[windup]!.sockets[0]!.at[0], oldClip.frames[windup]!.sockets[0]!.at[1] + margins.top]);
    const longNew = expanded.overlays.find((o) => o.overlayRevisionId === longOld)!.revision;
    const after = buildFrameStack({ rig, clipRevisionId: expanded.clips[0]!.revision.id, clip: newClip, frameIndex: windup, overlays: [{ revisionId: longNew.id, name: "Espada longa", payload: longNew.payload as OverlayPayload }] });
    expect(after.issues).toEqual([]);
    const posBefore = stack.layers.find((l) => l.ref.kind === "rigid")!.offset;
    const posAfter = after.layers.find((l) => l.ref.kind === "rigid")!.offset;
    // Posição em cena (relativa ao pivô) preservada.
    expect([posAfter[0] - newClip.pivot[0], posAfter[1] - newClip.pivot[1]]).toEqual([posBefore[0] - oldClip.pivot[0], posBefore[1] - oldClip.pivot[1]]);
    const mailNew = expanded.overlays.find((o) => o.overlayRevisionId !== longOld)!.revision.payload as OverlayPayload;
    const cellOld = mailNew.parts[0]!.coverage.find((c) => c.clipRevisionId === original && c.frameId === "windup")!;
    const cellNew = mailNew.parts[0]!.coverage.find((c) => c.clipRevisionId === expanded.clips[0]!.revision.id && c.frameId === "windup")!;
    expect(cellNew.layer!.fileId).toBe(cellOld.layer!.fileId);
    expect(cellNew.layer!.offset).toEqual([cellOld.layer!.offset[0], cellOld.layer!.offset[1] + margins.top]);
  });
});

describe("nova pose de contato: matriz, revinculação por digest e pacote anterior intacto", () => {
  it("só o frame alterado pede revisão; retimar revincula tudo; o pacote antigo conserva hashes", async () => {
    const { projectId, demo } = await setup();
    const before = await buildPortablePackage(studio.db, studio.blobs, projectId, [demo.loadouts.a]);

    // Nova revisão do ataque com escudo (S): só o corpo do frame `contact` muda.
    const oldId = demo.clips["osh-s"]!;
    const old = getRevision(studio.db, projectId, oldId);
    const clip = old.payload as ClipPayload;
    const poses = POSES.osh.S.map((p) => (p.frameId === "contact" ? { ...p, crouch: p.crouch + 2 } : p));
    const strip = packRow(poses.map((p) => baseLayers("S", p).body));
    const bodyKey = clip.frames[0]!.layers[0]!.fileId;
    const stored = await studio.blobs.putBytes(encodePngDeflate(strip.atlas));
    const files = old.files
      .filter((f) => f.fileKey !== bodyKey)
      .map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: { sha256: f.sha256, bytes: f.bytes, mime: f.mime, modality: "raster" as const, metadata: f.metadata } }));
    files.push({ fileKey: bodyKey, role: "frame_layer", idx: 0, blob: { sha256: stored.sha256, bytes: stored.bytes, mime: "image/png", modality: "raster", metadata: { width: strip.atlas.width, height: strip.atlas.height } } });
    const v2 = publishRevision(studio.db, studio.clock, { projectId, assetId: old.assetId, payload: clip, origin: "edit", styleRevisionId: null, predecessorId: oldId, files });
    approve(projectId, v2.id);

    const live = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.mail, demo.overlays.shortSword, demo.overlays.shield] });
    const s = live.resolution.combos.find((c) => c.direction === "S")!;
    expect(s.clip!.revisionId).toBe(v2.id);
    expect(new Set(s.pendencies.map((p) => p.kind))).toEqual(new Set(["stale_coverage"]));
    expect(s.pendencies.find((p) => p.where.overlayRevisionId === demo.overlays.mail)!.action.kind).toBe("rebind");

    const rebound = await rebindCoverage(studio, projectId, { overlayRevisionId: demo.overlays.mail, fromClipRevisionId: oldId, toClipRevisionId: v2.id });
    expect(rebound.review.map((r) => `${r.partId}/${r.frameId}/${r.reason}`).sort()).toEqual(["sleeve_near/contact/geometry_changed", "torso/contact/geometry_changed"]);
    expect(rebound.rebound).toHaveLength(6);
    expect(rebound.digests.from.windup).toBe(rebound.digests.to.windup);
    expect(rebound.digests.from.contact).not.toBe(rebound.digests.to.contact);
    approve(projectId, rebound.revision!.id);
    const after = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [rebound.revision!.id, demo.overlays.shortSword, demo.overlays.shield] });
    const mailGaps = after.resolution.combos.find((c) => c.direction === "S")!.pendencies.filter((p) => p.where.overlayRevisionId === rebound.revision!.id);
    expect(mailGaps.map((p) => `${p.where.partId}/${p.where.frameId}`).sort()).toEqual(["sleeve_near/contact", "torso/contact"]);

    // O pacote anterior continua resolvendo as revisões originais: mesmo manifesto, mesmos bytes.
    const again = await buildPortablePackage(studio.db, studio.blobs, projectId, [demo.loadouts.a]);
    expect(JSON.stringify(again.manifest)).toBe(JSON.stringify(before.manifest));
    expect(again.files.map((f) => f.bytes)).toEqual(before.files.map((f) => f.bytes));
  });
});

describe("extração de cobertura de um clipe vestido (ponte com transferir roupa)", () => {
  it("a peça é a diferença na zona; base + peça recompõe o clipe vestido", async () => {
    const { projectId, demo } = await setup();
    const target = demo.clips["osh-s"]!;
    // Clipe vestido sintético: base + cota achatados, mesmos frames e célula (como a transferência devolveria).
    const ctx = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [demo.overlays.mail], stance: "one_hand_shield", combos: [{ action: "attack", direction: "S" }] });
    const combo = ctx.resolution.combos[0]!;
    const torsoOnly = { ...combo, frames: combo.frames.map((f) => ({ ...f, layers: f.layers.filter((l) => l.ref.kind === "base" || l.partId === "torso") })) };
    const dressedRun = await composeCombo({ config: studio.config, blobs: studio.blobs, db: studio.db }, torsoOnly, 1);
    const sheet = dressedRun.outputs.find((o) => o.role === "sheet")!;
    const sheetBlob = await studio.blobs.putBytes(sheet.bytes);
    const clip = getRevision(studio.db, projectId, target).payload as ClipPayload;
    const dressedAsset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "clip", name: "Guerreiro vestido (transferir roupa)" });
    const dressed = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: dressedAsset.id,
      payload: { ...clip, state: "outfit_cota", frames: clip.frames.map((f, i) => ({ ...f, layers: [{ partId: "body", fileId: "dressed", rect: [i * 64, 0, 64, 64], offset: [0, 0] }] })) },
      origin: "generation",
      styleRevisionId: null,
      files: [{ fileKey: "dressed", role: "frame", idx: 0, blob: { sha256: sheetBlob.sha256, bytes: sheetBlob.bytes, mime: "image/png", modality: "raster", metadata: { width: sheet.width, height: sheet.height } } }],
    });
    const { calls } = providerOff();
    const extracted = await extractCoverage(studio, projectId, {
      targetClipRevisionId: target,
      source: { kind: "clip", clipRevisionId: dressed.id },
      item: { name: "Cota extraída", slots: ["torso"], stances: ["one_hand_shield", "two_handed"] },
      parts: ["torso"],
    });
    expect(calls).toEqual([]);
    expect((extracted.revision.technicalReport as { source: string }).source).toMatch(/transferir roupa/);
    const payload = extracted.revision.payload as OverlayPayload;
    expect(payload.parts[0]!.coverage).toHaveLength(4);
    // Recomposição: base + peça extraída = clipe vestido, pixel a pixel.
    const check = resolveConfig(studio, projectId, { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: [extracted.revision.id], stance: "one_hand_shield", combos: [{ action: "attack", direction: "S" }] });
    const recomposed = await composeCombo({ config: studio.config, blobs: studio.blobs, db: studio.db }, check.resolution.combos[0]!, 1);
    expect(decodePng(recomposed.outputs.find((o) => o.role === "sheet")!.bytes).data).toEqual(decodePng(sheet.bytes).data);
  });
});

describe("geração: plano com matriz e tiras, só lacunas, pose de prova, poses equivalentes", () => {
  it("simulado: candidato vestido extraído localmente vira revisão candidata da peça", async () => {
    const { projectId, demo } = await setup();
    const clip = demo.clips["osh-s"]!;
    const base = { operation: "generate_overlay_coverage" as const, providerProfileId: "simulated", rigRevisionId: demo.rigRevisionId, description: "gibão de couro com rebites", mode: "coverage" as const, parts: ["torso"], clips: [{ clipRevisionId: clip }] };
    const plan = await buildOverlayCoveragePlan(studio, projectId, { ...base, item: { slots: ["torso"], stances: ["one_hand_shield"] } });
    expect(plan.summary).toMatchObject({ requested: 4, toGenerate: 4, reused: 0, strips: [{ frameIds: ["windup", "advance", "contact", "recover"], grid: "2×2", canvas: [128, 128] }] });
    expect(plan.summary.routeLabel).toMatch(/não é máscara nativa/);
    expect(plan.plan.parts).toHaveLength(1);
    expect(plan.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    const proof = await buildOverlayCoveragePlan(studio, projectId, { ...base, item: { slots: ["torso"], stances: ["one_hand_shield"] }, proofPose: { clipRevisionId: clip, frameId: "contact" } });
    expect(proof.summary).toMatchObject({ toGenerate: 1, strips: [{ frameIds: ["contact"], grid: "1×1" }] });
    expect(proof.summary.cells.filter((c) => c.fate === "later")).toHaveLength(3);

    const run = await runCoverage(studio, projectId, { plan: { ...base, item: { slots: ["torso"], stances: ["one_hand_shield"] } }, newItemName: "Gibão simulado" });
    await drain();
    const job = studio.queue.get(run.job.id)!;
    expect(job.state).toBe("succeeded");
    const revisionId = (JSON.parse(job.result_json!) as { revisionIds: string[] }).revisionIds[0]!;
    const rev = getRevision(studio.db, projectId, revisionId);
    expect(rev.status).toBe("candidate");
    const payload = rev.payload as OverlayPayload;
    expect(payload.parts[0]!.coverage.map((c) => c.frameId).sort()).toEqual(["advance", "contact", "recover", "windup"]);
    expect((rev.technicalReport as { routeLabel: string }).routeLabel).toMatch(/extraída localmente/);
    expect(rev.files.some((f) => f.role === "candidate")).toBe(true);
    approve(projectId, revisionId);

    // Tudo coberto: nada a gerar.
    await expect(buildOverlayCoveragePlan(studio, projectId, { ...base, overlayRevisionId: revisionId })).rejects.toMatchObject({ details: { nothingToGenerate: true } });

    // Clipe variante com a MESMA geometria: reaproveita por digest, sem gerar.
    const source = getRevision(studio.db, projectId, clip);
    const twin = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "clip", name: "Ataque com escudo (S) — variante" });
    const twinRev = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: twin.id,
      payload: source.payload,
      origin: "edit",
      styleRevisionId: null,
      files: source.files.map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: { sha256: f.sha256, bytes: f.bytes, mime: f.mime, modality: "raster" as const, metadata: f.metadata } })),
    });
    approve(projectId, twinRev.id);
    let reuseError: DomainFailure | null = null;
    try {
      await buildOverlayCoveragePlan(studio, projectId, { ...base, overlayRevisionId: revisionId, clips: [{ clipRevisionId: twinRev.id }] });
    } catch (err) {
      reuseError = err as DomainFailure;
    }
    const reused = reuseError!.details!.reused as { frameId: string; reason: string }[];
    expect(reused.map((r) => r.reason)).toEqual(Array(4).fill("equivalent_pose"));
    const applied = applyReuse(studio, projectId, { overlayRevisionId: revisionId, reused: reused as never });
    expect(applied.applied).toBe(4);
    expect(studio.simulatedStore.read().submissions).toBe(1);
  });

  it("gera só a lacuna: o frame entra na tira por uma parte, as outras células ficam como estavam", async () => {
    const { projectId, demo } = await setup();
    const clip = demo.clips["osh-s"]!;
    const gap = editOverlay(studio, projectId, { op: "remove_cell", overlayRevisionId: demo.overlays.mail, clipRevisionId: clip, frameId: "windup", partId: "sleeve_near" });
    approve(projectId, gap.revision.id);
    const run = await runCoverage(studio, projectId, {
      plan: { operation: "generate_overlay_coverage", providerProfileId: "simulated", rigRevisionId: demo.rigRevisionId, overlayRevisionId: gap.revision.id, description: "cota", mode: "coverage", parts: ["torso", "sleeve_near"], clips: [{ clipRevisionId: clip }] },
    });
    expect(run.summary).toMatchObject({ toGenerate: 1, existing: 7, empty: 0, strips: [{ frameIds: ["windup"], grid: "1×1" }] });
    await drain();
    const job = studio.queue.get(run.job.id)!;
    expect(job.error_json).toBe(null);
    const before = gap.revision.payload as OverlayPayload;
    const after = getRevision(studio.db, projectId, (JSON.parse(job.result_json!) as { revisionIds: string[] }).revisionIds[0]!).payload as OverlayPayload;
    const torso = (p: OverlayPayload) => p.parts.find((x) => x.partId === "torso")!.coverage.find((c) => c.clipRevisionId === clip && c.frameId === "windup");
    expect(torso(after)).toEqual(torso(before));
    expect(after.parts.find((x) => x.partId === "sleeve_near")!.coverage.find((c) => c.clipRevisionId === clip && c.frameId === "windup")!.layer).not.toBeNull();

    // Segunda rodada sobre a revisão gerada (arquivos herdados com índices não contíguos): publica sem colidir.
    const generated = (JSON.parse(job.result_json!) as { revisionIds: string[] }).revisionIds[0]!;
    approve(projectId, generated);
    const gap2 = editOverlay(studio, projectId, { op: "remove_cell", overlayRevisionId: generated, clipRevisionId: clip, frameId: "contact", partId: "torso" });
    approve(projectId, gap2.revision.id);
    const run2 = await runCoverage(studio, projectId, {
      plan: { operation: "generate_overlay_coverage", providerProfileId: "simulated", rigRevisionId: demo.rigRevisionId, overlayRevisionId: gap2.revision.id, description: "cota", mode: "coverage", parts: ["torso", "sleeve_near"], clips: [{ clipRevisionId: clip }] },
    });
    await drain();
    expect(studio.queue.get(run2.job.id)!.state).toBe("succeeded");
  }, 30_000);

  it("vista rígida com empunhaduras do gabarito; rota sem capacidade é bloqueada antes de cobrar", async () => {
    const { projectId, demo } = await setup();
    const run = await runCoverage(studio, projectId, {
      plan: {
        operation: "generate_overlay_coverage",
        providerProfileId: "simulated",
        rigRevisionId: demo.rigRevisionId,
        description: "machado de lenhador",
        mode: "rigid_view",
        item: { slots: ["main_hand"], stances: ["one_hand_shield"] },
        view: { viewId: "up", size: [9, 24], grips: [{ socketId: "hand_right", at: [4, 19] }], orientation: "vertical_up" },
      },
      newItemName: "Machado",
    });
    expect(run.summary.routeLabel).toMatch(/Vista rígida por texto/);
    await drain();
    const rev = getRevision(studio.db, projectId, (JSON.parse(studio.queue.get(run.job.id)!.result_json!) as { revisionIds: string[] }).revisionIds[0]!);
    expect((rev.payload as OverlayPayload).rigidViews).toEqual([{ viewId: "up", fileId: "view-up", rect: [0, 0, 9, 24], grips: [{ socketId: "hand_right", at: [4, 19] }] }]);

    // Perfil sem as capacidades de equipamento (API OpenAI Images: só ícone e inpainting).
    saveProfile(studio.db, studio.clock, { id: "pl", name: "API local", transport: "openai_images", baseUrl: "http://127.0.0.1:9/v1", secretRef: "TEST_PROVIDER_KEY", model: "m", config: {} });
    process.env.TEST_PROVIDER_KEY = "x";
    await expect(
      buildOverlayCoveragePlan(studio, projectId, { operation: "generate_overlay_coverage", providerProfileId: "pl", rigRevisionId: demo.rigRevisionId, description: "x", mode: "coverage", parts: ["torso"], clips: [{ clipRevisionId: demo.clips["osh-s"]! }], item: { slots: ["torso"], stances: ["one_hand_shield"] } }),
    ).rejects.toMatchObject({ code: "capability_missing" });
  });
});

// ---------------------------------------------------------------------------
// OpenRouter (servidor falso): referências, proporção e fundo opaco
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl = "";
const bodies: Record<string, unknown>[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
    bodies.push(body);
    // "Modelo" que devolve a guia: a zona pintada vira a peça extraída localmente.
    const ref = ((body.input_references as { image_url: { url: string } }[]) ?? [])[1]?.image_url.url.split(",")[1] ?? "";
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: ref }], usage: { cost: 0.012 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("rota genérica OpenRouter", () => {
  it("envia frames da base + guia da zona, proporção da tela da tira e fundo opaco; custo real do usage", async () => {
    const { projectId, demo } = await setup();
    process.env.TEST_PROVIDER_KEY = "chave";
    saveProfile(studio.db, studio.clock, { id: "or", name: "OpenRouter", transport: "openrouter_images", baseUrl: `${baseUrl}/api/v1`, secretRef: "TEST_PROVIDER_KEY", model: "openai/gpt-image-1-mini", config: { maxReferences: 4, transparent: true, pricePerImageUsd: 0.02 } });
    const run = await runCoverage(studio, projectId, {
      plan: { operation: "generate_overlay_coverage", providerProfileId: "or", rigRevisionId: demo.rigRevisionId, overlayRevisionId: null, item: { slots: ["torso"], stances: ["two_handed"] }, description: "cota", mode: "coverage", parts: ["torso"], clips: [{ clipRevisionId: demo.clips["th-s"]! }], framesPerStrip: 6 },
      newItemName: "Cota OR",
    });
    expect(run.summary.strips[0]).toMatchObject({ grid: "3×2" });
    await drain();
    const body = bodies.at(-1)!;
    expect((body.input_references as unknown[]).length).toBe(2);
    expect(body.background).toBe("opaque");
    const [w, h] = run.summary.strips[0]!.canvas;
    const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
    expect(body.aspect_ratio).toBe(`${w / g(w, h)}:${h / g(w, h)}`);
    expect(String(body.prompt)).not.toMatch(/#[0-9a-f]{6}/i);
    const job = studio.queue.get(run.job.id)!;
    expect(job.error_json).toBe(null);
    expect(JSON.parse(job.result_json!).cost).toEqual([{ unit: "USD", amount: 0.012 }]);
  });
});

describe("exportação X1 e leitor independente", () => {
  it("a folha achatada exportada é recomposta pixel a pixel pelas camadas e pela ordem", async () => {
    const { projectId, demo } = await setup();
    // Override de ordem num frame: a espada curta passa à frente do braço no contato (S).
    const ctx = resolveLoadoutRevision(studio, projectId, demo.loadouts.a);
    const s = ctx.resolution.combos.find((c) => c.direction === "S")!;
    const contact = s.frames.find((f) => f.frameId === "contact")!;
    const order = [...contact.layers.map((l) => l.ref)];
    const sword = order.findIndex((r) => r.kind === "rigid" && r.overlayRevisionId === demo.overlays.shortSword);
    order.push(order.splice(sword, 1)[0]!);
    const a2 = await publishLoadout(studio, projectId, {
      name: "Conjunto A (espada à frente no contato)",
      config: { rigRevisionId: demo.rigRevisionId, overlayRevisionIds: ctx.loadout!.payload.overlayRevisionIds, drawOrder: [{ clipRevisionId: s.clip!.revisionId, frameId: "contact", layers: order }] },
    });
    approve(projectId, a2.revision.id);
    const { export: exp } = requestExport(studio, projectId, { revisionIds: [a2.revision.id, demo.loadouts.b], profile: "portable-v1" });
    await drain();
    const ready = getExport(studio.db, projectId, exp.id);
    expect(ready.state).toBe("ready");
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    const loadouts = manifest.entries.filter((e: { kind: string }) => e.kind === "loadout");
    expect(loadouts).toHaveLength(2);
    expect(loadouts.find((e: { revisionId: string }) => e.revisionId === a2.revision.id).payload.drawOrder).toHaveLength(1);
    if (!existsSync(PYTHON)) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-s2-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "p.zip"), zip);
    const proc = spawnSync(PYTHON, [READER, path.join(dir, "p.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(proc.status, proc.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const read = summary.entries.filter((e: { kind: string }) => e.kind === "loadout");
    for (const l of read) {
      expect(l.sheets).toHaveLength(4);
      for (const sh of l.sheets) expect(sh).toMatchObject({ matches: true, mismatchedFrames: [] });
    }
    const readA = read.find((e: { revisionId: string }) => e.revisionId === a2.revision.id);
    const readB = read.find((e: { revisionId: string }) => e.revisionId !== a2.revision.id);
    expect(readA.stance).toBe("one_hand_shield");
    expect(readB.clips[0].frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([120, 100, 90, 60, 110, 180]);
    const contactLayers = readA.clips.find((c: { direction: string }) => c.direction === "S").frames.find((f: { frameId: string }) => f.frameId === "contact").layers;
    expect(contactLayers.at(-1)).toMatch(/^rigid:/);
    expect(readB.clips[0].frames[0].layers).toContain("torso");
  });
});
