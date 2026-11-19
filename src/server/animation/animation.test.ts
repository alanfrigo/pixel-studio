import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type ClipPayload, type MotionPayload, parseRevisionPayload } from "@/contracts";
import { BUILTIN_PRESETS } from "@/domain/animation/presets";
import { defaultHumanoidPose, humanoidSkeleton, moveJoint, presetPoses } from "@/domain/animation/skeleton";
import { validateManifest } from "@/domain/manifest/validate";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect, type Rgba, type RgbaImage } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { createProject, getAsset, getRevision, listRevisions, reviewRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { importPortablePackage } from "../export/import";
import { saveProfile } from "../providers/profiles";
import { makeTestStudio, type TestStudio } from "../testing";
import { buildAnimateSkeletonPlan, buildAnimateTextPlan, buildRotateViewsPlan } from "./plans";
import { composeBaseViews, retimeClipRevision, runAnimation, saveMotion } from "./service";

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

/** Folha 2×2 (células de 64), com um boneco por célula em posições diferentes; o terceiro "pula" 4 px. */
function fakeSheet(columns = 2, rows = 2, frames = 4, cell = 64): Uint8Array {
  const img = createImage(columns * cell, rows * cell);
  const body: Rgba = [40, 90, 200, 255];
  const outline: Rgba = [20, 20, 28, 255];
  const shade: Rgba = [70, 120, 230, 255];
  for (let i = 0; i < frames; i++) {
    const c = i % columns;
    const r = Math.floor(i / columns);
    const fx = c * cell + 26 + i * 2;
    const ground = (r + 1) * cell - 4 - (i === 2 ? 4 : 0);
    fillRect(img, fx - 1, ground - 49, 14, 49, outline);
    fillRect(img, fx, ground - 48, 12, 47, body);
    // Textura de pixel art (xadrez por pixel lógico): a grade aparente fica detectável como numa resposta real.
    for (let y = ground - 48; y < ground - 1; y++) for (let x = fx; x < fx + 12; x++) if ((x + y) % 2) fillRect(img, x, y, 1, 1, shade);
  }
  return encodePng(scale(img, 1));
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

// ---------------------------------------------------------------------------
// Preparação: fixture da clareira aprovada (guerreiro com vista S e rig)
// ---------------------------------------------------------------------------

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Animação" });
  const fixture = buildClareira();
  const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
  const { revisionMap } = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
  const base = getRevision(studio.db, project.id, revisionMap["warrior-base-v1"]!);
  return { project, base, revisionMap };
}

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

function clipOf(projectId: string, jobId: string) {
  const job = studio.queue.get(jobId)!;
  expect([job.state, job.error_json]).toEqual(["succeeded", null]);
  const revisionId = (JSON.parse(job.result_json!) as { revisionIds: string[] }).revisionIds[0]!;
  return getRevision(studio.db, projectId, revisionId);
}

function humanoidMotion(baseCell: [number, number], frames: number, direction: "S" | "E" = "S", action = "hurt"): MotionPayload {
  const ref = defaultHumanoidPose(direction, baseCell, [16, 8, 32, 52]);
  const preset = BUILTIN_PRESETS.find((p) => p.key === "hurt")!;
  return {
    skeleton: humanoidSkeleton(),
    generationCell: baseCell,
    direction,
    projection: "top_down",
    action,
    referencePose: ref,
    poses: presetPoses(preset.poseRecipe, ref, direction, frames).map((joints, i) => ({ poseId: preset.frameIds[i] ?? `p${i + 1}`, durationMs: preset.durationsMs[i] ?? 100, joints })),
    loop: false,
    jointSocketMap: [],
  };
}

describe.skipIf(!existsSync(PYTHON))("animação (cartão S1)", () => {
  it("um clique: preset gera clipe revisável; duplo clique devolve o mesmo job e cobra uma vez", async () => {
    const { project, base } = await setup();
    const input = {
      plan: { operation: "animate_preset" as const, providerProfileId: "simulated", baseRevisionId: base.id, direction: "S" as const, presetKey: "idle", costCeiling: ceiling },
      oneClick: true,
    };
    const first = runAnimation(studio, project.id, input);
    const second = runAnimation(studio, project.id, input);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(first.plan.prompt.brief).toBe(""); // nenhum prompt escrito pelo artista
    expect(first.route.strategy).toBe("native");
    await runAll();
    expect(studio.simulatedStore.read().charged).toBe(1);
    // Repetir o clique depois de pronto não gera de novo; "nova variação" é ação separada.
    expect(runAnimation(studio, project.id, input).created).toBe(false);
    expect(runAnimation(studio, project.id, { ...input, variation: 1 }).created).toBe(true);

    const clip = clipOf(project.id, first.job.id);
    expect(clip.status).toBe("candidate");
    const payload = clip.payload as ClipPayload;
    expect(payload.frames.map((f) => [f.frameId, f.durationMs])).toEqual([
      ["rest", 180],
      ["rise", 180],
      ["peak", 180],
      ["fall", 180],
    ]);
    expect(payload).toMatchObject({ action: "idle", direction: "S", playback: "loop", logicalSize: [64, 64], pivot: [32, 60] });
    expect(payload.rigRevisionId).not.toBeNull();
    expect(parseRevisionPayload("character", "clip", payload).success).toBe(true);
    expect(getAsset(studio.db, project.id, clip.assetId).name).toBe("Guerreiro · idle · S");
  });

  it("um clique sem teto ou com custo acima do teto abre a configuração e não enfileira", async () => {
    const { project, base } = await setup();
    const plan = { operation: "animate_preset" as const, providerProfileId: "simulated", baseRevisionId: base.id, direction: "S" as const, presetKey: "walk" };
    const noCeiling = (() => {
      try {
        runAnimation(studio, project.id, { plan, oneClick: true });
      } catch (err) {
        return err as DomainFailure;
      }
    })();
    expect(noCeiling?.code).toBe("budget_exceeded");
    expect(noCeiling?.details).toMatchObject({ needsConfiguration: true, reason: "ceiling_missing" });
    expect(() => runAnimation(studio, project.id, { plan: { ...plan, costCeiling: { amount: 0.5, unit: "generations" } }, oneClick: true })).toThrow(/excede o teto/);
    // Preset de esqueleto sem movimento aprovado: lacuna explícita, sem envio.
    expect(() => runAnimation(studio, project.id, { plan: { ...plan, presetKey: "hurt", costCeiling: ceiling }, oneClick: true })).toThrow(/aprove um movimento hurt/);
    expect(studio.queue.list(project.id)).toHaveLength(0);
    expect(studio.simulatedStore.read().submissions).toBe(0);
  });

  it("direção sem vista é lacuna, não espelho; a vista nova é arte nova e as aprovadas ficam intactas", async () => {
    const { project, base } = await setup();
    const err = (() => {
      try {
        buildAnimateTextPlan(studio, project.id, { operation: "animate_text", providerProfileId: "simulated", baseRevisionId: base.id, direction: "W", actionText: "acenar", durationsMs: [100, 100, 100, 100], playback: "loop" });
      } catch (e) {
        return e as DomainFailure;
      }
    })();
    expect(err?.code).toBe("coverage_incomplete");
    expect(err?.message).toMatch(/espelho não é implícito/);

    const plan = buildRotateViewsPlan(studio, project.id, { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: base.id, view: "W", asymmetries: ["escudo no braço esquerdo"] });
    expect(plan.plan.params).toMatchObject({ requestedViews: ["W"], approvedViews: ["S"], sourceView: "S" });
    const run = runAnimation(studio, project.id, { plan: { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: base.id, view: "W", asymmetries: ["escudo no braço esquerdo"] } });
    expect(run.targetAssetId).toBe(base.assetId);
    await runAll();
    const withW = clipOf(project.id, run.job.id);
    const payload = withW.payload as { views: { direction: string; fileId: string }[]; orientation: unknown };
    expect(payload.views.map((v) => v.direction)).toEqual(["S", "W"]);
    expect(payload.orientation).toMatchObject({ projection: "top_down" });
    const report = withW.technicalReport as { mirrored: boolean; keptViews: { sha256: string }[] };
    expect(report.mirrored).toBe(false);
    const sFile = base.files.find((f) => f.fileKey === "warrior-base-s")!;
    expect(report.keptViews[0]!.sha256).toBe(sFile.sha256);
    expect(withW.files.find((f) => f.fileKey === "warrior-base-s")!.sha256).toBe(sFile.sha256);

    // Verificador independente: a vista W não é o espelho horizontal da S.
    const dir = mkdtempSync(path.join(os.tmpdir(), "s1-mirror-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "s.png"), await studio.blobs.read(sFile.sha256));
    writeFileSync(path.join(dir, "w.png"), await studio.blobs.read(withW.files.find((f) => f.fileKey === "view-w")!.sha256));
    const same = execFileSync(PYTHON, ["-I", "-c", `from PIL import Image, ImageOps\ns=Image.open('${dir}/s.png').convert('RGBA'); w=Image.open('${dir}/w.png').convert('RGBA')\nprint(ImageOps.mirror(s).tobytes()==w.tobytes())`], { encoding: "utf8" }).trim();
    expect(same).toBe("False");

    // Escolha por vista: compor e aprovar; a vista S continua com o mesmo blob.
    const composed = composeBaseViews(studio, project.id, { baseAssetId: base.assetId, picks: [{ direction: "S", revisionId: base.id }, { direction: "W", revisionId: withW.id }] });
    expect(composed.revision.files.map((f) => f.sha256).sort()).toEqual([sFile.sha256, withW.files.find((f) => f.fileKey === "view-w")!.sha256].sort());
    approve(project.id, composed.revision.id);
    // Agora W é animável, e a vista já aprovada não é regerada.
    expect(buildAnimateTextPlan(studio, project.id, { operation: "animate_text", providerProfileId: "simulated", baseRevisionId: composed.revision.id, direction: "W", actionText: "acenar", durationsMs: [100, 100, 100, 100], playback: "loop" }).plan.params).toMatchObject({ direction: "W" });
    expect(() => buildRotateViewsPlan(studio, project.id, { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: composed.revision.id, view: "W" })).toThrow(/já está aprovada/);
  });

  it("isométrico: plano leva o mapa mundo → vista e a base publicada o exporta", async () => {
    const { project, base } = await setup();
    const planned = buildRotateViewsPlan(studio, project.id, { operation: "rotate_views", providerProfileId: "simulated", baseRevisionId: base.id, view: "SE", projection: "isometric" });
    expect(planned.plan.requiredCapabilities).toEqual(["rotation_8", "isometric_views"]);
    expect((planned.plan.params as { worldToView: Record<string, string> }).worldToView).toMatchObject({ E: "SE", N: "NE", S: "SW", W: "NW" });
  });

  it("ajustar a duração local publica revisão nova sem gerar: mesmos arquivos, zero envios", async () => {
    const { project, base } = await setup();
    const run = runAnimation(studio, project.id, { plan: { operation: "animate_preset", providerProfileId: "simulated", baseRevisionId: base.id, direction: "S", presetKey: "attack-shield", costCeiling: ceiling }, oneClick: true });
    await runAll();
    const clip = clipOf(project.id, run.job.id);
    expect((clip.payload as ClipPayload).stance).toBe("one_hand_shield");
    const before = studio.simulatedStore.read().submissions;
    const retimed = retimeClipRevision(studio, project.id, { clipRevisionId: clip.id, durationsMs: [200, 80, 40, 240] });
    expect(retimed.unchanged).toBe(false);
    expect(studio.simulatedStore.read().submissions).toBe(before);
    const next = retimed.revision;
    expect((next.payload as ClipPayload).frames.map((f) => f.durationMs)).toEqual([200, 80, 40, 240]);
    expect((next.payload as ClipPayload).frames.map((f) => f.frameId)).toEqual(["windup", "advance", "contact", "recover"]);
    const shas = (r: typeof clip) => r.files.filter((f) => f.role === "frame").map((f) => f.sha256);
    expect(shas(next)).toEqual(shas(clip));
    expect(next).toMatchObject({ origin: "edit", predecessorId: clip.id });
    expect((next.technicalReport as { providerCalls: number }).providerCalls).toBe(0);
    expect(retimeClipRevision(studio, project.id, { clipRevisionId: next.id, durationsMs: [200, 80, 40, 240] }).unchanged).toBe(true);
    expect(() => retimeClipRevision(studio, project.id, { clipRevisionId: next.id, durationsMs: [200, 80] })).toThrow(/Esperadas 4 durações/);
  });

  it("esqueleto: poses vão como dados; mudar uma pose muda só o quadro correspondente", async () => {
    const { project, base } = await setup();
    const motion = humanoidMotion([64, 64], 3);
    const saved = saveMotion(studio, project.id, { baseRevisionId: base.id, motion, presetKey: "hurt" });
    approve(project.id, saved.revision.id);
    const plan = (motionRevisionId: string) => ({ operation: "animate_skeleton" as const, providerProfileId: "simulated", baseRevisionId: base.id, motionRevisionId, actionText: "recua ao ser atingido", playback: "once" as const });
    const a = buildAnimateSkeletonPlan(studio, project.id, plan(saved.revision.id));
    expect(a.route.label).toMatch(/Esqueleto enviado como dados/);
    expect(a.plan.requiredCapabilities).toEqual(["skeleton_keypoints"]);
    const runA = runAnimation(studio, project.id, { plan: plan(saved.revision.id) });

    // Corrige o cotovelo direito só na segunda pose.
    const edited: MotionPayload = { ...motion, poses: motion.poses.map((p, i) => (i === 1 ? { ...p, joints: moveJoint(p.joints, "elbow_r", 0.2, 0.3) } : p)) };
    const saved2 = saveMotion(studio, project.id, { baseRevisionId: base.id, motion: edited, presetKey: "hurt" });
    expect(saved2.asset.id).toBe(saved.asset.id);
    approve(project.id, saved2.revision.id);
    const b = buildAnimateSkeletonPlan(studio, project.id, plan(saved2.revision.id));
    expect(b.digest).not.toBe(a.digest);
    expect(b.plan.sources[1]!.sha256).not.toBe(a.plan.sources[1]!.sha256);
    const runB = runAnimation(studio, project.id, { plan: plan(saved2.revision.id) });
    await runAll();
    const frames = (rev: ReturnType<typeof clipOf>) => rev.files.filter((f) => f.role === "frame").sort((x, y) => x.idx - y.idx).map((f) => f.sha256);
    const [fa, fb] = [frames(clipOf(project.id, runA.job.id)), frames(clipOf(project.id, runB.job.id))];
    expect(fa[0]).toBe(fb[0]);
    expect(fa[1]).not.toBe(fb[1]);
    expect(fa[2]).toBe(fb[2]);
    expect((clipOf(project.id, runB.job.id).payload as ClipPayload).motionRevisionId).toBe(saved2.revision.id);

    // Um clique do preset de esqueleto usa o movimento aprovado para (base, ação, direção).
    const oneClick = runAnimation(studio, project.id, { plan: { operation: "animate_preset", providerProfileId: "simulated", baseRevisionId: base.id, direction: "S", presetKey: "hurt", costCeiling: ceiling }, oneClick: true });
    expect(oneClick.plan.params).toMatchObject({ mode: "skeleton", motionRevisionId: saved2.revision.id });
    await runAll();
    expect((clipOf(project.id, oneClick.job.id).payload as ClipPayload).frames.map((f) => f.durationMs)).toEqual([100, 70, 140]);
  });

  it("clipe aprovado passa no manifesto, exporta pelo X1 e toca no consumidor independente com os tempos", async () => {
    const { project, base } = await setup();
    const run = runAnimation(studio, project.id, { plan: { operation: "animate_preset", providerProfileId: "simulated", baseRevisionId: base.id, direction: "S", presetKey: "walk", costCeiling: ceiling }, oneClick: true });
    await runAll();
    const clip = clipOf(project.id, run.job.id);
    const retimed = retimeClipRevision(studio, project.id, { clipRevisionId: clip.id, durationsMs: [100, 140, 100, 100, 140, 100] }).revision;
    approve(project.id, retimed.id);
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [retimed.id], profile: "portable-v1" });
    await runAll();
    const ready = getExport(studio.db, project.id, requested.id);
    expect(ready.state).toBe("ready");
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const entry = manifest.entries.find((e: { revisionId: string }) => e.revisionId === retimed.id);
    expect(entry.payload.frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([100, 140, 100, 100, 140, 100]);

    const dir = mkdtempSync(path.join(os.tmpdir(), "s1-consumer-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "pacote.zip"), zip);
    const out = spawnSync(PYTHON, [READER, path.join(dir, "pacote.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(out.status, out.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8")) as { entries: { revisionId: string; frames?: { frameId: string; durationMs: number }[] }[] };
    const played = summary.entries.find((e) => e.revisionId === retimed.id);
    expect(played?.frames?.map((f) => [f.frameId, f.durationMs])).toEqual([
      ["contact-l", 100],
      ["down-l", 140],
      ["pass-l", 100],
      ["contact-r", 100],
      ["down-r", 140],
      ["pass-r", 100],
    ]);
  });

  it("rota genérica (OpenRouter): folha por imagem + referência, identificada como tal, fatiada e assentada no apoio", async () => {
    const { project, base } = await setup();
    saveProfile(studio.db, studio.clock, {
      id: "or",
      name: "OpenRouter teste",
      transport: "openrouter_images",
      baseUrl: `${baseUrl}/api/v1`,
      secretRef: "TEST_PROVIDER_KEY",
      model: "openai/gpt-image-1-mini",
      config: { maxReferences: 16, transparent: true, pricePerImageUsd: 0.01 },
    });
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(fakeSheet()) }], usage: { cost: 0.0123 } } });
    const text = buildAnimateTextPlan(studio, project.id, { operation: "animate_text", providerProfileId: "or", baseRevisionId: base.id, direction: "S", actionText: "pulando no lugar", durationsMs: [90, 90, 90, 90], playback: "loop" });
    expect(text.route.strategy).toBe("reference_sheet");
    expect(text.route.label).toMatch(/Folha de quadros por imagem/);
    expect(text.plan.requiredCapabilities).toEqual(["image_references"]);
    expect(text.plan.prompt.compiled).not.toMatch(/#[0-9a-f]{6}/i);
    // Esqueleto nessa rota vira guia em imagem, nunca "esqueleto".
    const motion = humanoidMotion([64, 64], 4);
    const saved = saveMotion(studio, project.id, { baseRevisionId: base.id, motion: { ...motion, poses: [...motion.poses, { ...motion.poses[0]!, poseId: "settle" }] } });
    approve(project.id, saved.revision.id);
    const skel = buildAnimateSkeletonPlan(studio, project.id, { operation: "animate_skeleton", providerProfileId: "or", baseRevisionId: base.id, motionRevisionId: saved.revision.id, actionText: "recua", playback: "once" });
    expect(skel.route.label).toMatch(/Guia de poses em imagem.*não é esqueleto estruturado/);
    expect(skel.plan.requiredCapabilities).not.toContain("skeleton_keypoints");

    const run = runAnimation(studio, project.id, { plan: { operation: "animate_text", providerProfileId: "or", baseRevisionId: base.id, direction: "S", actionText: "pulando no lugar", durationsMs: [90, 90, 90, 90], playback: "loop" } });
    await runAll();
    const clip = clipOf(project.id, run.job.id);
    const sent = recorded.find((r) => r.path === "/api/v1/images")!.body as { aspect_ratio: string; input_references: unknown[]; background?: string };
    expect(sent.aspect_ratio).toBe("1:1");
    expect(sent.input_references).toHaveLength(1);
    expect(sent.background).toBe("transparent");
    const report = clip.technicalReport as { strategy: string; routeLabel: string; frames: { details: { sheet: { frames: { lift: number; offset: number[] }[]; scale: { resampled: boolean } } } }[] };
    expect(report.strategy).toBe("reference_sheet");
    const sheet = report.frames[0]!.details.sheet;
    expect(sheet.frames.map((f) => f.lift)).toEqual([0, 0, 4, 0]); // o salto desenhado é preservado
    expect((clip.payload as ClipPayload).frames).toHaveLength(4);
    expect(clip.files.filter((f) => f.role === "frame")).toHaveLength(4);

    // Guia de poses: duas referências (base + guia raster), grade 3×2 para 5 poses.
    recorded.length = 0;
    respond = () => ({ status: 200, body: { data: [{ b64_json: b64(fakeSheet(3, 2, 5)) }], usage: { cost: 0.0123 } } });
    const runSkel = runAnimation(studio, project.id, { plan: { operation: "animate_skeleton", providerProfileId: "or", baseRevisionId: base.id, motionRevisionId: saved.revision.id, actionText: "recua", playback: "once" } });
    await runAll();
    expect(clipOf(project.id, runSkel.job.id).status).toBe("candidate");
    const sentSkel = recorded.find((r) => r.path === "/api/v1/images")!.body as { aspect_ratio: string; input_references: unknown[] };
    expect(sentSkel.input_references).toHaveLength(2);
    expect(sentSkel.aspect_ratio).toBe("3:2");
  });

  it("revisões candidatas não servem de fonte; movimento precisa estar aprovado", async () => {
    const { project, base } = await setup();
    const saved = saveMotion(studio, project.id, { baseRevisionId: base.id, motion: humanoidMotion([64, 64], 3) });
    expect(() => buildAnimateSkeletonPlan(studio, project.id, { operation: "animate_skeleton", providerProfileId: "simulated", baseRevisionId: base.id, motionRevisionId: saved.revision.id, actionText: "x", playback: "once" })).toThrow(/precisa estar aprovado/);
    expect(listRevisions(studio.db, project.id, saved.asset.id)).toHaveLength(1);
  });
});
