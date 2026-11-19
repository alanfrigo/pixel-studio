import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as animationRoute from "@/app/api/v1/projects/[projectId]/animation/route";
import * as retimeRoute from "@/app/api/v1/projects/[projectId]/animation/retime/route";
import * as assetRoute from "@/app/api/v1/projects/[projectId]/assets/[assetId]/route";
import * as reviewsRoute from "@/app/api/v1/projects/[projectId]/assets/[assetId]/reviews/route";
import * as revisionsRoute from "@/app/api/v1/projects/[projectId]/assets/[assetId]/revisions/route";
import * as assetsRoute from "@/app/api/v1/projects/[projectId]/assets/route";
import * as fontCoverageRoute from "@/app/api/v1/projects/[projectId]/dialogue/fonts/coverage/route";
import * as downloadRoute from "@/app/api/v1/projects/[projectId]/exports/[exportId]/download/route";
import * as exportRoute from "@/app/api/v1/projects/[projectId]/exports/[exportId]/route";
import * as exportsRoute from "@/app/api/v1/projects/[projectId]/exports/route";
import * as plansRoute from "@/app/api/v1/projects/[projectId]/generation-plans/route";
import * as cancelRoute from "@/app/api/v1/projects/[projectId]/jobs/[jobId]/cancel/route";
import * as outputRoute from "@/app/api/v1/projects/[projectId]/jobs/[jobId]/outputs/[index]/route";
import * as retryRoute from "@/app/api/v1/projects/[projectId]/jobs/[jobId]/retry/route";
import * as jobRoute from "@/app/api/v1/projects/[projectId]/jobs/[jobId]/route";
import * as jobsRoute from "@/app/api/v1/projects/[projectId]/jobs/route";
import * as mediaRoute from "@/app/api/v1/projects/[projectId]/media/[fileId]/route";
import * as scenePreviewRoute from "@/app/api/v1/projects/[projectId]/scenes/compose/preview/route";
import * as sceneComposeRoute from "@/app/api/v1/projects/[projectId]/scenes/compose/route";
import * as sceneLayersRoute from "@/app/api/v1/projects/[projectId]/scenes/layers/route";
import * as screensRoute from "@/app/api/v1/projects/[projectId]/ui/screens/route";
import * as uiRoute from "@/app/api/v1/projects/[projectId]/ui/route";
import * as uploadRoute from "@/app/api/v1/projects/[projectId]/uploads/[uploadId]/route";
import * as uploadsRoute from "@/app/api/v1/projects/[projectId]/uploads/route";
import * as projectsRoute from "@/app/api/v1/projects/route";
import { ClipPayload, ScenePayload, ScreenPayload, type GenerationPlan } from "@/contracts";
import { validateManifest } from "@/domain/manifest/validate";
import { sha256Hex } from "@/domain/manifest/verify-files";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect, getPixel, readPngInfo, type RgbaImage } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import type { AssetView, ProjectView, RevisionView, ReviewResult, UploadView } from "../catalog/catalog";
import { REPO_ROOT } from "../config";
import { decodePng } from "../equipment/png";
import type { ExportView } from "../export/exports";
import { importPortablePackage, type ImportResult } from "../export/import";
import type { JobView } from "../jobs/queue";
import { SimulatedProvider } from "../providers/simulated";
import { pythonInfo } from "../python/bridge";
import { makeTestStudio, type TestStudio } from "../testing";

const GLOBAL_KEY = Symbol.for("pixel-studio.web");
const globals = globalThis as Record<symbol, unknown>;
const python = process.env.PIXEL_STUDIO_PYTHON ?? path.join(REPO_ROOT, "python", ".venv", "bin", "python");
let studio: TestStudio | undefined;

beforeAll(async () => {
  const info = await pythonInfo(python);
  expect(info.ok, `Route regressions require the Python pipeline. Run npm run python:setup (${JSON.stringify(info.error)})`).toBe(true);
}, 15_000);

beforeEach(() => {
  studio = makeTestStudio({ config: { python } });
  globals[GLOBAL_KEY] = studio;
});

