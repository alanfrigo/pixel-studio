import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ButtonPayload, MeterPayload, ScreenPayload, SlotPayload, TemplatePayload } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { layoutScreen, moveFocus, rectOf, resolveCaption, starterScreen } from "@/domain/ui-screen";
import { groupCells } from "@/domain/ui-template";
import { createImage, encodePng, fillRect, setPixel } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getRevision, getUpload, listRevisions, publishRevision, reviewRevision, revisionDependents } from "../catalog/catalog";
import { decodePng, encodePngDeflate } from "../equipment/png";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { duplicateAsset } from "../library/library";
import { buildPlan } from "../plan-builders";
import { genericCapabilities } from "../providers/generic-route";
import { SimulatedProvider } from "../providers/simulated";
import type { ProviderAdapter, ProviderResult } from "../providers/types";
import { ingestUpload, publishFromSource, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { applyFocusOverlay, applyLocalState, publishMenuItem, splitTemplate } from "./components";
import { rebindScreen, saveScreen, uiCatalog } from "./screens";

/**
 * Cartão U3 (07 §fatias de entrega, 08 · U3): template → separação →
 * componentes → estados → menu/inventário/diálogo/HUD → tela em duas
 * proporções → pacote portátil reconstruído pelo leitor independente.
 * Provedor simulado e imagens locais; nada pago.
 */

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function approve(projectId: string, revisionId: string) {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  return reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
  return upload.id;
}

async function run(projectId: string, body: Record<string, unknown>, targetAssetId: string, key: string, adapter?: ProviderAdapter) {
  const planned = (await buildPlan(studio, projectId, body as never)) as Awaited<ReturnType<typeof buildPlan>> & { routeLabel: { en: string; "pt-BR": string } };
  const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId } }, key);
  await studio.runner("worker-test", adapter).runOnce();
  const done = studio.queue.get(job.id)!;
  return { planned, result: JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null, error: JSON.parse(done.error_json ?? "null") as { message: string } | null };
}

const KIT = [
  { localId: "continue", componentType: "menu_item", logicalSize: [64, 14] },
  { localId: "inventory", componentType: "menu_item", logicalSize: [64, 14] },
  { localId: "use", componentType: "button", logicalSize: [32, 16] },
  { localId: "health", componentType: "meter", logicalSize: [68, 10] },
  { localId: "dialogue", componentType: "panel", logicalSize: [24, 24] },
  { localId: "slot", componentType: "slot", logicalSize: [20, 20] },
];

/** Gera e aprova o template, separa todas as peças pela proposta e devolve as revisões por componente. */
async function kit(projectId: string) {
  const tplAsset = createAsset(studio.db, studio.clock, { projectId, family: "ui", kind: "template", name: "Kit de metal" });
  const brief = "metal escuro forjado, filete de cobre de 1 px, cantos chanfrados, centro uniforme livre para legenda, sem letras ou símbolos";
  const r = await run(projectId, { operation: "generate_ui_template", providerProfileId: "simulated", brief, components: KIT }, tplAsset.id, "ui:template");
  expect(r.error).toBeNull();
  const template = getRevision(studio.db, projectId, r.result!.revisionIds[0]!);
  approve(projectId, template.id);
  const payload = TemplatePayload.parse(template.payload);
  const proposals = new Map(payload.proposals.map((p) => [p.localId, p.rect]));
  const pieces = [...groupCells(payload.cells)].map(([componentId, cells]) => ({ componentId, rects: cells.map((c) => ({ localId: c.localId, rect: proposals.get(c.localId) ?? c.cell })) }));
  const split = await splitTemplate(studio, projectId, { templateRevisionId: template.id, pieces });
  const byId = Object.fromEntries(split.map((s) => [s.componentId, s]));
  return { r, template, payload, split, byId, pieces };
}

