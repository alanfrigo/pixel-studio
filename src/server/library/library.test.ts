import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BasePayload, ClipPayload } from "@/contracts";
import { frameDigest } from "@/domain/animation/temporal";
import { buildClareira } from "@/fixtures/clareira";
import { createImage, encodePng, fillRect, type Rgba } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { createObjectFromImage } from "../animation/temporal-service";
import { createProject, getAsset, getRevision, getUpload, listRevisions, reviewRevision, type RevisionView } from "../catalog/catalog";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { importPortablePackage } from "../export/import";
import { ingestUpload } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { assetsWithTag, assetTags, duplicateAsset, listTags, mirrorExplicit, removeParts, resizeCanvas, setAssetTags, ungroupDirections } from "./library";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function runAll() {
  while (await studio.runner().runOnce()) {
    /* esvazia a fila */
  }
}

function approve(projectId: string, revisionId: string) {
  const rev = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, rev.assetId);
  return reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: null, expectedActiveRevisionId: asset.approvedRevisionId });
}

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Biblioteca" });
  const fixture = buildClareira();
  const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
  const { revisionMap } = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
  return { project, revisionMap };
}

/** Objeto simétrico com três vistas (S, E, N) desenhadas à mão, aprovado. */
async function crate(projectId: string) {
  const views: Record<string, Rgba> = { S: [140, 90, 40, 255], E: [120, 80, 40, 255], N: [100, 70, 40, 255] };
  const ids: Record<string, string> = {};
  for (const [d, color] of Object.entries(views)) {
    const img = createImage(32, 32);
    fillRect(img, 9, 12, 14, 18, [30, 30, 36, 255]);
    fillRect(img, 10, 13, 12, 16, color);
    const { upload } = await ingestUpload(studio, projectId, { name: `caixa-${d}.png`, bytes: encodePng(img) });
    await studio.runner().runOnce();
    expect(getUpload(studio.db, projectId, upload.id).status).toBe("ready");
    ids[d] = upload.id;
  }
  const { revision } = await createObjectFromImage(studio, projectId, { name: "Caixa", image: { from: "upload", uploadId: ids.S! }, direction: "S" });
  // Monta as três vistas na mesma revisão (como o fluxo de vistas faria), reaproveitando os blobs.
  const sha = (uploadId: string) => getUpload(studio.db, projectId, uploadId).normalizedSha256!;
  const { publishRevision, getBlob } = await import("../catalog/catalog");
  const payload = revision.payload as BasePayload;
  const full = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: revision.assetId,
    origin: "composition",
    styleRevisionId: null,
    payload: { ...payload, views: (["N", "E", "S"] as const).map((d) => ({ direction: d, fileId: `view-${d.toLowerCase()}`, rect: [0, 0, 32, 32] as [number, number, number, number], sourceOffset: [0, 0] as [number, number] })) },
    files: (["N", "E", "S"] as const).map((d, i) => ({ fileKey: `view-${d.toLowerCase()}`, role: "view", idx: i, blob: getBlob(studio.db, sha(ids[d]!))! })),
  });
  approve(projectId, full.id);
  return getRevision(studio.db, projectId, full.id);
}

async function exportZip(projectId: string, revisionIds: string[], key?: string) {
  const { export: requested } = requestExport(studio, projectId, { revisionIds, profile: "portable-v1" }, key);
  await runAll();
  const ready = getExport(studio.db, projectId, requested.id);
  expect(ready.state).toBe("ready");
  return new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
}

function consumer(zip: Uint8Array) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "s3-lib-"));
  tmpDirs.push(dir);
  writeFileSync(path.join(dir, "p.zip"), zip);
  const out = spawnSync(PYTHON, [READER, path.join(dir, "p.zip"), path.join(dir, "out")], { encoding: "utf8" });
  expect(out.status, out.stderr).toBe(0);
  return { summary: JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8")) as { entries: Record<string, unknown>[] }, dir: path.join(dir, "out") };
}

function manifestOf(zip: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json"))) as { files: { fileId: string; sha256: string }[]; entries: { revisionId: string; payload: unknown }[] };
}

