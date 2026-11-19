import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type BasePayload, type ClipPayload, type Direction, parseRevisionPayload } from "@/contracts";
import { frameDigest } from "@/domain/animation/temporal";
import { validateManifest } from "@/domain/manifest/validate";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect, type Rgba, type RgbaImage } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { createProject, getAsset, getRevision, getUpload, listRevisions, reviewRevision, type RevisionView } from "../catalog/catalog";
import type { DomainFailure } from "../errors";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { importPortablePackage } from "../export/import";
import { runLocal } from "../library/local";
import { saveProfile } from "../providers/profiles";
import { ingestUpload } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { buildRotateViewsPlan } from "./plans";
import { runAnimation, runAnimationChecked } from "./service";
import { buildAnimateObjectPlan, buildCorrectFramePlan, buildCreateStatePlan, buildInterpolatePlan, buildTransferOutfitPlan } from "./temporal-plans";
import { createObjectFromImage, selectViews, stateMatrix } from "./temporal-service";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

// ---------------------------------------------------------------------------
// Servidor HTTP local que imita o OpenRouter (sem rede, sem custo)
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown>;
}
let server: Server;
let baseUrl = "";
const recorded: Recorded[] = [];
let respond: (req: Recorded) => { status: number; body: unknown } = () => ({ status: 404, body: {} });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const rec = { method: req.method!, path: req.url!, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
    recorded.push(rec);
    const out = respond(rec);
    res.writeHead(out.status, { "content-type": "application/json" }).end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.TEST_PROVIDER_KEY = "chave-de-teste";
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
afterEach(() => {
  recorded.length = 0;
  respond = () => ({ status: 404, body: {} });
});

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

// ---------------------------------------------------------------------------
// Arte sintética: baú fechado/aberto (simétrico) com textura de pixel art
// ---------------------------------------------------------------------------

const WOOD: Rgba = [120, 72, 36, 255];
const WOOD_DARK: Rgba = [84, 48, 24, 255];
const IRON: Rgba = [40, 40, 48, 255];
const GOLD: Rgba = [220, 180, 40, 255];

function checker(img: RgbaImage, x: number, y: number, w: number, h: number, a: Rgba, b: Rgba) {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) fillRect(img, x + i, y + j, 1, 1, (i + j) % 2 ? a : b);
}

/** Baú 32×32 de frente (S): fechado, ou aberto com a tampa erguida e o interior escuro. */
function chest(open: boolean, dx = 0, dy = 0): RgbaImage {
  const img = createImage(32, 32);
  const x = 8 + dx;
  const bottom = 30 + dy;
  if (open) {
    fillRect(img, x - 1, bottom - 24, 18, 8, IRON);
    checker(img, x, bottom - 23, 16, 6, WOOD_DARK, WOOD);
    fillRect(img, x, bottom - 16, 16, 4, [20, 12, 8, 255]);
    fillRect(img, x - 1, bottom - 12, 18, 12, IRON);
    checker(img, x, bottom - 11, 16, 10, WOOD, WOOD_DARK);
  } else {
    fillRect(img, x - 1, bottom - 16, 18, 16, IRON);
    checker(img, x, bottom - 15, 16, 14, WOOD, WOOD_DARK);
    fillRect(img, x, bottom - 11, 16, 1, IRON);
  }
  fillRect(img, x + 7, bottom - (open ? 9 : 9), 2, 3, GOLD);
  return img;
}

function scale(img: RgbaImage, k: number): RgbaImage {
  const out = createImage(img.width * k, img.height * k);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const si = (Math.floor(y / k) * img.width + Math.floor(x / k)) * 4;
      out.data.set(img.data.subarray(si, si + 4), (y * out.width + x) * 4);
    }
  }
  return out;
}

/** Folha colunas × linhas com as células dadas, ampliada por k (como a resposta de uma rota genérica). */
function sheet(cells: RgbaImage[], columns: number, rows: number, k: number): Uint8Array {
  const [w, h] = [cells[0]!.width, cells[0]!.height];
  const img = createImage(columns * w, rows * h);
  cells.forEach((c, i) => {
    const ox = (i % columns) * w;
    const oy = Math.floor(i / columns) * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set(c.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), ((oy + y) * img.width + ox + x) * 4);
  });
  return encodePng(scale(img, k));
}

// ---------------------------------------------------------------------------
// Preparação
// ---------------------------------------------------------------------------

const ceiling = { amount: 5, unit: "generations" };

async function runAll() {
  while (await studio.runner().runOnce()) {
    /* processa a fila até esvaziar */
  }
}

function approve(projectId: string, revisionId: string) {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  return reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
}

function resultOf(projectId: string, jobId: string): RevisionView {
  const job = studio.queue.get(jobId)!;
  expect([job.state, job.error_json]).toEqual(["succeeded", null]);
  return getRevision(studio.db, projectId, (JSON.parse(job.result_json!) as { revisionIds: string[] }).revisionIds[0]!);
}