describe("rota genérica de UI (cartão U3)", () => {
  it("template e estados nunca são declarados nativos; sem referências ficam indisponíveis", () => {
    for (const op of ["generate_ui_template", "generate_ui_states"] as const) {
      expect(genericCapabilities(op, { maxReferences: 4, transparent: true })).toEqual(["text_to_image", "image_references"]);
      expect(genericCapabilities(op, { maxReferences: 0, transparent: false })).toEqual([]);
    }
    const sim = new SimulatedProvider({ read: () => ({ jobs: {}, submissions: 0, charged: 0 }), write: () => undefined }, { delayMs: 0, idempotent: false });
    expect(sim.capabilities("generate_ui_template")).not.toContain("ui_template");
    expect(sim.capabilities("generate_ui_states")).not.toContain("ui_states");
  });
});

describe.skipIf(!existsSync(PYTHON))("kit e composição de UI (cartão U3)", { timeout: 120_000 }, () => {
  it("template achatado → proposta → recorte revisado → componentes ligados ao template; redividir uma peça não toca as outras", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Guerreiro" });
    const { r, template, payload, split, byId, pieces } = await kit(project.id);
    expect(r.planned.plan.requiredCapabilities).toEqual(["text_to_image", "image_references"]);
    expect(r.planned.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    expect(r.planned.routeLabel.en).toMatch(/not a native template/);
    // A barra é pedida como trilho, preenchimento e moldura separados.
    expect(payload.cells.filter((c) => c.componentId === "health").map((c) => c.meterPart)).toEqual(["track", "fill", "frame"]);
    expect(payload.flattened).toBe(true);
    expect(payload.proposals.every((p) => p.rect !== null)).toBe(true);
    expect((template.technicalReport as { routeLabel: { en: string } }).routeLabel.en).toMatch(/flat/);
    expect(template.files.map((f) => f.fileKey).sort()).toEqual(["guide", "raw", "split-preview", "template"]);

    expect(split.map((s) => `${s.componentId}:${s.asset.kind}`)).toEqual(["continue:button", "inventory:button", "use:button", "health:meter", "dialogue:panel", "slot:slot"]);
    const use = ButtonPayload.parse(byId.use!.revision.payload);
    expect(use.states).toEqual([{ state: "normal", fileId: "normal", rect: [0, 0, 32, 16], origin: { kind: "template_split", templateRevisionId: template.id, rect: pieces.find((p) => p.componentId === "use")!.rects[0]!.rect } }]);
    expect(use.complete).toBe(false);
    expect(ButtonPayload.parse(byId.continue!.revision.payload).requiredStates).toContain("selected");
    // Barra com regiões independentes; o miolo da moldura ficou vazio para o preenchimento aparecer.
    const meter = MeterPayload.parse(byId.health!.revision.payload);
    expect([meter.track.fileId, meter.fill.fileId, meter.frame.fileId]).toEqual(["track", "fill", "frame"]);
    expect(meter.usefulRect).toEqual([2, 2, 64, 6]);
    expect((byId.health!.revision.technicalReport as { warnings: unknown[] }).warnings).toEqual([]);
    expect(SlotPayload.parse(byId.slot!.revision.payload).states.map((s) => s.state)).toEqual(["empty"]);
    expect(revisionDependents(studio.db, project.id, template.id).map((d) => d.role)).toEqual(Array(6).fill("template"));

    const counts = () => Object.fromEntries(split.map((s) => [s.componentId, listRevisions(studio.db, project.id, s.asset.id).length]));
    const before = counts();
    const useRects = pieces.find((p) => p.componentId === "use")!;
    await splitTemplate(studio, project.id, { templateRevisionId: template.id, pieces: [{ ...useRects, assetId: byId.use!.asset.id }] });
    expect(counts()).toEqual({ ...before, use: 2 });
  });

  it("estados por imagem + referência do componente aprovado, transformação local e foco local com origem registrada", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Guerreiro" });
    const { byId } = await kit(project.id);
    for (const s of Object.values(byId)) approve(project.id, s.revision.id);
    const ids = ["continue", "use", "slot"].map((k) => byId[k]!.revision.id);
    const r = await run(project.id, { operation: "generate_ui_states", providerProfileId: "simulated", componentRevisionIds: ids }, byId.continue!.asset.id, "ui:states");
    expect(r.error).toBeNull();
    expect(r.planned.plan.requiredCapabilities).toEqual(["text_to_image", "image_references"]);
    expect(r.planned.routeLabel.en).toMatch(/not native state generation/);
    expect(r.planned.plan.parts.map((p) => p.partKey)).toEqual(["component:0", "component:1", "component:2"]);
    expect(r.result!.revisionIds).toHaveLength(3);
    const [cont, use, slot] = r.result!.revisionIds.map((id) => getRevision(studio.db, project.id, id));
    const contPayload = ButtonPayload.parse(cont!.payload);
    expect(contPayload.states.map((s) => s.state)).toEqual(["normal", "hover", "pressed", "disabled", "selected"]);
    expect(contPayload.complete).toBe(true);
    expect(contPayload.states.find((s) => s.state === "hover")!.origin).toEqual({ kind: "generated_reference", referenceRevisionId: ids[0], referenceState: "normal" });
    expect(contPayload.states.find((s) => s.state === "normal")!.origin?.kind).toBe("template_split");
    const report = cont!.technicalReport as { checks: { state: string; passed: boolean }[]; skipped: string[] };
    expect(report.checks.every((c) => c.passed)).toBe(true);
    expect(report.skipped).toEqual([]);
    expect(ButtonPayload.parse(use!.payload).complete).toBe(true);
    expect(SlotPayload.parse(slot!.payload).states.map((s) => s.state)).toEqual(["selected", "empty", "occupied"]);

    // Transformação local explícita (sem IA) e foco desenhado localmente sobre a revisão aprovada do recorte.
    const local = await applyLocalState(studio, project.id, { componentRevisionId: ids[1]!, state: "hover", transform: { kind: "highlight", amount: 0.3 } });
    const localPayload = ButtonPayload.parse(local.revision.payload);
    expect(localPayload.states.find((s) => s.state === "hover")!.origin).toEqual({ kind: "local_transform", sourceRevisionId: ids[1], sourceState: "normal", transform: { kind: "highlight", amount: 0.3 } });
    expect(local.complete).toBe(false);
    expect(local.missing).toEqual(["pressed", "disabled"]);
    const focused = await applyFocusOverlay(studio, project.id, { componentRevisionId: local.revision.id });
    const focus = ButtonPayload.parse(focused.revision.payload).focus!;
    expect(focus).toMatchObject({ mode: "overlay", fileId: "focus", origin: { kind: "local_overlay", sourceRevisionId: local.revision.id, widthPx: 1 } });
    // O foco é sobreposição, não um sexto estado: a lista de aparências não muda.
    expect(ButtonPayload.parse(focused.revision.payload).states.map((s) => s.state)).toEqual(["normal", "hover"]);
    await expect(applyLocalState(studio, project.id, { componentRevisionId: ids[2]!, state: "empty", transform: { kind: "ramp", steps: -1 } })).rejects.toThrow(/estado-base/);
  });

  it("estados parcialmente falhos não completam o componente", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Guerreiro" });
    const { byId } = await kit(project.id);
    approve(project.id, byId.use!.revision.id);
    // Provedor que "esquece" de pintar a última célula da folha (resposta parcial).
    const store = studio.simulatedStore;
    class PartialProvider extends SimulatedProvider {
      override async fetchResult(remoteId: string): Promise<ProviderResult> {
        const result = await super.fetchResult(remoteId);
        const img = decodePng(result.images[0]!.bytes);
        // Folha 2×2 de 32×16 (gap 8) em 2×: a última célula começa em (48, 32) lógicos.
        fillRect(img, 96, 64, 64, 32, [255, 0, 255, 255]);
        return { ...result, images: [{ bytes: encodePngDeflate(img), mime: "image/png" }] };
      }
    }
    const partial = new PartialProvider(store, { delayMs: 0, idempotent: false, now: () => studio.clock.now().getTime() });
    const r = await run(project.id, { operation: "generate_ui_states", providerProfileId: "simulated", componentRevisionIds: [byId.use!.revision.id] }, byId.use!.asset.id, "ui:partial", partial);
    expect(r.error).toBeNull();
    const rev = getRevision(studio.db, project.id, r.result!.revisionIds[0]!);
    const payload = ButtonPayload.parse(rev.payload);
    expect(payload.states.map((s) => s.state)).toEqual(["normal", "hover", "pressed"]);
    expect(payload.complete).toBe(false);
    const report = rev.technicalReport as { skipped: string[]; missing: string[]; warnings: { en: string }[] };
    expect(report.skipped).toEqual(["disabled"]);
    expect(report.missing).toEqual(["disabled"]);
    expect(report.warnings.some((w) => typeof w === "object" && /incomplete/.test(w.en))).toBe(true);
  });

  it("menu, inventário, diálogo e HUD numa tela: duas proporções, teclado, idioma, reabrir, duplicar, religar e exportar", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Floresta" });
    const { byId } = await kit(project.id);
    for (const s of Object.values(byId)) approve(project.id, s.revision.id);
    const states = await run(project.id, { operation: "generate_ui_states", providerProfileId: "simulated", componentRevisionIds: ["continue", "inventory", "slot"].map((k) => byId[k]!.revision.id) }, byId.continue!.asset.id, "ui:states");
    const [contRev, invRev, slotRev] = states.result!.revisionIds;
    for (const id of states.result!.revisionIds) approve(project.id, id);

    const continueItem = publishMenuItem(studio, project.id, { buttonRevisionId: contRev!, actionId: "continue", text: { key: "menu.continue", sample: "Continuar" }, shortcut: "Enter" });
    const inventoryItem = publishMenuItem(studio, project.id, { buttonRevisionId: invRev!, actionId: "open_inventory", text: { key: "menu.inventory", sample: "Inventário" }, shortcut: "I" });
    expect(continueItem.warnings).toEqual([]);
    approve(project.id, continueItem.revision.id);
    approve(project.id, inventoryItem.revision.id);

    // Poção aprovada (ícone), retrato (vista aprovada do guerreiro) e cenário da floresta para a prévia.
    const potionImg = createImage(12, 12);
    fillRect(potionImg, 3, 2, 6, 9, [60, 200, 90, 255]);
    const potion = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Poção" });
    const potionRev = publishFromSource(studio, project.id, potion.id, { from: "upload", uploadId: await upload(project.id, "pocao.png", encodePng(potionImg)) });
    approve(project.id, potionRev.id);
    const heroImg = createImage(16, 24);
    fillRect(heroImg, 5, 2, 6, 21, [200, 40, 40, 255]);
    const heroUpload = getUpload(studio.db, project.id, await upload(project.id, "heroi.png", encodePng(heroImg)));
    const hero = createAsset(studio.db, studio.clock, { projectId: project.id, family: "character", kind: "base", name: "Guerreiro" });
    const heroBlob = { sha256: heroUpload.normalizedSha256 ?? heroUpload.sha256, bytes: 1, mime: "image/png", modality: "raster" as const, metadata: { width: 16, height: 24 } };
    const heroRev = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: hero.id,
      origin: "import",
      styleRevisionId: null,
      payload: { logicalSize: [16, 24], groundOrigin: [8, 23], state: "default", predecessorRevisionId: null, views: [{ direction: "S", fileId: "s", rect: [0, 0, 16, 24], sourceOffset: [0, 0] }] },
      files: [{ fileKey: "s", role: "normalized", idx: 0, blob: heroBlob }],
    });
    approve(project.id, heroRev.id);
    const forestImg = createImage(240, 160);
    fillRect(forestImg, 0, 0, 240, 160, [40, 90, 60, 255]);
    for (let x = 0; x < 240; x += 7) setPixel(forestImg, x, 100, [20, 50, 30, 255]);
    const forestUpload = getUpload(studio.db, project.id, await upload(project.id, "floresta.png", encodePng(forestImg)));
    const forest = createAsset(studio.db, studio.clock, { projectId: project.id, family: "map", kind: "scene", name: "Floresta" });
    const forestRev = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: forest.id,
      origin: "import",
      styleRevisionId: null,
      payload: {
        outputKind: "flat_image",
        projection: "side",
        logicalSize: [240, 160],
        image: { fileId: "image", rect: [0, 0, 240, 160] },
        layers: [],
        supportPoints: [],
        characterScale: null,
        groundLineY: null,
        editable: { map: false, collisions: false, objects: false },
        cameraTest: null,
      },
      files: [{ fileKey: "image", role: "normalized", idx: 0, blob: { sha256: forestUpload.normalizedSha256 ?? forestUpload.sha256, bytes: 1, mime: "image/png", modality: "raster", metadata: { width: 240, height: 160 } } }],
    });
    approve(project.id, forestRev.id);

    const catalog = uiCatalog(studio, project.id);
    expect(catalog.images.map((i) => i.assetName).sort()).toEqual(["Guerreiro", "Poção"]);
    expect(catalog.backgrounds.map((b) => b.assetName)).toEqual(["Floresta"]);

    const payload = starterScreen({
      meter: { revisionId: byId.health!.revision.id, size: [68, 10] },
      panel: { revisionId: byId.dialogue!.revision.id },
      portrait: { revisionId: heroRev.id, size: [16, 24] },
      menuItems: [
        { revisionId: continueItem.revision.id, size: [64, 14] },
        { revisionId: inventoryItem.revision.id, size: [64, 14] },
      ],
      slot: { revisionId: slotRev!, size: [20, 20] },
      icon: { revisionId: potionRev.id },
      background: { revisionId: forestRev.id },
    });
    const jobsBefore = studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")!.n;
    const saved = saveScreen(studio, project.id, { name: "Floresta · HUD", payload });
    expect(saved.checks.map((c) => [c.resolution, c.offscreen, c.counters])).toEqual([
      [[320, 180], [], []],
      [[400, 300], [], []],
    ]);
    approve(project.id, saved.revision.id);

    // Reabrir: a revisão salva reconstrói a mesma tela; a caixa inferior vai de 304 a 384 px com margens de 8 px.
    const reopened = ScreenPayload.parse(getRevision(studio.db, project.id, saved.revision.id).payload);
    expect(reopened).toEqual(ScreenPayload.parse(payload));
    expect(rectOf(layoutScreen(reopened, [320, 180]), "dialogue")).toEqual([8, 124, 304, 48]);
    expect(rectOf(layoutScreen(reopened, [400, 300]), "dialogue")).toEqual([8, 244, 384, 48]);
    // Teclado: Continuar → Inventário → slots; trocar idioma e valor da vida não chama geração.
    expect(moveFocus(reopened, [320, 180], "menu-item-1", 1)).toBe("menu-item-2");
    const title = reopened.instances.find((i) => i.instanceId === "dialogue-title")!;
    expect(resolveCaption(title, null, reopened.textCatalog, "en").text).toBe("Warrior");
    const variant = structuredClone(reopened);
    variant.instances.find((i) => i.instanceId === "health")!.overrides.value = 25;
    variant.instances.find((i) => i.instanceId === "menu-item-1")!.overrides.state = "pressed";
    variant.instances.find((i) => i.instanceId === "menu-item-1")!.overrides.text = "Usar poção de cura";
    const second = saveScreen(studio, project.id, { assetId: saved.asset.id, payload: variant });
    expect(second.revision.number).toBe(2);
    expect(second.checks[0]!.text).toEqual([{ instanceId: "menu-item-1", key: "menu.continue", outcome: "report", overflow: true }]);
    expect((second.revision.technicalReport as { warnings: { en: string }[] }).warnings[0]!.en).toMatch(/exceeds its area/);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs")!.n).toBe(jobsBefore);

    // Duplicar para outra tela e religar a uma nova revisão do slot (telas afetadas listadas pelas dependências).
    const copy = duplicateAsset(studio, project.id, { revisionId: saved.revision.id, name: "Floresta · cópia" });
    expect(ScreenPayload.parse(copy.revision.payload)).toEqual(reopened);
    const newSlot = await applyLocalState(studio, project.id, { componentRevisionId: slotRev!, state: "selected", transform: { kind: "ramp", steps: 1 } });
    approve(project.id, newSlot.revision.id);
    expect(revisionDependents(studio.db, project.id, slotRev!).filter((d) => d.role === "component").length).toBeGreaterThan(0);
    const rebound = rebindScreen(studio, project.id, { screenRevisionId: saved.revision.id, replacements: [{ from: slotRev!, to: newSlot.revision.id }] });
    expect(rebound.instances).toBe(4);
    expect(ScreenPayload.parse(rebound.revision.payload).instances.filter((i) => i.componentRevisionId === newSlot.revision.id)).toHaveLength(4);

    // Pacote portátil: fecho com componentes, botões dos itens de menu, ícone e retrato; fundo de inspeção e template ficam de fora.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [saved.revision.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect([ready.state, ready.error]).toEqual(["ready", null]);
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const kinds = manifest.entries.map((e: { family: string; kind: string }) => `${e.family}/${e.kind}`).sort();
    expect(kinds).toEqual(["character/base", "item/consumable", "ui/button", "ui/button", "ui/menu_item", "ui/menu_item", "ui/meter", "ui/panel", "ui/screen", "ui/slot"]);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-ui-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "ui.zip"), zip);
    const reader = spawnSync(PYTHON, [READER, path.join(dir, "ui.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(reader.status, reader.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const screen = summary.entries.find((e: { kind: string }) => e.kind === "screen");
    expect(screen.layouts["320x180"].dialogue).toEqual([8, 124, 304, 48]);
    expect(screen.layouts["400x300"].dialogue).toEqual([8, 244, 384, 48]);
    expect(screen.layouts["400x300"]["slot-2"][0] - screen.layouts["400x300"]["slot-1"][0]).toBe(22);
    expect(screen.focusOrder).toEqual(["menu-item-1", "menu-item-2", "slot-1", "slot-2", "slot-3", "slot-4"]);
    expect(screen.states).toMatchObject({ "menu-item-1": "normal", "slot-1": "selected", "slot-2": "occupied" });
    expect(screen.hierarchy.filter((h: { parentId: string }) => h.parentId === "dialogue").map((h: { role: string | null; kind: string }) => h.role ?? h.kind)).toEqual(["panel", "portrait", "title", "body"]);
    expect(screen.languages).toEqual(["pt-BR", "en"]);
    expect(Object.keys(screen.files)).toEqual(["320x180", "400x300"]);
    const meterEntry = summary.entries.find((e: { kind: string }) => e.kind === "meter");
    expect(Object.fromEntries(Object.entries(meterEntry.fills as Record<string, { visiblePx: number }>).map(([k, v]) => [k, v.visiblePx]))).toEqual({ "0": 0, "25": 16, "100": 64 });
    const button = summary.entries.find((e: { kind: string; origins?: Record<string, string> }) => e.kind === "button" && e.origins?.hover);
    expect(button.origins).toMatchObject({ normal: "template_split", hover: "generated_reference" });
    // A barra reconstruída mantém a moldura inteira em 0/25/100: os pixels da moldura são os mesmos nas três.
    const frames = ["0", "25", "100"].map((v) => decodePng(new Uint8Array(readFileSync(path.join(dir, "out", meterEntry.fills[v].file)))));
    const ring = (img: ReturnType<typeof decodePng>) => [0, 67].flatMap((x) => [0, 5, 9].map((y) => Array.from(img.data.slice((y * 68 + x) * 4, (y * 68 + x) * 4 + 4)).join(",")));
    expect(ring(frames[1]!)).toEqual(ring(frames[0]!));
    expect(ring(frames[2]!)).toEqual(ring(frames[0]!));
  });
});