function digests(revision: RevisionView) {
  const clip = revision.payload as ClipPayload;
  const sha = (fileId: string) => revision.files.find((f) => f.fileKey === fileId)!.sha256;
  return clip.frames.map((f) => frameDigest(f, sha));
}

describe.skipIf(!existsSync(PYTHON))("biblioteca (cartão S3)", { timeout: 30_000 }, () => {
  it("etiquetar nunca cria revisão nem muda o pacote", async () => {
    const { project, revisionMap } = await setup();
    const clipId = revisionMap["warrior-attack-osh-s-v1"]!;
    const asset = getRevision(studio.db, project.id, clipId).assetId;
    const before = await exportZip(project.id, [clipId]);
    setAssetTags(studio, project.id, { assetId: asset, tags: ["Ataque", "guerreiro", "ataque"] });
    expect(assetTags(studio, project.id, asset)).toEqual(["ataque", "guerreiro"]);
    expect(listTags(studio, project.id)).toEqual([{ tag: "ataque", assets: 1 }, { tag: "guerreiro", assets: 1 }]);
    expect(assetsWithTag(studio, project.id, "ATAQUE")).toEqual([asset]);
    expect(listRevisions(studio.db, project.id, asset)).toHaveLength(1);
    const after = await exportZip(project.id, [clipId], "export:depois-das-etiquetas");
    expect(manifestOf(after)).toEqual(manifestOf(before));
  });

  it("pacote exportado antes continua resolvendo os mesmos hashes depois de duplicar e de remover uma direção", async () => {
    const { project } = await setup();
    const box = await crate(project.id);
    const zip = await exportZip(project.id, [box.id]);
    const before = consumer(zip);

    const copy = duplicateAsset(studio, project.id, { revisionId: box.id });
    expect(copy.revision.files.map((f) => f.sha256).sort()).toEqual(box.files.map((f) => f.sha256).sort());
    expect(copy.revision.status).toBe("candidate");
    const removed = removeParts(studio, project.id, { revisionId: box.id, directions: ["E"] });
    expect((removed.revision.payload as BasePayload).views.map((v) => v.direction)).toEqual(["N", "S"]);
    expect(removed.revision.predecessorId).toBe(box.id);
    approve(project.id, removed.revision.id);

    // A revisão antiga segue igual (payload, arquivos) e aprovada; o ZIP antigo continua válido no leitor.
    const old = getRevision(studio.db, project.id, box.id);
    expect(old.payloadDigest).toBe(box.payloadDigest);
    expect(old.files.map((f) => [f.fileKey, f.sha256])).toEqual(box.files.map((f) => [f.fileKey, f.sha256]));
    const again = consumer(zip);
    expect(again.summary).toEqual(before.summary);
    // Reexportar a MESMA revisão depois das operações reproduz manifesto e hashes.
    const rebuilt = await exportZip(project.id, [box.id], "export:reexportar-revisao-antiga");
    expect(manifestOf(rebuilt)).toEqual(manifestOf(zip));
    const newer = await exportZip(project.id, [removed.revision.id]);
    expect((manifestOf(newer).entries[0]!.payload as BasePayload).views.map((v) => v.direction)).toEqual(["N", "S"]);
  });

  it("separar direções cria um asset por direção com os mesmos blobs", async () => {
    const { project } = await setup();
    const box = await crate(project.id);
    const { created } = ungroupDirections(studio, project.id, { revisionId: box.id });
    expect(created.map((c) => c.asset.name)).toEqual(["Caixa · N", "Caixa · E", "Caixa · S"]);
    for (const c of created) {
      const view = (c.revision.payload as BasePayload).views;
      expect(view).toHaveLength(1);
      expect(c.revision.files[0]!.sha256).toBe(box.files.find((f) => f.fileKey === view[0]!.fileId)!.sha256);
    }
    // A origem não ganha revisão nova (continua com a criação e a composição das três vistas).
    expect(listRevisions(studio.db, project.id, box.assetId)).toHaveLength(2);
  });

  it("excluir quadro com evento exige remapeamento explícito; excluir parte publica revisão nova", async () => {
    const { project, revisionMap } = await setup();
    const clip = getRevision(studio.db, project.id, revisionMap["warrior-attack-osh-s-v1"]!);
    expect(() => removeParts(studio, project.id, { revisionId: clip.id, frameIds: ["contact"] })).toThrow(/remapeie/);
    const remapped = removeParts(studio, project.id, { revisionId: clip.id, frameIds: ["contact"], eventRemap: { impact: "advance" } });
    const payload = remapped.revision.payload as ClipPayload;
    expect(payload.frames.map((f) => f.frameId)).toEqual(["windup", "advance", "recover"]);
    expect(payload.events[0]).toMatchObject({ eventId: "impact", frameId: "advance" });
    expect((remapped.revision.technicalReport as { affected: { overlays: unknown[] } }).affected.overlays.length).toBeGreaterThan(0);
    const dropped = removeParts(studio, project.id, { revisionId: clip.id, frameIds: ["contact"], eventRemap: { impact: null } });
    expect((dropped.revision.payload as ClipPayload).events).toEqual([]);
    expect(() => removeParts(studio, project.id, { revisionId: clip.id, partId: "body" })).toThrow(/ficaria sem camadas/);
    expect(getRevision(studio.db, project.id, clip.id).payloadDigest).toBe(clip.payloadDigest);
  });

  it("espelho explícito: simétrico deriva e registra; assimétrico bloqueia sem confirmação; nunca conta como geração", async () => {
    const { project, revisionMap } = await setup();
    const box = await crate(project.id);
    const mirrored = await mirrorExplicit(studio, project.id, { revisionId: box.id, source: "E" });
    const payload = mirrored.revision.payload as BasePayload;
    expect(payload.views.map((v) => v.direction)).toEqual(["N", "E", "S", "W"]);
    expect(mirrored.revision.technicalReport).toMatchObject({ operation: "mirror", mirrored: true, generated: false, providerCalls: 0, from: "E", to: "W", asymmetric: false });
    expect(mirrored.revision.origin).toBe("local_process");
    await expect(mirrorExplicit(studio, project.id, { revisionId: box.id, source: "S" })).rejects.toThrow(/encara a câmera/);
    await expect(mirrorExplicit(studio, project.id, { revisionId: mirrored.revision.id, source: "E" })).rejects.toThrow(/já existe/);

    // Guerreiro com escudo: a vista frontal difere do próprio espelho → exige confirmação.
    const clip = getRevision(studio.db, project.id, revisionMap["warrior-attack-osh-s-v1"]!);
    const warrior = revisionMap["warrior-base-v1"]!;
    const { publishRevision } = await import("../catalog/catalog");
    const clipE = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: clip.assetId,
      origin: "edit",
      styleRevisionId: clip.styleRevisionId,
      payload: { ...(clip.payload as ClipPayload), direction: "E" },
      files: clip.files.map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: { sha256: f.sha256, bytes: f.bytes, mime: f.mime, modality: "raster" as const, metadata: f.metadata } })),
      technicalReport: { baseRevisionId: warrior },
    });
    await expect(mirrorExplicit(studio, project.id, { revisionId: clipE.id })).rejects.toThrow(/assimétrica/);
    const confirmed = await mirrorExplicit(studio, project.id, { revisionId: clipE.id, confirmAsymmetric: { reason: "prova de espelho autorizada pelo artista" } });
    const mp = confirmed.revision.payload as ClipPayload;
    const cp = clipE.payload as ClipPayload;
    expect(mp.direction).toBe("W");
    expect(mp.pivot).toEqual([64 - cp.pivot[0], cp.pivot[1]]);
    // Socket: índice W − 1 − x e lados anatômicos trocados pelo rig (mão direita ↔ esquerda).
    const right = cp.frames[0]!.sockets.find((s) => s.socketId === "hand_right")!;
    expect(mp.frames[0]!.sockets.find((s) => s.at[0] === 63 - right.at[0] && s.at[1] === right.at[1])).toBeDefined();
    expect(confirmed.revision.technicalReport).toMatchObject({ mirrored: true, asymmetric: true, providerCalls: 0, confirmedAsymmetric: { reason: "prova de espelho autorizada pelo artista" } });
    expect(studio.simulatedStore.read().submissions).toBe(0);
  });

  it("canvas: ampliar desloca camadas, sockets e pivô pela mesma margem sem gerar pixels; reduzir não corta pixel visível", async () => {
    const { project, revisionMap } = await setup();
    const clip = getRevision(studio.db, project.id, revisionMap["warrior-attack-osh-s-v1"]!);
    const cp = clip.payload as ClipPayload;
    const grown = await resizeCanvas(studio, project.id, { revisionId: clip.id, margins: { left: 8, right: 8, top: 4, bottom: 0 } });
    const gp = grown.revision.payload as ClipPayload;
    expect(gp.logicalSize).toEqual([80, 68]);
    expect(gp.pivot).toEqual([cp.pivot[0] + 8, cp.pivot[1] + 4]);
    expect(gp.margins).toEqual({ left: 8, right: 8, top: 4, bottom: 0 });
    expect(gp.frames[0]!.layers[0]!.offset).toEqual([8, 4]);
    expect(gp.frames[2]!.sockets[0]!.at).toEqual([cp.frames[2]!.sockets[0]!.at[0] + 8, cp.frames[2]!.sockets[0]!.at[1] + 4]);
    expect(gp.events).toEqual(cp.events);
    expect(grown.revision.files.map((f) => f.sha256).sort()).toEqual(clip.files.filter((f) => f.role !== "raw").map((f) => f.sha256).sort());
    expect(grown.revision.technicalReport).toMatchObject({ operation: "canvas", shift: [8, 4], coverageShift: [8, 4], generated: false });
    approve(project.id, grown.revision.id);
    // O leitor independente compõe os quadros na célula nova com os mesmos pixels deslocados.
    const { summary, dir } = consumer(await exportZip(project.id, [grown.revision.id]));
    const entry = summary.entries.find((e) => e.revisionId === grown.revision.id) as { logicalSize: number[]; pivot: number[]; frames: { file: string }[] };
    expect(entry).toMatchObject({ logicalSize: [80, 68], pivot: gp.pivot });
    const bbox = spawnSync(PYTHON, ["-I", "-c", `from PIL import Image\nprint(list(Image.open('${path.join(dir, entry.frames[0]!.file)}').getchannel('A').getbbox()))`], { encoding: "utf8" }).stdout.trim();
    const [x0, y0] = JSON.parse(bbox) as number[];
    expect(x0).toBeGreaterThanOrEqual(8);
    expect(y0).toBeGreaterThanOrEqual(4);

    // Reduzir de volta: o conteúdo cabe, retângulos recortados geometricamente, mesmos arquivos.
    const shrunk = await resizeCanvas(studio, project.id, { revisionId: grown.revision.id, margins: { left: -8, right: -8, top: -4, bottom: 0 } });
    expect((shrunk.revision.payload as ClipPayload).logicalSize).toEqual([64, 64]);
    expect(digests(shrunk.revision)).toEqual(digests(clip));
    // Reduzir além do conteúdo (ou da célula do rig) falha sem publicar.
    await expect(resizeCanvas(studio, project.id, { revisionId: clip.id, margins: { left: -20, right: 0, top: 0, bottom: 0 } })).rejects.toThrow(/margens|visíveis/);
  });

  it("canvas de objeto: mesmos pixels numa tela maior, apoio no chão deslocado", async () => {
    const { project } = await setup();
    const box = await crate(project.id);
    const grown = await resizeCanvas(studio, project.id, { revisionId: box.id, margins: { left: 4, right: 4, top: 8, bottom: 0 } });
    const gp = grown.revision.payload as BasePayload;
    expect(gp.logicalSize).toEqual([40, 40]);
    expect(gp.groundOrigin).toEqual([(box.payload as BasePayload).groundOrigin[0] + 4, (box.payload as BasePayload).groundOrigin[1] + 8]);
    expect(grown.revision.files.every((f) => (f.metadata as { width: number }).width === 40)).toBe(true);
    await expect(resizeCanvas(studio, project.id, { revisionId: box.id, margins: { left: -12, right: 0, top: 0, bottom: 0 } })).rejects.toThrow(/recortaria/);
  });
});