async function upload(projectId: string, name: string, bytes: Uint8Array) {
  const { upload: u } = await ingestUpload(studio, projectId, { name, bytes });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, projectId, u.id).status).toBe("ready");
  return u.id;
}

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Estados" });
  const fixture = buildClareira();
  const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
  const { revisionMap } = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
  return { project, revisionMap, clip: getRevision(studio.db, project.id, revisionMap["warrior-attack-osh-s-v1"]!) };
}

/** Baú fechado aprovado com a vista S (objeto, sem rig humanoide). */
async function chestObject(projectId: string) {
  const uploadId = await upload(projectId, "bau.png", encodePng(chest(false)));
  const { revision } = await createObjectFromImage(studio, projectId, { name: "Baú", image: { from: "upload", uploadId }, direction: "S" });
  approve(projectId, revision.id);
  return getRevision(studio.db, projectId, revision.id);
}

/** Vistas novas do objeto, uma direção por plano (rotação nativa simulada), cada uma aprovada antes da próxima. */
async function rotateViews(projectId: string, revisionId: string, views: Direction[]) {
  let current = revisionId;
  for (const view of views) {
    const run = runAnimation(studio, projectId, { plan: { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: current, view } });
    await runAll();
    current = resultOf(projectId, run.job.id).id;
    approve(projectId, current);
  }
  return getRevision(studio.db, projectId, current);
}

function frameShas(revision: RevisionView) {
  const clip = revision.payload as ClipPayload;
  const sha = (fileId: string) => revision.files.find((f) => f.fileKey === fileId)!.sha256;
  return Object.fromEntries(clip.frames.map((f) => [f.frameId, frameDigest(f, sha)]));
}

/** Pixels compostos de cada quadro (pelo processador local), para comparar RGBA. */
async function composedRgba(revision: RevisionView) {
  const clip = revision.payload as ClipPayload;
  const files = [...new Set(clip.frames.flatMap((f) => f.layers.map((l) => l.fileId)))];
  const { report } = await runLocal(
    studio,
    "compose_frames",
    files.map((fileId) => ({ role: "layer", sha256: revision.files.find((f) => f.fileKey === fileId)!.sha256 })),
    { version: 1, cell: clip.logicalSize, frames: clip.frames.map((f) => ({ key: f.frameId, layers: f.layers.map((l) => ({ input: files.indexOf(l.fileId), rect: l.rect, offset: l.offset })) })), sheet: null, emitFrames: false },
  );
  return Object.fromEntries((report.frames as { key: string; rgbaSha256: string }[]).map((f) => [f.key, f.rgbaSha256]));
}

function err(fn: () => unknown): DomainFailure | undefined {
  try {
    fn();
  } catch (e) {
    return e as DomainFailure;
  }
  return undefined;
}

async function exportZip(projectId: string, revisionIds: string[], key?: string) {
  const { export: requested } = requestExport(studio, projectId, { revisionIds, profile: "portable-v1" }, key);
  await runAll();
  const ready = getExport(studio.db, projectId, requested.id);
  expect(ready.state).toBe("ready");
  return new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
}

function readWithConsumer(zip: Uint8Array) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s3-consumer-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "pacote.zip"), zip);
  const out = spawnSync(PYTHON, [READER, path.join(dir, "pacote.zip"), path.join(dir, "out")], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  return JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8")) as { entries: Record<string, unknown>[] };
}

// ---------------------------------------------------------------------------

