import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { assetLineage, createAsset, createProject, getUpload, listRevisions, revisionDependents } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { ingestUpload, jobOutput, publishFromSource, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import type { LocalProcessResult } from "./handlers/local-process";

const hasPython = existsSync(`${process.cwd()}/python/.venv/bin/python`);

let studio: TestStudio;
afterEach(() => studio?.cleanup());

/** Escudo 16×16 em fundo verde com vão verde fechado no centro. */
function shieldPng(): Uint8Array {
  const img = createImage(16, 16);
  fillRect(img, 0, 0, 16, 16, [0, 200, 0, 255]);
  fillRect(img, 3, 3, 10, 10, [180, 180, 190, 255]);
  fillRect(img, 7, 7, 2, 2, [0, 200, 0, 255]);
  return encodePng(img);
}

const FLOOD = { color: "#00c800", tolerance: 30, seeds: { borders: true, points: [] }, connectivity: 4 };

async function setup() {
  studio = makeTestStudio();
  const project = createProject(studio.db, studio.clock, { name: "Oficina" });
  const { upload } = await ingestUpload(studio, project.id, { name: "escudo.png", bytes: shieldPng() });
  await studio.runner().runOnce();
  expect(getUpload(studio.db, project.id, upload.id).status).toBe("ready");
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: "Escudo" });
  const base = publishFromSource(studio, project.id, asset.id, { from: "upload", uploadId: upload.id });
  return { project, asset, base, upload };
}

async function runLocal(projectId: string, request: Parameters<typeof submitJob>[2]["request"], key: string) {
  const { job } = submitJob(studio, projectId, { kind: "local_process", request } as Parameters<typeof submitJob>[2], key);
  await studio.runner().runOnce();
  const done = studio.queue.get(job.id)!;
  return { job: done, result: JSON.parse(done.result_json ?? "null") as LocalProcessResult, error: JSON.parse(done.error_json ?? "null") };
}

describe.skipIf(!hasPython)("processamento local", () => {
  it("importa, remove o fundo e publica um derivado ligado à origem", async () => {
    const { project, asset, base } = await setup();
    expect(base.origin).toBe("import");
    expect(base.files.map((f) => f.role).sort()).toEqual(["normalized", "original"]);

    const { job, result } = await runLocal(
      project.id,
      { operation: "remove_background_flood", inputs: [{ role: "source", ref: { kind: "revision", revisionId: base.id, fileKey: "image" } }], recipe: { version: 1, ...FLOOD } },
      "flood-1",
    );
    expect(job.state).toBe("succeeded");
    expect(result.cacheHit).toBe(false);
    expect(result.report.removedPixels).toBe(16 * 16 - 10 * 10);
    expect(result.outputs.map((o) => o.role)).toEqual(["cutout", "removed_mask"]);

    const derived = publishFromSource(studio, project.id, asset.id, { from: "job_output", jobId: job.id, outputIndex: 0, baseRevisionId: base.id, fileKey: "image" });
    expect(derived).toMatchObject({ origin: "local_process", status: "candidate", predecessorId: base.id });
    expect(derived.payload).toEqual(base.payload);
    expect(derived.files.find((f) => f.fileKey === "image")?.sha256).toBe(result.outputs[0]!.sha256);
    expect(derived.files.some((f) => f.fileKey === "original")).toBe(false);
    expect(revisionDependents(studio.db, project.id, base.id)).toEqual([expect.objectContaining({ revisionId: derived.id, role: "source", runtime: 0 })]);
    expect(listRevisions(studio.db, project.id, asset.id)).toHaveLength(2);
    // A biblioteca mostra a origem: "source de Escudo r1".
    expect(assetLineage(studio.db, project.id, asset.id)).toEqual({ [derived.id]: [{ revisionId: base.id, assetName: "Escudo", number: 1, role: "source", runtime: false }] });
  });

  it("mesma receita sobre os mesmos bytes reaproveita o cache com os mesmos blobs", async () => {
    const { project, base } = await setup();
    const request = { operation: "remove_background_flood" as const, inputs: [{ role: "source" as const, ref: { kind: "revision" as const, revisionId: base.id, fileKey: "image" } }], recipe: { version: 1, ...FLOOD } };
    const first = await runLocal(project.id, request, "a");
    const second = await runLocal(project.id, request, "b");
    expect(second.result.cacheHit).toBe(true);
    expect(second.result.cacheKey).toBe(first.result.cacheKey);
    expect(second.result.outputs).toEqual(first.result.outputs);
    const changed = await runLocal(project.id, { ...request, recipe: { ...request.recipe, tolerance: 0 } }, "c");
    expect(changed.result.cacheKey).not.toBe(first.result.cacheKey);
  });

  it("encadeia saídas: recorte justo sobre o fundo removido; publicação que muda a grade é recusada", async () => {
    const { project, asset, base } = await setup();
    const flood = await runLocal(
      project.id,
      { operation: "remove_background_flood", inputs: [{ role: "source", ref: { kind: "revision", revisionId: base.id, fileKey: "image" } }], recipe: { version: 1, ...FLOOD } },
      "flood",
    );
    const crop = await runLocal(
      project.id,
      { operation: "crop_to_content", inputs: [{ role: "source", ref: { kind: "job_output", jobId: flood.job.id, outputIndex: 0 } }], recipe: { version: 1, padding: 1, alphaThreshold: 0 } },
      "crop",
    );
    expect(crop.result.report).toMatchObject({ sourceRect: [3, 3, 10, 10], outputSize: [12, 12], sourceOffset: [2, 2] });
    expect(jobOutput(studio, project.id, crop.job.id, 0)).toMatchObject({ width: 12, height: 12 });
    expect(() =>
      publishFromSource(studio, project.id, asset.id, { from: "job_output", jobId: crop.job.id, outputIndex: 0, baseRevisionId: base.id, fileKey: "image" }),
    ).toThrow(/editor da família/);
  });

  it("erro de geometria vira falha legível sem nova tentativa automática", async () => {
    const { project, base } = await setup();
    const { job, error } = await runLocal(
      project.id,
      {
        operation: "slice_grid",
        inputs: [{ role: "source", ref: { kind: "revision", revisionId: base.id, fileKey: "image" } }],
        recipe: {
          version: 1,
          grid: { rows: 1, columns: 3, cell: [16, 16], margin: [0, 0], spacing: [0, 0], traversal: "row_major" },
          frameIds: ["a"],
          durationMs: [100],
          pivot: [8, 15],
          emptyCells: [],
        },
      },
      "slice",
    );
    expect(job.state).toBe("failed");
    expect(error).toMatchObject({ code: "validation_failed", details: { code: "geometry_mismatch" } });
    expect(error.message).toContain("48×16");
  });

  it("recusa receita inválida e entrada de outro projeto antes de enfileirar", async () => {
    const { project, base } = await setup();
    const submit = (projectId: string, recipe: Record<string, unknown>) =>
      submitJob(
        studio,
        projectId,
        { kind: "local_process", request: { operation: "remove_background_flood", inputs: [{ role: "source", ref: { kind: "revision", revisionId: base.id, fileKey: "image" } }], recipe } },
        `k-${projectId}-${JSON.stringify(recipe)}`,
      );
    expect(() => submit(project.id, { version: 1, color: "#00c800", tolerance: 30, seeds: { borders: false, points: [] }, connectivity: 4 })).toThrow(/Receita inválida/);
    const other = createProject(studio.db, studio.clock, { name: "Outro" });
    expect(() => submit(other.id, { version: 1, ...FLOOD })).toThrow(DomainFailure);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'local_process'")?.n).toBe(0);
  });
});
