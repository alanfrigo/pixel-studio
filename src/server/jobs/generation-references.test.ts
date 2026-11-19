import { existsSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { GenerationPlan } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { createImage, encodePng, fillRect, type Rgba } from "@/lib/media/png";
import { encodeWavPcm16 } from "@/lib/media/wav";
import { getUpload, insertUpload, markUploadReady, publishRevision, reviewRevision } from "../catalog/catalog";
import { buildGenerationPlan, ingestUpload, type PlanInput, submitJob } from "../services";
import { makeTestStudio, seedIconJob, type TestStudio } from "../testing";

const hasPython = existsSync(`${process.cwd()}/python/.venv/bin/python`);
const input = {
  operation: "generate_asset",
  providerProfileId: "simulated",
  brief: "An amber potion bottle",
  language: "en",
  params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 },
} satisfies PlanInput;

let studio: TestStudio;
afterEach(() => studio.cleanup());

function referencePng(color: Rgba) {
  const image = createImage(256, 256);
  fillRect(image, 32, 32, 192, 192, color);
  return encodePng(image);
}

function referenceAdapter() {
  const adapter = studio.simulated;
  const capabilities = adapter.capabilities.bind(adapter);
  vi.spyOn(adapter, "capabilities").mockImplementation((operation) => {
    const declared = capabilities(operation);
    return operation === "generate_asset" ? [...declared, "image_references"] : declared;
  });
  return adapter;
}

it.skipIf(!hasPython)("referências mistas preservam a ordem, os bytes normalizados e a proveniência", async () => {
  studio = makeTestStudio();
  const adapter = referenceAdapter();
  const app = { ...studio, providers: studio.depsFor(adapter).providers };
  const { project, asset } = seedIconJob(studio);
  const { project: other, asset: otherAsset, plan: otherPlan } = seedIconJob(studio);
  const original = referencePng([190, 60, 20, 255]);
  const { upload, job: ingest } = await ingestUpload(studio, project.id, { name: "amber.png", bytes: original });
  const uploadRef = { uploadId: upload.id, role: "palette", instruction: "Use only the amber tones" } as const;
  expect(() => buildGenerationPlan(app, project.id, { ...input, references: [uploadRef] })).toThrow(/imagem normalizada pronta/);
  await studio.runner().runOnce();
  expect(studio.queue.get(ingest.id)?.state).toBe("succeeded");
  const ready = getUpload(studio.db, project.id, upload.id);
  expect(ready.status).toBe("ready");
  expect(ready.normalizedSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(ready.normalizedSha256).not.toBe(ready.sha256);
  expect(() => buildGenerationPlan(app, other.id, { ...input, references: [uploadRef] })).toThrow(/Upload não encontrado neste projeto/);

  const { upload: audio } = await ingestUpload(studio, project.id, { name: "chime.wav", bytes: encodeWavPcm16(new Int16Array(800), 8000, 1) });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, project.id, audio.id)).toMatchObject({ status: "ready", modality: "audio" });
  expect(() => buildGenerationPlan(app, project.id, { ...input, references: [{ uploadId: audio.id, role: "palette" }] })).toThrow(/imagem normalizada pronta/);

  const approvedBytes = referencePng([40, 90, 155, 255]);
  const approvedBlob = await studio.blobs.putBytes(approvedBytes);
  const candidate = publishRevision(studio.db, studio.clock, {
    projectId: project.id,
    assetId: asset.id,
    origin: "import",
    styleRevisionId: project.activeStyleRevisionId,
    payload: { itemKey: "potion", representations: [{ role: "icon", state: "default", fileId: "image", rect: [0, 0, 256, 256], sourceOffset: [0, 0], logicalSize: [256, 256], pivot: [128, 128] }] },
    files: [{ fileKey: "image", role: "normalized", idx: 0, blob: { ...approvedBlob, modality: "raster", mime: "image/png", metadata: { width: 256, height: 256 } } }],
  });
  const revisionRef = { revisionId: candidate.id, fileKey: "image", role: "identity" } as const;
  expect(() => buildGenerationPlan(app, project.id, { ...input, references: [revisionRef] })).toThrow(/ainda não foi aprovada/);
  reviewRevision(studio.db, studio.clock, { projectId: project.id, assetId: asset.id, revisionId: candidate.id, decision: "approve", reason: null, expectedActiveRevisionId: null });

  const { plan, digest } = buildGenerationPlan(app, project.id, { ...input, references: [uploadRef, revisionRef] });
  expect(plan.sources).toEqual([
    { ordinal: 0, uploadId: upload.id, sha256: ready.normalizedSha256, role: "palette" },
    { ordinal: 1, revisionId: candidate.id, fileId: "image", sha256: approvedBlob.sha256, role: "identity" },
  ]);
  expect(plan.prompt.compiled).toMatch(/Image 1: palette — Use only the amber tones.*Image 2: identity/);

  const foreign = GenerationPlan.parse({ ...otherPlan, requiredCapabilities: [...otherPlan.requiredCapabilities, "image_references"], sources: [plan.sources[0]] });
  expect(() => submitJob(app, other.id, { kind: "generation", request: { plan: foreign, planDigest: canonicalDigest(foreign), targetAssetId: otherAsset.id } }, "foreign-ref")).toThrow(/Upload não encontrado neste projeto/);

  const submit = vi.spyOn(adapter, "submit");
  const { job } = submitJob(app, project.id, { kind: "generation", request: { plan, planDigest: digest, targetAssetId: asset.id } }, "mixed-refs");
  await studio.runner("reference-worker", adapter).runOnce();
  expect(studio.queue.get(job.id)?.state).toBe("succeeded");
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]?.[0].references).toEqual([
    { role: "palette", mime: "image/png", bytes: await studio.blobs.read(ready.normalizedSha256!) },
    { role: "identity", mime: "image/png", bytes: approvedBytes },
  ]);
  expect(studio.db.all(`SELECT i.ordinal, i.revision_id, i.upload_id, i.file_key, i.sha256, i.role
    FROM run_inputs i JOIN generation_runs r ON r.id = i.run_id WHERE r.job_id = :job ORDER BY i.ordinal`, { job: job.id })).toEqual([
    { ordinal: 0, revision_id: null, upload_id: upload.id, file_key: null, sha256: ready.normalizedSha256, role: "palette" },
    { ordinal: 1, revision_id: candidate.id, upload_id: null, file_key: "image", sha256: approvedBlob.sha256, role: "identity" },
  ]);
  expect(studio.db.get("SELECT count(*) AS count FROM assets WHERE project_id = :p", { p: project.id })).toEqual({ count: 1 });
});