afterEach(() => {
  delete globals[GLOBAL_KEY];
  studio?.cleanup();
  studio = undefined;
});

type Handler<P> = (req: Request, ctx: { params: Promise<P> }) => Promise<Response>;

function call<P>(handler: Handler<P>, params: NoInfer<P>, { method = "GET", body, query = "", headers }: {
  method?: "GET" | "POST";
  body?: unknown;
  query?: string;
  headers?: Record<string, string>;
} = {}) {
  const multipart = body instanceof FormData;
  const req = new Request(`http://127.0.0.1:3000/api/v1${query}`, {
    method,
    headers: {
      host: "127.0.0.1:3000",
      "accept-language": "en",
      ...(body !== undefined && !multipart ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: multipart ? body : JSON.stringify(body),
  });
  return handler(req, { params: Promise.resolve(params) });
}

async function json<T = unknown>(response: Promise<Response> | Response, status = 200): Promise<T> {
  const res = await response;
  const text = await res.text();
  expect(res.status, text.slice(0, 1000)).toBe(status);
  return JSON.parse(text) as T;
}

async function createProject(name: string) {
  const { project } = await json<{ project: ProjectView }>(call(projectsRoute.POST, {}, { method: "POST", body: { name } }), 201);
  return { projectId: project.id };
}

async function createItem(projectId: string, name: string) {
  const { asset } = await json<{ asset: AssetView }>(call(assetsRoute.POST, { projectId }, {
    method: "POST", body: { family: "item", kind: "consumable", name },
  }), 201);
  return { projectId, assetId: asset.id };
}

async function runJob(projectId: string, jobId: string, state: JobView["state"] = "succeeded", adapter?: SimulatedProvider) {
  expect(await studio!.runner("worker-routes", adapter).runOnce()).toBe(true);
  const { job } = await json<{ job: JobView }>(call(jobRoute.GET, { projectId, jobId }));
  expect(job.state, JSON.stringify(job.error)).toBe(state);
  return job;
}

async function uploadFile(projectId: string, name: string, bytes: Uint8Array) {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(bytes)]), name);
  const { upload, job } = await json<{ upload: UploadView; job: JobView }>(call(uploadsRoute.POST, { projectId }, {
    method: "POST", body: form,
  }), 202);
  expect(upload).toMatchObject({ status: "pending", originalName: name, ingestJobId: job.id });
  return { uploadId: upload.id, jobId: job.id };
}

async function readyUpload(projectId: string, name: string, bytes: Uint8Array) {
  const { uploadId, jobId } = await uploadFile(projectId, name, bytes);
  const job = await runJob(projectId, jobId);
  const { upload } = await json<{ upload: UploadView }>(call(uploadRoute.GET, { projectId, uploadId }));
  expect(upload.status).toBe("ready");
  return { upload, job };
}

function review(revision: RevisionView, expectedActiveRevisionId: string | null = null) {
  return call(reviewsRoute.POST, { projectId: revision.projectId, assetId: revision.assetId }, {
    method: "POST", body: { revisionId: revision.id, decision: "approve", expectedActiveRevisionId },
  });
}

async function seedClareira(name: string) {
  const { projectId } = await createProject(name);
  const { packageFiles } = buildClareira();
  const zip = writeZip(packageFiles.map((f) => ({ ...f, compress: false })));
  const { revisionMap } = await importPortablePackage(studio!, projectId, readZip(zip), { approve: true });
  return { projectId, revisionMap };
}

type CatalogEntry = { asset: AssetView; revisions: RevisionView[] };
type JobSubmission = { job: JobView; created: boolean };

function previewIcon(projectId: string, variants: number, brief: string) {
  return json<{ plan: GenerationPlan; digest: string; destination: { profileId: string; simulated: boolean } }>(call(plansRoute.POST, { projectId }, {
    method: "POST",
    body: {
      operation: "generate_asset", providerProfileId: "simulated", brief, language: "en",
      params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants },
    },
  }));
}

