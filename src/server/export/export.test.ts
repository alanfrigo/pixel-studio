import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "@/domain/manifest/validate";
import { sha256Hex } from "@/domain/manifest/verify-files";
import { buildClareira } from "@/fixtures/clareira";
import { readZip, writeZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, listRevisions, publishRevision } from "../catalog/catalog";
import { getUpload } from "../catalog/catalog";
import { ingestUpload } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { exportFilePath, getExport, requestExport } from "./exports";
import { importPortablePackage } from "./import";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");
const READER = path.join(process.cwd(), "consumers", "portable_reader", "read_portable.py");

let studio: TestStudio;
const tmpDirs: string[] = [];
afterEach(() => {
  studio?.cleanup();
  tmpDirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** Reabre a fixture da clareira num projeto novo, com as revisões aprovadas. */
async function seedClareira() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Clareira" });
  const fixture = buildClareira();
  const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
  const imported = await importPortablePackage(studio, project.id, readZip(zip), { approve: true });
  return { project, map: imported.revisionMap, fixture };
}

async function exportAndRun(projectId: string, revisionIds: string[]) {
  const { export: requested } = requestExport(studio, projectId, { revisionIds, profile: "portable-v1" });
  expect(await studio.runner().runOnce()).toBe(true);
  const ready = getExport(studio.db, projectId, requested.id);
  return { ready, zip: new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready))) };
}