it("valida digest da referência e reaplica o limite do provedor no envio e no worker", async () => {
  studio = makeTestStudio();
  let maxReferences = 1;
  const adapter = Object.assign(referenceAdapter(), { limits: () => ({ maxReferences }) });
  const app = { ...studio, providers: studio.depsFor(adapter).providers };
  const { project, asset } = seedIconJob(studio);
  const stored = await studio.blobs.putBytes(referencePng([255, 0, 0, 255]));
  const blob = { ...stored, mime: "image/png", modality: "raster" as const, metadata: { width: 256, height: 256 } };
  const upload = insertUpload(studio.db, studio.clock, { projectId: project.id, originalName: "red.png", blob, expiresAt: null });
  const withReference = { ...input, references: [{ uploadId: upload.id, role: "palette" as const }] };
  markUploadReady(studio.db, studio.clock, upload.id, null, blob.metadata);
  expect(() => buildGenerationPlan(app, project.id, withReference)).toThrow(/imagem normalizada pronta/);
  markUploadReady(studio.db, studio.clock, upload.id, blob, blob.metadata);

  maxReferences = 0;
  expect(() => buildGenerationPlan(app, project.id, withReference)).toThrow(/até 0 referência/);

  maxReferences = 1;
  const { plan, digest } = buildGenerationPlan(app, project.id, withReference);
  expect(GenerationPlan.safeParse({ ...plan, requiredCapabilities: ["text_to_image"] }).success).toBe(false);
  const altered = { ...plan, sources: [{ ...plan.sources[0]!, sha256: "f".repeat(64) }] };
  const request = { plan, planDigest: digest, targetAssetId: asset.id };
  expect(() => submitJob(app, project.id, { kind: "generation", request: { ...request, plan: altered, planDigest: canonicalDigest(altered) } }, "altered-ref")).toThrow(/hash congelado da referência/i);

  maxReferences = 0;
  expect(() => submitJob(app, project.id, { kind: "generation", request }, "limited-ref")).toThrow(/até 0 referência/);
  maxReferences = 1;
  const { job } = submitJob(app, project.id, { kind: "generation", request }, "limited-ref");
  maxReferences = 0;
  await studio.runner("reconfigured-worker", adapter).runOnce();
  const result = studio.queue.get(job.id)!;
  expect(result.state).toBe("failed");
  expect(JSON.parse(result.error_json!)).toMatchObject({ code: "capability_missing", details: { maxReferences: 0, requested: 1 } });
  expect(studio.simulatedStore.read().submissions).toBe(0);
});