describe.skipIf(!existsSync(PYTHON))("estados e edição temporal (cartão S3)", { timeout: 30_000 }, () => {
  it("baú: objeto sem rig, vistas por direção, aprovação parcial com lacuna e só a lacuna é refeita", async () => {
    const { project } = await setup();
    const closed = await chestObject(project.id);
    expect((closed.payload as BasePayload).subject).toBe("object");
    // Personagem não usa a animação de objeto; objeto não exige rig.
    expect(err(() => buildAnimateObjectPlan(studio, project.id, { operation: "animate_object", providerProfileId: "simulated", objectRevisionId: getAsset(studio.db, project.id, getRevision(studio.db, project.id, closed.id).assetId).approvedRevisionId!, direction: "E", action: "open", description: "abre", durationsMs: [100, 100, 100, 100], playback: "once" }))?.code).toBe("coverage_incomplete");

    // Uma direção por plano: cada vista nova é arte nova e as aprovadas seguem com o mesmo blob.
    const four = await rotateViews(project.id, closed.id, ["N", "E", "W"]);
    expect((four.payload as BasePayload).views.map((v) => v.direction)).toEqual(["N", "E", "S", "W"]);
    const sFile = closed.files.find((f) => f.fileKey === "view-s")!;
    expect(four.files.find((f) => f.fileKey === "view-s")!.sha256).toBe(sFile.sha256);
    expect(four.technicalReport).toMatchObject({ operation: "rotate_views", mirrored: false });

    // Aprovação parcial: W reprovada vira lacuna explícita; N/E/S entram com os mesmos blobs.
    const picked = selectViews(studio, project.id, { revisionId: four.id, keep: ["N", "E", "S"], reject: [{ direction: "W", reason: "fechadura do lado errado" }] });
    expect((picked.revision.payload as BasePayload).views.map((v) => v.direction)).toEqual(["N", "E", "S"]);
    expect(picked.gaps).toEqual([{ direction: "W", reason: "fechadura do lado errado" }]);
    expect(picked.revision.files.find((f) => f.fileKey === "view-e")!.sha256).toBe(four.files.find((f) => f.fileKey === "view-e")!.sha256);
    approve(project.id, picked.revision.id);
    // Refazer só a lacuna: um plano de uma direção, as aprovadas não entram no lote.
    const gap = buildRotateViewsPlan(studio, project.id, { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: picked.revision.id, view: "W" });
    expect(gap.plan.params).toMatchObject({ requestedViews: ["W"], approvedViews: ["N", "E", "S"] });
    expect(gap.plan.parts).toHaveLength(1);
    expect(studio.simulatedStore.read().charged).toBe(3);
  });

  it("estado aberto: revisão vinculada à origem, matriz de direções, lacuna preenchida sem regerar o aprovado", async () => {
    const { project } = await setup();
    const closed = await chestObject(project.id);
    await rotateViews(project.id, closed.id, ["N", "E", "W"]);
    const object = getAsset(studio.db, project.id, closed.assetId);

    // Estado não é rename nem postura de empunhadura.
    expect(err(() => buildCreateStatePlan(studio, project.id, { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "default", description: "igual", directions: ["S"] }))?.message).toMatch(/não só o nome/);
    expect(err(() => buildCreateStatePlan(studio, project.id, { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "two_handed", description: "x", directions: ["S"] }))?.message).toMatch(/postura/);
    // Direção sem vista na fonte: sem herdar cobertura inexistente.
    expect(err(() => buildCreateStatePlan(studio, project.id, { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "open", description: "x", directions: ["NE"] }))?.code).toBe("coverage_incomplete");

    const run = runAnimation(studio, project.id, { plan: { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "open", description: "a tampa aberta revela o interior", directions: ["S", "E", "N"] } });
    // Estado só existe como folha por imagem + referência (rota genérica), identificada como tal.
    expect(run.plan.requiredCapabilities).toEqual(["image_references"]);
    expect(run.plan.params).toMatchObject({ sheet: { frameIds: ["view-n", "view-e", "view-s"] } });
    expect(run.targetAssetId).not.toBe(object.id);
    expect(run.plan.params).toMatchObject({ subject: "object", baseRevisionId: object.approvedRevisionId, predecessorStateRevisionId: null, existingStateRevisionId: null });
    await runAll();
    const open = resultOf(project.id, run.job.id);
    const openPayload = open.payload as BasePayload;
    expect(openPayload).toMatchObject({ state: "open", predecessorRevisionId: object.approvedRevisionId, subject: "object", groundOrigin: (closed.payload as BasePayload).groundOrigin });
    expect(openPayload.views.map((v) => v.direction)).toEqual(["N", "E", "S"]);
    expect((open.technicalReport as { gaps: { direction: string }[] }).gaps.map((g) => g.direction)).toEqual(["W"]);
    expect(open.technicalReport).toMatchObject({ strategy: "reference_sheet" });
    // Linhagem: aresta para a identidade e o predecessor derivado do payload.
    const edges = studio.db.all<{ role: string; to_revision_id: string }>("SELECT role, to_revision_id FROM revision_edges WHERE from_revision_id = :id", { id: open.id });
    expect(edges.map((e) => e.role).sort()).toEqual(["identity", "predecessor"]);
    // A base de origem (estado fechado) não mudou.
    expect(getAsset(studio.db, project.id, object.id).approvedRevisionId).toBe(object.approvedRevisionId);

    const picked = selectViews(studio, project.id, { revisionId: open.id, keep: ["N", "S"], reject: [{ direction: "E", reason: "tampa torta" }] });
    approve(project.id, picked.revision.id);
    const matrix = stateMatrix(studio, project.id).find((r) => r.identityAssetId === object.id)!;
    expect(matrix.directions).toEqual(["N", "E", "S", "W"]);
    expect(matrix.states[0]).toMatchObject({ stateKey: "open", approvedViews: ["N", "S"] });
    expect(matrix.states[0]!.gaps.map((g) => g.direction).sort()).toEqual(["E", "W"]);

    // Preencher só a lacuna E: mantém N e S aprovados com os mesmos blobs.
    expect(err(() => buildCreateStatePlan(studio, project.id, { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "open", description: "x", directions: ["S"] }))?.message).toMatch(/já estão aprovadas/);
    const fill = runAnimation(studio, project.id, { plan: { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: object.approvedRevisionId!, stateKey: "open", description: "a tampa aberta revela o interior", directions: ["E"] } });
    expect(fill.targetAssetId).toBe(open.assetId);
    expect(fill.plan.params).toMatchObject({ existingStateRevisionId: picked.revision.id, directions: ["E"] });
    await runAll();
    const filled = resultOf(project.id, fill.job.id);
    expect((filled.payload as BasePayload).views.map((v) => v.direction)).toEqual(["N", "E", "S"]);
    expect(filled.files.find((f) => f.fileKey === "view-s")!.sha256).toBe(picked.revision.files.find((f) => f.fileKey === "view-s")!.sha256);
    expect(parseRevisionPayload("character", "base", filled.payload).success).toBe(true);
  });

  it("animação do baú (vista como quadro 0) e interpolação entre estados: exporta e toca no leitor independente com pivô, estado e tempos", async () => {
    const { project } = await setup();
    const closed = await chestObject(project.id);
    const stateRun = runAnimation(studio, project.id, { plan: { operation: "create_state", providerProfileId: "simulated", sourceRevisionId: closed.id, stateKey: "open", description: "tampa aberta", directions: ["S"] } });
    await runAll();
    const open = resultOf(project.id, stateRun.job.id);
    approve(project.id, open.id);

    const anim = runAnimation(studio, project.id, { plan: { operation: "animate_object", providerProfileId: "simulated", objectRevisionId: closed.id, direction: "S", action: "open", description: "a tampa se abre", durationsMs: [90, 90, 120, 200], playback: "once", costCeiling: ceiling } });
    expect(anim.summary).toMatchObject({ keepFirstFrame: true, expectedFrames: 5, frameIds: ["ref", "f01", "f02", "f03", "f04"] });
    await runAll();
    const clip = resultOf(project.id, anim.job.id);
    const cp = clip.payload as ClipPayload;
    expect(cp).toMatchObject({ rigRevisionId: null, action: "open", state: "default", direction: "S", pivot: (closed.payload as BasePayload).groundOrigin, playback: "once" });
    expect(cp.frames.map((f) => [f.frameId, f.durationMs])).toEqual([["ref", 90], ["f01", 90], ["f02", 90], ["f03", 120], ["f04", 200]]);
    // Folha genérica: uma imagem com os 4 gerados; o quadro 0 é a vista aprovada copiada (pixels exatos).
    expect(clip.technicalReport).toMatchObject({ strategy: "reference_sheet", keepFirstFrame: true, expectedFrames: 5, receivedImages: 1 });
    expect(clip.files.find((f) => f.fileKey === "frame-ref")!.sha256).toBe(closed.files.find((f) => f.fileKey === "view-s")!.sha256);
    // Ciclo (tocha) não repete a referência.
    expect(buildAnimateObjectPlan(studio, project.id, { operation: "animate_object", providerProfileId: "simulated", objectRevisionId: closed.id, direction: "S", action: "flicker", description: "chama oscila", durationsMs: [80, 80, 80, 80], playback: "loop" }).summary).toMatchObject({ keepFirstFrame: false, expectedFrames: 4 });

    // Interpolação nativa entre os dois estados: só intermediários (a rota nativa decide a contagem), extremos uma vez só.
    const interp = runAnimation(studio, project.id, {
      plan: { operation: "interpolate_frames", providerProfileId: "simulated", start: { kind: "view", baseRevisionId: closed.id, direction: "S" }, end: { kind: "view", baseRevisionId: open.id, direction: "S" }, action: "a tampa abre", transitionMs: 301, newClip: { action: "open", startMs: 150, endMs: 250, playback: "once" } },
    });
    expect(interp.plan.params).toMatchObject({ count: null });
    await runAll();
    const transition = resultOf(project.id, interp.job.id);
    const tp = transition.payload as ClipPayload;
    expect(tp.frames.map((f) => f.frameId)).toEqual(["start", "start-end-i01", "start-end-i02", "start-end-i03", "end"]);
    expect(tp.frames.map((f) => f.durationMs)).toEqual([150, 101, 100, 100, 250]);
    expect(transition.files.find((f) => f.fileKey === "kf-start")!.sha256).toBe(closed.files.find((f) => f.fileKey === "view-s")!.sha256);
    expect(transition.files.find((f) => f.fileKey === "kf-end")!.sha256).toBe(open.files.find((f) => f.fileKey === "view-s")!.sha256);

    approve(project.id, clip.id);
    approve(project.id, transition.id);
    const zip = await exportZip(project.id, [clip.id, transition.id, open.id, closed.id]);
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const summary = readWithConsumer(zip);
    const played = summary.entries.find((e) => e.revisionId === clip.id) as { action: string; state: string; pivot: number[]; playback: string; frames: { frameId: string; durationMs: number }[]; totalMs: number };
    expect(played).toMatchObject({ action: "open", state: "default", pivot: (closed.payload as BasePayload).groundOrigin, playback: "once", totalMs: 590 });
    expect(played.frames.map((f) => [f.frameId, f.durationMs])).toEqual(cp.frames.map((f) => [f.frameId, f.durationMs]));
    const openEntry = summary.entries.find((e) => e.revisionId === open.id) as { state: string; subject: string; views: Record<string, string>; predecessor: string };
    expect(openEntry).toMatchObject({ state: "open", subject: "object", predecessor: closed.id });
    expect(Object.keys(openEntry.views)).toEqual(["S"]);
  });

  it("interpolar dois quadros vizinhos do clipe: originais pelo hash, IDs novos, tempos explícitos e sockets interpolados", async () => {
    const { project, clip } = await setup();
    const before = frameShas(clip);
    expect(err(() => buildInterpolatePlan(studio, project.id, { operation: "interpolate_frames", providerProfileId: "simulated", start: { kind: "clip_frame", clipRevisionId: clip.id, frameId: "windup" }, end: { kind: "clip_frame", clipRevisionId: clip.id, frameId: "contact" }, action: "x", transitionMs: 100 }))?.message).toMatch(/logo depois/);
    const run = runAnimation(studio, project.id, { plan: { operation: "interpolate_frames", providerProfileId: "simulated", start: { kind: "clip_frame", clipRevisionId: clip.id, frameId: "windup" }, end: { kind: "clip_frame", clipRevisionId: clip.id, frameId: "advance" }, action: "avanço gradual", transitionMs: 90 } });
    // Atlas compartilhado vira uma única fonte.
    expect(run.plan.sources).toHaveLength(1);
    await runAll();
    const next = resultOf(project.id, run.job.id);
    const np = next.payload as ClipPayload;
    expect(np.frames.map((f) => f.frameId)).toEqual(["windup", "windup-advance-i01", "windup-advance-i02", "windup-advance-i03", "advance", "contact", "recover"]);
    expect(np.frames.slice(1, 4).map((f) => f.durationMs)).toEqual([30, 30, 30]);
    const after = frameShas(next);
    for (const id of ["windup", "advance", "contact", "recover"]) expect(after[id]).toBe(before[id]);
    // Socket da mão direita entre (43,28) e (42,30).
    expect(np.frames[2]!.sockets.find((s) => s.socketId === "hand_right")!.at).toEqual([43, 29]);
    expect(np.events).toEqual((clip.payload as ClipPayload).events);
    expect(next.predecessorId).toBe(clip.id);
    // O clipe original continua com os mesmos arquivos.
    expect(getRevision(studio.db, project.id, clip.id).files.map((f) => f.sha256)).toEqual(clip.files.map((f) => f.sha256));
  });

  it("editar um trecho conserva os quadros protegidos pelo hash e lista eventos e coberturas afetados", async () => {
    const { project, clip, revisionMap } = await setup();
    const before = frameShas(clip);
    const run = runAnimation(studio, project.id, { plan: { operation: "edit_animation", providerProfileId: "simulated", clipRevisionId: clip.id, frameIds: ["contact", "advance"], description: "brilho azul na lâmina" } });
    expect(run.plan.params).toMatchObject({ frameIds: ["advance", "contact"] });
    expect(run.summary).toMatchObject({ protectedFrameIds: ["windup", "recover"] });
    await runAll();
    const edited = resultOf(project.id, run.job.id);
    const after = frameShas(edited);
    expect(after.windup).toBe(before.windup);
    expect(after.recover).toBe(before.recover);
    expect(after.advance).not.toBe(before.advance);
    expect(after.contact).not.toBe(before.contact);
    const report = edited.technicalReport as { protectedFrames: { before: string; after: string }[]; affected: { events: { eventId: string }[]; overlays: { revisionId: string; frameId: string; partId: string }[] } };
    expect(report.protectedFrames.every((f) => f.before === f.after)).toBe(true);
    expect(report.affected.events.map((e) => e.eventId)).toEqual(["impact"]);
    expect(new Set(report.affected.overlays.map((o) => o.revisionId))).toEqual(new Set([revisionMap["chainmail-v1"]]));
    expect(report.affected.overlays.map((o) => `${o.partId}:${o.frameId}`).sort()).toEqual(["sleeve_near:advance", "sleeve_near:contact", "torso:advance", "torso:contact"]);
  });

  it("corrigir só uma região de um quadro: RGBA protegido idêntico, outros quadros com os mesmos hashes; máscara vazia não enfileira", async () => {
    const { project, clip } = await setup();
    // Máscara 64×64: só o quadrante superior direito (o braço da espada) é editável.
    const mask = createImage(64, 64);
    fillRect(mask, 0, 0, 64, 64, [0, 0, 0, 255]);
    fillRect(mask, 32, 0, 32, 32, [255, 255, 255, 255]);
    const maskId = await upload(project.id, "mascara.png", encodePng(mask));
    const empty = createImage(64, 64);
    fillRect(empty, 0, 0, 64, 64, [0, 0, 0, 255]);
    const emptyId = await upload(project.id, "vazia.png", encodePng(empty));
    const plan = { operation: "correct_frame" as const, providerProfileId: "simulated", clipRevisionId: clip.id, frameId: "contact", instruction: "dobre mais o cotovelo", mode: "native-mask" as const };
    await expect(runAnimationChecked(studio, project.id, { plan: { ...plan, maskUploadId: emptyId } })).rejects.toThrow(/Máscara vazia/);
    expect(studio.queue.list(project.id).filter((j) => j.kind === "generation")).toHaveLength(0);

    const planned = buildCorrectFramePlan(studio, project.id, { ...plan, maskUploadId: maskId });
    expect(planned.plan.params).toMatchObject({ contextFrameIds: ["advance", "recover"], partId: "body" });
    const run = await runAnimationChecked(studio, project.id, { plan: { ...plan, maskUploadId: maskId } });
    await runAll();
    const fixed = resultOf(project.id, run.job.id);
    const before = frameShas(clip);
    const after = frameShas(fixed);
    for (const id of ["windup", "advance", "recover"]) expect(after[id]).toBe(before[id]);
    expect(after.contact).not.toBe(before.contact);
    const report = fixed.technicalReport as { composite: { protectedDiffPixels: number; editedPixels: number }; affected: { events: { eventId: string }[]; overlays: { frameId: string }[] } };
    expect(report.composite).toMatchObject({ protectedDiffPixels: 0, editedPixels: 32 * 32 });
    expect(report.affected.events.map((e) => e.eventId)).toEqual(["impact"]);
    expect(report.affected.overlays.every((o) => o.frameId === "contact")).toBe(true);

    // Verificação independente: fora da máscara os 4 bytes RGBA do quadro corrigido são os do original.
    const dir = mkdtempSync(path.join(os.tmpdir(), "s3-fix-"));
    tmpDirs.push(dir);
    const atlas = clip.files.find((f) => f.fileKey === "warrior-attack-s")!;
    writeFileSync(path.join(dir, "atlas.png"), await studio.blobs.read(atlas.sha256));
    writeFileSync(path.join(dir, "fixed.png"), await studio.blobs.read(fixed.files.find((f) => f.role === "corrected")!.sha256));
    const check = spawnSync(
      PYTHON,
      ["-I", "-c", `from PIL import Image\na=Image.open('${dir}/atlas.png').convert('RGBA').crop((128,0,192,64)); f=Image.open('${dir}/fixed.png').convert('RGBA')\nbad=sum(1 for y in range(64) for x in range(64) if not (x>=32 and y<32) and a.getpixel((x,y))!=f.getpixel((x,y)))\nprint(bad)`],
      { encoding: "utf8" },
    );
    expect(check.stdout.trim()).toBe("0");
    expect((await composedRgba(fixed)).windup).toBe((await composedRgba(clip)).windup);
  });

  it("transferir roupa publica um clipe candidato vestido (mesmos frameIds e célula), nunca overlay nem troca da base limpa", async () => {
    const { project, clip, revisionMap } = await setup();
    const potion = getRevision(studio.db, project.id, revisionMap["potion-v1"]!);
    const outfitFile = potion.files.find((f) => f.mime === "image/png" && f.role !== "raw")!;
    const run = runAnimation(studio, project.id, { plan: { operation: "transfer_outfit", providerProfileId: "simulated", clipRevisionId: clip.id, outfitRevisionId: potion.id, outfitFileKey: outfitFile.fileKey, stateKey: "outfit_tunica_verde" } });
    expect(run.targetAssetId).not.toBe(clip.assetId);
    await runAll();
    const dressed = resultOf(project.id, run.job.id);
    const dp = dressed.payload as ClipPayload;
    const cp = clip.payload as ClipPayload;
    expect(getAsset(studio.db, project.id, dressed.assetId)).toMatchObject({ family: "character", kind: "clip" });
    expect(dp.frames.map((f) => f.frameId)).toEqual(cp.frames.map((f) => f.frameId));
    expect(dp.logicalSize).toEqual(cp.logicalSize);
    expect(dp.state).toBe("outfit_tunica_verde");
    expect(dressed.technicalReport).toMatchObject({ dressedCandidate: true, modularOverlay: false, replacesCleanBase: false });
    const edges = studio.db.all<{ role: string; to_revision_id: string }>("SELECT role, to_revision_id FROM revision_edges WHERE from_revision_id = :id AND runtime = 0", { id: dressed.id });
    expect(edges).toEqual(expect.arrayContaining([{ role: "source", to_revision_id: clip.id }, { role: "outfit", to_revision_id: potion.id }]));
    // A base limpa e o clipe de origem continuam aprovados e intactos.
    expect(getAsset(studio.db, project.id, clip.assetId).approvedRevisionId).toBe(clip.id);
    expect(listRevisions(studio.db, project.id, clip.assetId)).toHaveLength(1);
    expect(err(() => buildTransferOutfitPlan(studio, project.id, { operation: "transfer_outfit", providerProfileId: "simulated", clipRevisionId: clip.id, outfitRevisionId: potion.id, outfitFileKey: outfitFile.fileKey, stateKey: "armadura" }))).toBeDefined();
  });

  it("rota genérica (OpenRouter): estado, objeto, interpolação, trecho, roupa e correção por folha identificada como tal, sem código hex no prompt", async () => {
    const { project, clip, revisionMap } = await setup();
    const closed = await chestObject(project.id);
    saveProfile(studio.db, studio.clock, { id: "or", name: "OpenRouter teste", transport: "openrouter_images", baseUrl: `${baseUrl}/api/v1`, secretRef: "TEST_PROVIDER_KEY", model: "openai/gpt-image-1-mini", config: { maxReferences: 16, transparent: true, pricePerImageUsd: 0.01 } });
    // Estado: folha 1×1 da vista S a 8× → o "modelo" devolve o baú aberto deslocado; o casamento assenta no apoio do original.
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(sheet([chest(true, 2, -1)], 1, 1, 8)) }], usage: { cost: 0.011 } } });
    const state = buildCreateStatePlan(studio, project.id, { operation: "create_state", providerProfileId: "or", sourceRevisionId: closed.id, stateKey: "open", description: "tampa aberta", directions: ["S"] });
    expect(state.route.label).toMatch(/rota genérica; não é estado nativo/);
    expect(state.plan.requiredCapabilities).toEqual(["image_references"]);
    expect(state.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    const run = runAnimation(studio, project.id, { plan: { operation: "create_state", providerProfileId: "or", sourceRevisionId: closed.id, stateKey: "open", description: "tampa aberta", directions: ["S"] } });
    await runAll();
    const open = resultOf(project.id, run.job.id);
    expect(open.technicalReport).toMatchObject({ strategy: "reference_sheet" });
    const sent = recorded.find((r) => r.path === "/api/v1/images")!.body as { input_references: unknown[]; aspect_ratio: string; background?: string };
    expect(sent.input_references).toHaveLength(1);
    expect(sent.aspect_ratio).toBe("1:1");
    // O baú aberto (mais alto) não encolhe para a altura do fechado e pisa no mesmo chão.
    const dir = mkdtempSync(path.join(os.tmpdir(), "s3-open-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "open.png"), await studio.blobs.read(open.files.find((f) => f.fileKey === "view-s")!.sha256));
    const bbox = spawnSync(PYTHON, ["-I", "-c", `from PIL import Image\nprint(list(Image.open('${dir}/open.png').convert('RGBA').getchannel('A').getbbox()))`], { encoding: "utf8" }).stdout.trim();
    expect(JSON.parse(bbox)).toEqual([7, 6, 25, 30]);
    approve(project.id, open.id);

    // Interpolação genérica: 2 intermediários numa folha 2×2 (1:1; a rota recusa 2:1), duas referências (início e fim).
    recorded.length = 0;
    const ajar = (n: number) => {
      const img = chest(n > 1);
      fillRect(img, 12, 8 + n, 8, 2, [200, 200, 60, 255]);
      return img;
    };
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(sheet([ajar(1), ajar(2)], 2, 2, 8)) }], usage: { cost: 0.012 } } });
    const interp = runAnimation(studio, project.id, { plan: { operation: "interpolate_frames", providerProfileId: "or", start: { kind: "view", baseRevisionId: closed.id, direction: "S" }, end: { kind: "view", baseRevisionId: open.id, direction: "S" }, action: "a tampa abre", count: 2, transitionMs: 200 } });
    expect(interp.route.label).toMatch(/não é interpolação nativa/);
    await runAll();
    const tclip = resultOf(project.id, interp.job.id);
    expect((tclip.payload as ClipPayload).frames.map((f) => f.frameId)).toEqual(["start", "start-end-i01", "start-end-i02", "end"]);
    expect((recorded.find((r) => r.path === "/api/v1/images")!.body as { input_references: unknown[]; aspect_ratio: string }).aspect_ratio).toBe("1:1");

    // Correção genérica: alvo + guia + 2 vizinhos; o candidato muda o quadro todo, só a região entra.
    recorded.length = 0;
    const atlasSha = clip.files.find((f) => f.fileKey === "warrior-attack-s")!.sha256;
    const composed = await runLocal(studio, "compose_frames", [{ role: "layer", sha256: atlasSha }], { version: 1, cell: [64, 64], frames: [{ key: "contact", layers: [{ input: 0, rect: [128, 0, 64, 64], offset: [0, 0] }] }], sheet: { columns: 1, rows: 1, scale: 16, flattenOnto: null }, emitFrames: false });
    const candidate = new Uint8Array(await studio.blobs.read(composed.outputs.find((o) => o.role === "sheet")!.blob.sha256));
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(candidate) }], usage: { cost: 0.013 } } });
    const fix = await runAnimationChecked(studio, project.id, { plan: { operation: "correct_frame", providerProfileId: "or", clipRevisionId: clip.id, frameId: "contact", instruction: "dobre o cotovelo", mode: "candidate-composite" } });
    expect(fix.route.label).toMatch(/Candidato editado \+ recorte local/);
    expect(err(() => buildCorrectFramePlan(studio, project.id, { operation: "correct_frame", providerProfileId: "or", clipRevisionId: clip.id, frameId: "contact", instruction: "x", mode: "native-mask" }))?.message).toMatch(/não recebe máscara nativa/);
    await runAll();
    const fixed = resultOf(project.id, fix.job.id);
    const body = recorded.find((r) => r.path === "/api/v1/images")!.body as { input_references: unknown[]; prompt: string };
    expect(body.input_references).toHaveLength(4);
    expect(body.prompt).not.toMatch(/#[0-9a-f]{6}/i);
    expect(frameShas(fixed).windup).toBe(frameShas(clip).windup);

    // Animação de objeto por folha: 4 gerados (2×2) + quadro 0 = vista aprovada copiada (pixels exatos).
    recorded.length = 0;
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(sheet([chest(false, 0, -1), chest(false, 0, -3), chest(true, 0, -2), chest(true)], 2, 2, 8)) }], usage: { cost: 0.014 } } });
    const anim = runAnimation(studio, project.id, { plan: { operation: "animate_object", providerProfileId: "or", objectRevisionId: closed.id, direction: "S", action: "open", description: "a tampa abre", durationsMs: [90, 90, 110, 200], playback: "once", endFrame: { revisionId: open.id, direction: "S" } } });
    expect(anim.route.label).toMatch(/não é animação nativa/);
    await runAll();
    const animRev = resultOf(project.id, anim.job.id);
    expect((animRev.payload as ClipPayload).frames.map((f) => f.frameId)).toEqual(["ref", "f01", "f02", "f03", "f04"]);
    expect(animRev.files.find((f) => f.fileKey === "frame-ref")!.sha256).toBe(closed.files.find((f) => f.fileKey === "view-s")!.sha256);
    expect((recorded.find((r) => r.path === "/api/v1/images")!.body as { input_references: unknown[] }).input_references).toHaveLength(2);

    // Edição de trecho e roupa por folha: mesma disposição, casamento pelo apoio de cada original.
    const contact = (await runLocal(studio, "compose_frames", [{ role: "layer", sha256: atlasSha }], { version: 1, cell: [64, 64], frames: [0, 1, 2, 3].map((i) => ({ key: `k${i}`, layers: [{ input: 0, rect: [i * 64, 0, 64, 64], offset: [0, 0] }] })), sheet: { columns: 2, rows: 2, scale: 8, flattenOnto: null }, emitFrames: false })).outputs.find((o) => o.role === "sheet")!;
    const sheetBytes = new Uint8Array(await studio.blobs.read(contact.blob.sha256));
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(sheetBytes) }], usage: { cost: 0.015 } } });
    const edit = runAnimation(studio, project.id, { plan: { operation: "edit_animation", providerProfileId: "or", clipRevisionId: clip.id, frameIds: ["windup", "advance", "contact", "recover"], description: "lâmina azulada" } });
    await runAll();
    const editRev = resultOf(project.id, edit.job.id);
    expect((editRev.payload as ClipPayload).frames.map((f) => f.frameId)).toEqual(["windup", "advance", "contact", "recover"]);
    // A folha devolvida é a própria referência: depois do casamento, os pixels de cada quadro voltam iguais.
    expect(Object.values(await composedRgba(editRev))).toEqual(Object.values(await composedRgba(clip)));
    const potion = getRevision(studio.db, project.id, revisionMap["potion-v1"]!);
    const outfit = runAnimation(studio, project.id, { plan: { operation: "transfer_outfit", providerProfileId: "or", clipRevisionId: clip.id, outfitRevisionId: potion.id, outfitFileKey: potion.files.find((f) => f.mime === "image/png" && f.role !== "raw")!.fileKey } });
    expect(outfit.route.label).toMatch(/não overlay modular/);
    await runAll();
    expect((resultOf(project.id, outfit.job.id).payload as ClipPayload).state).toMatch(/^outfit_/);
  });
});