describe("exportação portátil", () => {
  it("reabre a fixture com 14 revisões aprovadas e dependências como arestas", async () => {
    const { project, map } = await seedClareira();
    expect(Object.keys(map)).toHaveLength(14);
    const loadout = getAsset(studio.db, project.id, getAssetIdOf(map["warrior-loadout-osh-v1"]!));
    expect(loadout.approvedRevisionId).toBe(map["warrior-loadout-osh-v1"]);
    expect(listRevisions(studio.db, project.id, loadout.id)[0]?.origin).toBe("import");
  });

  it("exporta o fecho runtime da seleção, valida, e o pacote abre fora do Studio", async () => {
    const { project, map } = await seedClareira();
    const selected = [map["warrior-loadout-osh-v1"]!, map["hud-v1"]!, map["grass-water-v1"]!];
    const { ready, zip } = await exportAndRun(project.id, selected);

    expect(ready.state).toBe("ready");
    expect(ready.zipSha256).toBe(sha256Hex(zip));
    // Fecho: conjunto → rig, cota, clipe → faísca e som; HUD → barra, botão → fonte, poção. Movimento e base são editoriais.
    expect(ready.report?.entries).toBe(12);
    expect(ready.report?.addedDependencies).toHaveLength(9);
    expect(ready.report?.limitations.length).toBeGreaterThan(0);

    const archive = readZip(zip);
    expect(archive.paths[0]).toBe("manifest.json");
    const manifest = JSON.parse(new TextDecoder().decode(archive.read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    const json = JSON.stringify(manifest);
    for (const secret of ["raw", "prompt", "brief", studio.config.paths.dataDir]) expect(json).not.toContain(`"${secret}"`);
    expect(manifest.entries.map((e: { revisionId: string }) => e.revisionId)).not.toContain(map["warrior-attack-motion-v1"]);

    if (!existsSync(PYTHON)) return;
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-consumer-"));
    tmpDirs.push(dir);
    const zipPath = path.join(dir, "pacote.zip");
    writeFileSync(zipPath, zip);
    const run = spawnSync(PYTHON, [READER, zipPath, path.join(dir, "out")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const loadout = summary.entries.find((e: { kind: string }) => e.kind === "loadout");
    expect(loadout.clips[0].frames.map((f: { durationMs: number }) => f.durationMs)).toEqual([140, 80, 60, 160]);
    expect(loadout.clips[0].frames[2].layers).toEqual(["body", "torso"]);
    expect(loadout.clips[0].pivot).toEqual([32, 60]);
  });

  it("a mesma seleção devolve a mesma exportação", async () => {
    const { project, map } = await seedClareira();
    const first = requestExport(studio, project.id, { revisionIds: [map["potion-v1"]!], profile: "portable-v1" });
    const again = requestExport(studio, project.id, { revisionIds: [map["potion-v1"]!, map["potion-v1"]!], profile: "portable-v1" });
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.export.id).toBe(first.export.id);
  });

  it("recusa seleção com revisão não aprovada, apontando qual e por quê", async () => {
    const { project } = await seedClareira();
    const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Poção azul" });
    const candidate = publishRevision(studio.db, studio.clock, {
      projectId: project.id,
      assetId: asset.id,
      payload: {
        itemKey: "potion_blue",
        representations: [{ role: "icon", state: "default", fileId: "image", rect: [0, 0, 16, 16], sourceOffset: [0, 0], logicalSize: [16, 16], pivot: [8, 8] }],
      },
      origin: "import",
      styleRevisionId: null,
      files: [{ fileKey: "image", role: "normalized", idx: 0, blob: { sha256: "c".repeat(64), bytes: 10, mime: "image/png", modality: "raster", metadata: { width: 16, height: 16 } } }],
    });
    let error: unknown;
    try {
      requestExport(studio, project.id, { revisionIds: [candidate.id], profile: "portable-v1" });
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: "coverage_incomplete", status: 422 });
    expect((error as { details: { problems: { message: string }[] } }).details.problems[0]!.message).toMatch(/Poção azul r1 está aguardando revisão/);
  });

  it("reabre o pacote exportado em outro projeto com os mesmos bytes", async () => {
    const { project, map } = await seedClareira();
    const { zip } = await exportAndRun(project.id, [map["warrior-loadout-osh-v1"]!]);
    const other = createProject(studio.db, studio.clock, { name: "Cópia" });
    const reopened = await importPortablePackage(studio, other.id, readZip(zip));
    const original = readZip(zip);
    const manifest = JSON.parse(new TextDecoder().decode(original.read("manifest.json")));
    expect(Object.keys(reopened.revisionMap)).toHaveLength(manifest.entries.length);
    const blobs = new Set(studio.db.all<{ sha: string }>("SELECT blob_sha256 AS sha FROM revision_files WHERE project_id = :p", { p: other.id }).map((r) => r.sha));
    for (const f of manifest.files) expect(blobs.has(f.sha256)).toBe(true);
  });
});

describe("reabrir pacote pelo upload", () => {
  it("ZIP exportado vira revisões candidatas; pacote adulterado é recusado sem gravar nada", async () => {
    const { project, map } = await seedClareira();
    const { zip } = await exportAndRun(project.id, [map["potion-v1"]!, map["spark-v1"]!]);
    const other = createProject(studio.db, studio.clock, { name: "Reaberto" });

    const ok = await ingestUpload(studio, other.id, { name: "pacote.zip", bytes: zip });
    expect(ok.upload.modality).toBe("data");
    await studio.runner().runOnce();
    const ready = getUpload(studio.db, other.id, ok.upload.id);
    expect(ready.status).toBe("ready");
    expect(ready.metadata?.package).toMatchObject({ revisions: 2, assets: 2 });
    const statuses = studio.db.all<{ status: string }>("SELECT status FROM asset_revisions WHERE project_id = :p", { p: other.id });
    expect(statuses.map((r) => r.status)).toEqual(["candidate", "candidate"]);

    const archive = readZip(zip);
    const tampered = writeZip(
      archive.paths.map((p) => {
        const bytes = archive.read(p);
        if (p.endsWith(".png")) bytes[bytes.length - 5] = bytes[bytes.length - 5]! ^ 0xff;
        return { path: p, bytes, compress: false };
      }),
    );
    const third = createProject(studio.db, studio.clock, { name: "Adulterado" });
    const bad = await ingestUpload(studio, third.id, { name: "adulterado.zip", bytes: tampered });
    await studio.runner().runOnce();
    const rejected = getUpload(studio.db, third.id, bad.upload.id);
    expect(rejected.status).toBe("rejected");
    expect((rejected.error as { message: string }).message).toMatch(/SHA-256/);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM assets WHERE project_id = :p", { p: third.id })?.n).toBe(0);
  });
});

function getAssetIdOf(revisionId: string): string {
  return studio.db.get<{ asset_id: string }>("SELECT asset_id FROM asset_revisions WHERE id = :id", { id: revisionId })?.asset_id ?? "";
}