function submit(projectId: string, key: string, body: unknown) {
  return call(jobsRoute.POST, { projectId }, { method: "POST", body, headers: { "idempotency-key": key } });
}

async function mediaBytes(projectId: string, fileId: string, query = "") {
  const response = await call(mediaRoute.GET, { projectId, fileId }, { query });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  return new Uint8Array(await response.arrayBuffer());
}

function png(width: number, height: number, paint: (image: RgbaImage) => void) {
  const image = createImage(width, height);
  paint(image);
  return encodePng(image);
}

describe("Studio route integration", { timeout: 30_000 }, () => {
  it("freezes a generation plan, deduplicates submission and fences a stale review", async () => {
    const { projectId } = await createProject("Icon workshop");
    const target = await createItem(projectId, "Mist potion");
    const brief = "A potion in a blue glass bottle";
    const { plan, digest, destination } = await previewIcon(projectId, 2, brief);
    expect(destination).toMatchObject({ profileId: "simulated", simulated: true });
    expect(plan.prompt).toMatchObject({ language: "en", compiled: expect.stringContaining(brief) });
    expect(plan.parts.map((p) => p.partKey)).toEqual(["image:v1", "image:v2"]);
    expect(studio!.simulatedStore.read().charged).toBe(0);
    expect(await json(call(jobsRoute.GET, { projectId }))).toEqual({ jobs: [] });

    const key = "generate-mist";
    const request = { plan, planDigest: digest, targetAssetId: target.assetId };
    const body = { kind: "generation", request };
    const editedPlan = await previewIcon(projectId, 2, "A potion in a yellow glass bottle");
    expect(await json(submit(projectId, key, { ...body, request: { ...request, plan: editedPlan.plan } }), 422)).toMatchObject({
      code: "validation_failed", message: "The plan changed since the preview; recalculate it before submitting",
    });

    const response = await submit(projectId, key, body);
    const { job, created } = await json<JobSubmission>(response, 202);
    expect(created).toBe(true);
    expect(job).toMatchObject({ state: "queued", request });
    expect(response.headers.get("location")).toBe(`/api/v1/projects/${projectId}/jobs/${job.id}`);
    expect(await json(submit(projectId, key, body), 202)).toMatchObject({ created: false, job: { id: job.id } });
    expect(await json(submit(projectId, key, { ...body, request: { ...request, plan: editedPlan.plan, planDigest: editedPlan.digest } }), 409)).toMatchObject({
      code: "idempotency_conflict", jobId: job.id, details: { idempotencyKey: key },
    });
    expect(await json(call(jobsRoute.GET, { projectId }, { query: "?active=true" }))).toEqual({ jobs: [job] });

    const done = await runJob(projectId, job.id);
    expect(done.summary).toMatchObject({ submissions: 2, cost: [{ amount: 2, unit: "generations" }], uncertainParts: 0 });
    expect(done.parts).toMatchObject(["image:v1", "image:v2"].map((partKey) => ({ partKey, remoteState: "completed", rawSaved: true, processed: true })));
    expect(await json(call(jobsRoute.GET, { projectId }, { query: "?active=true" }))).toEqual({ jobs: [] });
    expect(studio!.simulatedStore.read().charged).toBe(2);

    const { revisions } = await json<{ revisions: RevisionView[] }>(call(revisionsRoute.GET, target));
    expect(revisions).toHaveLength(2);
    expect(done.result).toMatchObject({ assetId: target.assetId, revisionIds: expect.arrayContaining(revisions.map((r) => r.id)) });
    expect(revisions.map((r) => r.status)).toEqual(["candidate", "candidate"]);
    const [chosen, alternate] = revisions;
    const icon = chosen!.files.find((f) => f.fileKey === "image")!;
    const bytes = await mediaBytes(projectId, icon.id);
    expect(readPngInfo(bytes)).toMatchObject({ width: 16, height: 16 });
    expect(sha256Hex(bytes)).toBe(icon.sha256);
    expect(await json(review(chosen!))).toMatchObject({ asset: { approvedRevisionId: chosen!.id }, revision: { status: "approved" } });
    expect(await json(review(alternate!), 409)).toMatchObject({
      code: "revision_conflict", message: "The active revision changed since this screen was opened",
      messages: { "pt-BR": "A revisão ativa mudou desde que esta tela foi aberta" },
      details: { currentActiveRevisionId: chosen!.id, expectedActiveRevisionId: null },
    });
    expect(await json(call(assetRoute.GET, target))).toMatchObject({
      asset: { approvedRevisionId: chosen!.id }, revisions: expect.arrayContaining([{ ...alternate!, status: "candidate" }]),
    });
  });

  it("blocks retry after an uncertain submission until the artist accepts a possible charge, and cancels queued work", async () => {
    const { projectId } = await createProject("Recovery workshop");
    const target = await createItem(projectId, "Dawn potion");
    const { plan, digest } = await previewIcon(projectId, 1, "An amber bottle");
    const body = { kind: "generation", request: { plan, planDigest: digest, targetAssetId: target.assetId } };
    const abandoned = await json<JobSubmission>(submit(projectId, "abandoned", body), 202);
    expect(await json(call(cancelRoute.POST, { projectId, jobId: abandoned.job.id }, { method: "POST" }))).toMatchObject({ job: { state: "cancelled", attemptCount: 0 } });
    expect(await studio!.runner().runOnce()).toBe(false);

    const { job } = await json<JobSubmission>(submit(projectId, "retry-me", body), 202);
    const failure = new SimulatedProvider(studio!.simulatedStore, { delayMs: 0, idempotent: false, failAfterAccept: true });
    const pending = await runJob(projectId, job.id, "needs_attention", failure);
    expect(pending).toMatchObject({
      error: { code: "submission_uncertain" },
      actions: { canRetry: true, retryMayCharge: true },
      parts: [{ partKey: "image:v1", remoteState: "uncertain", submitCount: 1 }],
    });
    const params = { projectId, jobId: job.id };
    expect(await json(call(retryRoute.POST, params, { method: "POST", body: {} }), 409)).toMatchObject({
      code: "submission_uncertain", jobId: job.id, details: { parts: ["image:v1"] },
    });
    expect(await json(call(jobRoute.GET, params))).toMatchObject({ job: { state: "needs_attention", attemptCount: 1 } });
    expect(studio!.simulatedStore.read().charged).toBe(1);
    expect(await json(call(retryRoute.POST, params, { method: "POST", body: { acknowledgePossibleCharge: true } }))).toMatchObject({
      job: { state: "queued", parts: [{ partKey: "image:v1", remoteState: "not_sent" }] },
    });
    expect(await runJob(projectId, job.id)).toMatchObject({ attemptCount: 2, summary: { submissions: 2 } });
    expect(studio!.simulatedStore.read().charged).toBe(2);
    const { revisions } = await json<{ revisions: RevisionView[] }>(call(revisionsRoute.GET, target));
    expect(revisions).toHaveLength(1);
  });

  it("serves original and processed pixels, keeps derived lineage and scopes media to its project", async () => {
    const { projectId } = await createProject("Raster workshop");
    const target = await createItem(projectId, "Token");
    const input = png(16, 16, (image) => {
      fillRect(image, 0, 0, 16, 16, [0, 200, 0, 255]);
      fillRect(image, 4, 4, 8, 8, [180, 180, 190, 255]);
    });
    const { upload } = await readyUpload(projectId, "token.png", input);
    expect(await mediaBytes(projectId, upload.id, "?variant=original")).toEqual(input);
    expect(sha256Hex(await mediaBytes(projectId, upload.id))).toBe(upload.normalizedSha256);
    const { revision: source } = await json<{ revision: RevisionView }>(call(revisionsRoute.POST, target, {
      method: "POST", body: { from: "upload", uploadId: upload.id },
    }), 201);

    const { job } = await json<JobSubmission>(submit(projectId, "flood", {
      kind: "local_process",
      request: {
        operation: "remove_background_flood",
        inputs: [{ role: "source", ref: { kind: "revision", revisionId: source.id, fileKey: "image" } }],
        recipe: { version: 1, color: "#00c800", tolerance: 0, seeds: { borders: true, points: [] }, connectivity: 4 },
      },
    }), 202);
    const output = { projectId, jobId: job.id, index: "0" };
    expect(await json(call(outputRoute.GET, output), 404)).toMatchObject({ code: "not_found", message: "Output is only available for a completed local process" });
    expect(await runJob(projectId, job.id)).toMatchObject({ result: { report: { removedPixels: 192 } } });

    const response = await call(outputRoute.GET, output);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const pixels = decodePng(bytes);
    expect(getPixel(pixels, 0, 0)[3]).toBe(0);
    expect(getPixel(pixels, 4, 4)).toEqual([180, 180, 190, 255]);
    const hash = sha256Hex(bytes);
    expect(response.headers.get("etag")).toBe(`"${hash}"`);
    const cached = await call(outputRoute.GET, output, { headers: { "if-none-match": `"${hash}"` } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");

    const { revision } = await json<{ revision: RevisionView }>(call(revisionsRoute.POST, target, {
      method: "POST", body: { from: "job_output", jobId: job.id, outputIndex: 0, baseRevisionId: source.id, fileKey: "image" },
    }), 201);
    expect(revision).toMatchObject({ status: "candidate", predecessorId: source.id, payload: source.payload });
    const [file] = revision.files;
    expect(file).toMatchObject({ fileKey: "image", role: "processed", sha256: hash });
    expect(await mediaBytes(projectId, file!.id)).toEqual(bytes);
    expect(await json(call(assetRoute.GET, target))).toMatchObject({ lineage: { [revision.id]: [{ revisionId: source.id, role: "source", runtime: false }] } });

    const other = await createProject("Unrelated workshop");
    expect(await json(call(mediaRoute.GET, { ...other, fileId: file!.id }), 404)).toMatchObject({ code: "not_found", message: "File not found in this project" });
    expect(await json(call(outputRoute.GET, { ...output, ...other }), 404)).toMatchObject({ code: "not_found" });
  });

  it("saves a localized HUD, checks its font coverage, and downloads and reopens its portable runtime closure", async () => {
    const { projectId, revisionMap } = await seedClareira("HUD workshop");
    const catalog = await json<{ screens: CatalogEntry[] }>(call(uiRoute.GET, { projectId }));
    const original = catalog.screens.flatMap((s) => s.revisions).find((r) => r.id === revisionMap["hud-v1"])!;
    const base = ScreenPayload.parse(original.payload);
    const payload: ScreenPayload = {
      ...base,
      testedResolutions: [[320, 180], [240, 135]],
      instances: base.instances.map((i) => i.instanceId === "potion-icon" ? {
        ...i, anchors: { ...i.anchors, left: 0, right: 0 }, offsets: { ...i.offsets, left: 300, right: 316 },
      } : i),
      textCatalog: { languages: ["pt-BR", "en"], entries: [{ key: "inventory.use", text: { "pt-BR": "Usar", en: "Use ☃" } }] },
    };
    const { revision, checks } = await json<{ revision: RevisionView; checks: unknown }>(call(screensRoute.POST, { projectId }, {
      method: "POST", body: { name: "Responsive HUD", payload, language: "en" },
    }), 201);
    expect(checks).toMatchObject([
      { resolution: [320, 180], offscreen: [] },
      { resolution: [240, 135], offscreen: ["potion-icon"] },
    ]);
    expect(revision).toMatchObject({ status: "candidate", payload: { textCatalog: payload.textCatalog } });
    const snowman = 0x2603;
    expect(await json(call(fontCoverageRoute.POST, { projectId }, {
      method: "POST", body: { fontRevisionId: revisionMap["mini-font-v1"], kit: "basic" },
    }))).toMatchObject({ complete: false, missing: expect.arrayContaining([snowman]), sources: { [snowman]: ["ui:inventory.use"] } });

    const body = { revisionIds: [revision.id], profile: "portable-v1" };
    expect(await json(call(exportsRoute.POST, { projectId }, { method: "POST", body }), 422)).toMatchObject({
      code: "coverage_incomplete",
      details: { problems: [expect.objectContaining({ revisionId: revision.id, code: "not_approved", requiredBy: null })] },
    });
    await json<ReviewResult>(review(revision));
    const exportResponse = await call(exportsRoute.POST, { projectId }, { method: "POST", body });
    const { export: queued, created } = await json<{ export: ExportView; created: boolean }>(exportResponse, 202);
    expect(created).toBe(true);
    expect(queued).toMatchObject({ state: "pending", profile: "portable-v1", revisionIds: [revision.id] });
    expect(exportResponse.headers.get("location")).toBe(`/api/v1/projects/${projectId}/exports/${queued.id}`);
    const params = { projectId, exportId: queued.id };
    expect(await json(call(downloadRoute.GET, params), 404)).toMatchObject({ code: "not_found", message: "Package is not ready yet" });
    await runJob(projectId, queued.jobId!);
    const { export: ready } = await json<{ export: ExportView }>(call(exportRoute.GET, params));
    const dependencies = ["health-bar-v1", "button-metal-v1", "mini-font-v1", "potion-v1"].map((key) => revisionMap[key]);
    expect(ready).toMatchObject({ state: "ready", report: { entries: 5, addedDependencies: expect.arrayContaining(dependencies) } });
    const download = await call(downloadRoute.GET, params);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/zip");
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${ready.fileName}"`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(download.headers.get("content-length")).toBe(String(bytes.length));
    expect(download.headers.get("etag")).toBe(`"${sha256Hex(bytes)}"`);

    const archive = readZip(bytes);
    const result = validateManifest(JSON.parse(new TextDecoder().decode(archive.read("manifest.json"))));
    expect(result.issues).toEqual([]);
    expect(result.manifest!.entries.map((e) => e.revisionId).sort()).toEqual([revision.id, ...dependencies].sort());
    const other = await createProject("Reopened HUD");
    const reopened = await readyUpload(other.projectId, "hud.zip", bytes);
    expect(reopened.upload.metadata).toMatchObject({ package: { projectId, profile: "portable-v1", revisions: 5 } });
    const imported = reopened.job.result as ImportResult;
    expect(imported.revisionMap[revision.id]).not.toBe(revision.id);
    const { screens } = await json<{ screens: CatalogEntry[] }>(call(uiRoute.GET, other));
    expect(screens).toMatchObject([{ asset: { approvedRevisionId: null }, revisions: [{ id: imported.revisionMap[revision.id], status: "candidate" }] }]);
    const restored = ScreenPayload.parse(screens[0]!.revisions[0]!.payload);
    expect(restored.textCatalog).toEqual(payload.textCatalog);
    expect(restored.instances.find((i) => i.instanceId === "use-button")?.componentRevisionId).toBe(imported.revisionMap[revisionMap["button-metal-v1"]!]);
  });

  it("retimes an animation without regenerating frames and returns the existing revision for a no-op", async () => {
    const { projectId, revisionMap } = await seedClareira("Animation workshop");
    const clipRevisionId = revisionMap["warrior-attack-osh-s-v1"]!;
    const { clips } = await json<{ clips: CatalogEntry[] }>(call(animationRoute.GET, { projectId }));
    const original = clips.flatMap((c) => c.revisions).find((r) => r.id === clipRevisionId)!;
    const clip = ClipPayload.parse(original.payload);
    const post = (durationsMs: number[]) => call(retimeRoute.POST, { projectId }, {
      method: "POST", body: { clipRevisionId, durationsMs, playback: "once" },
    });
    expect(await json(post([110]), 422)).toMatchObject({ code: "validation_failed", message: "Expected 4 durations, got 1" });
    const durationsMs = [110, 90, 110, 220];
    const { revision, unchanged } = await json<{ revision: RevisionView; unchanged: boolean }>(post(durationsMs), 201);
    expect(unchanged).toBe(false);
    expect(revision).toMatchObject({ status: "candidate", predecessorId: clipRevisionId, technicalReport: { providerCalls: 0 } });
    expect(revision.files.map((f) => [f.fileKey, f.sha256])).toEqual(original.files.map((f) => [f.fileKey, f.sha256]));
    const next = ClipPayload.parse(revision.payload);
    expect(next.frames.map((f) => f.durationMs)).toEqual(durationsMs);
    expect(next.frames.map(({ frameId, layers, sockets }) => ({ frameId, layers, sockets }))).toEqual(clip.frames.map(({ frameId, layers, sockets }) => ({ frameId, layers, sockets })));
    expect(next.events).toEqual(clip.events);
    expect(await json(post(clip.frames.map((f) => f.durationMs)))).toMatchObject({ unchanged: true, revision: { id: clipRevisionId } });
    expect(await json(call(revisionsRoute.GET, { projectId, assetId: original.assetId }))).toMatchObject({
      revisions: [{ id: revision.id, status: "candidate" }, { id: original.id, status: "approved" }],
    });
    expect(await json(call(jobsRoute.GET, { projectId }))).toEqual({ jobs: [] });
  });

  it("requires approved parallax layers and publishes the camera-tested composite bytes", async () => {
    const { projectId } = await createProject("Scene workshop");
    const sky = [40, 90, 155, 255] as const;
    const grass = [36, 125, 53, 255] as const;
    const skyPng = png(32, 32, (image) => fillRect(image, 0, 0, 32, 32, sky));
    const grassPng = png(32, 32, (image) => fillRect(image, 0, 24, 32, 8, grass));
    const publishLayer = async (name: string, depth: "sky" | "ground", bytes: Uint8Array) => {
      const { upload } = await readyUpload(projectId, `${depth}.png`, bytes);
      const { revision } = await json<{ revision: RevisionView }>(call(sceneLayersRoute.POST, { projectId }, {
        method: "POST", body: { target: { name }, layer: { depth, image: { from: "upload", uploadId: upload.id }, repeatX: true } },
      }), 201);
      return revision;
    };
    const back = await publishLayer("Sky", "sky", skyPng);
    const front = await publishLayer("Ground", "ground", grassPng);
    await json(review(back));
    const scene = {
      logicalSize: [32, 32], groundLineY: 24, steps: 2,
      layers: [
        { layerId: "sky", name: "Sky", layerRevisionId: back.id, parallax: { x: 0.5, y: 0 } },
        { layerId: "ground", name: "Ground", layerRevisionId: front.id, parallax: { x: 1, y: 0 } },
      ],
    };
    const preview = () => call(scenePreviewRoute.POST, { projectId }, { method: "POST", body: scene });
    expect(await json(preview(), 422)).toMatchObject({ code: "source_not_approved", message: expect.stringContaining("Approve plane Ground r1 before composing") });
    await json(review(front));
    const { cameraTest, previews } = await json<{ cameraTest: unknown; previews: { image: string } }>(preview());
    expect(cameraTest).toMatchObject({ spanPx: 128, uncoveredFrames: 0, loopPassed: true, groundContinuous: true });

    const { revision } = await json<{ revision: RevisionView }>(call(sceneComposeRoute.POST, { projectId }, {
      method: "POST", body: { target: { name: "Side-scrolling meadow" }, scene },
    }), 201);
    const composed = ScenePayload.parse(revision.payload);
    expect(composed).toMatchObject({ outputKind: "layers", logicalSize: [32, 32], cameraTest, layers: scene.layers });
    const file = revision.files.find((f) => f.fileKey === composed.image.fileId)!;
    const bytes = await mediaBytes(projectId, file.id);
    expect(previews.image).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    const image = decodePng(bytes);
    expect(getPixel(image, 15, 5)).toEqual(sky);
    expect(getPixel(image, 15, 28)).toEqual(grass);
  });
});
