import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExpressionPayload, FontPayload, PortraitPayload, SpeechPayload, VISEME_IDS } from "@/contracts";
import { codepointsOf, PT_KIT } from "@/domain/dialogue/font";
import { validateManifest } from "@/domain/manifest/validate";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { readZip } from "@/lib/zip";
import { createAsset, createProject, getAsset, getRevision, getUpload, publishRevision, reviewRevision } from "../catalog/catalog";
import { exportFilePath, getExport, requestExport } from "../export/exports";
import { buildPlan } from "../plan-builders";
import { genericCapabilities } from "../providers/generic-route";
import { ingestUpload, submitJob } from "../services";
import { makeTestStudio, type TestStudio } from "../testing";
import { dialogueCatalog } from "./catalog";
import { fontCoverage, importFontAtlas, renderFontText } from "./fonts";
import { compareExpressions, reviewPortrait } from "./portraits";
import { previewSpeech, publishSpeech, retargetSpeech, verifySpeech } from "./speech";

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

async function run(projectId: string, body: Record<string, unknown>, targetAssetId: string, key: string) {
  const planned = await buildPlan(studio, projectId, body as never);
  const { job } = submitJob(studio, projectId, { kind: "generation", request: { plan: planned.plan, planDigest: planned.digest, targetAssetId } }, key);
  await studio.runner().runOnce();
  const done = studio.queue.get(job.id)!;
  return { planned: planned as typeof planned & Record<string, unknown>, result: JSON.parse(done.result_json ?? "null") as { revisionIds: string[] } | null, error: JSON.parse(done.error_json ?? "null") as { message: string } | null };
}

/** Guerreiro aprovado (vista S): túnica azul, pele e cabelo castanho. */
async function warrior(projectId: string) {
  const img = createImage(16, 24);
  fillRect(img, 5, 1, 6, 3, [90, 50, 30, 255]);
  fillRect(img, 5, 4, 6, 6, [230, 180, 140, 255]);
  fillRect(img, 3, 10, 10, 13, [40, 70, 160, 255]);
  const uploadId = await upload(projectId, "guerreiro.png", encodePng(img));
  const blob = getUpload(studio.db, projectId, uploadId);
  const asset = createAsset(studio.db, studio.clock, { projectId, family: "character", kind: "base", name: "Guerreiro" });
  const rev = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "import",
    styleRevisionId: null,
    payload: { logicalSize: [16, 24], groundOrigin: [8, 23], state: "default", predecessorRevisionId: null, views: [{ direction: "S", fileId: "s", rect: [0, 0, 16, 24], sourceOffset: [0, 0] }] },
    files: [{ fileKey: "s", role: "normalized", idx: 0, blob: { sha256: blob.normalizedSha256 ?? blob.sha256, bytes: 1, mime: "image/png", modality: "raster", metadata: { width: 16, height: 24 } } }],
  });
  approve(projectId, rev.id);
  return rev.id;
}

describe("rota genérica não declara capacidades nativas do D1", () => {
  it("OpenRouter/Codex: retrato ≥1 referência, folha de bocas ≥2, fonte ≥1; nunca portrait/visemes/pixel_font", () => {
    const route = { maxReferences: 5, transparent: "single_reference" as const };
    expect(genericCapabilities("generate_portrait", route)).toEqual(["text_to_image", "image_references", "alpha_output"]);
    expect(genericCapabilities("generate_visemes", route)).toEqual(["text_to_image", "image_references"]);
    expect(genericCapabilities("generate_pixel_font", route)).toEqual(["text_to_image", "image_references"]);
    expect(genericCapabilities("generate_visemes", { maxReferences: 1, transparent: false })).toEqual([]);
    for (const op of ["generate_portrait", "generate_visemes", "generate_pixel_font"] as const) {
      expect(genericCapabilities(op, route).some((c) => c === "portrait" || c === "visemes" || c === "pixel_font")).toBe(false);
    }
  });
});

describe.skipIf(!existsSync(PYTHON))("retratos, fala e fontes (cartão D1)", { timeout: 120_000 }, () => {
  it("retrato ligado ao personagem → expressões neutra/feliz com visemes → duas falas sem gerar → troca de expressão → exportação lida pelo consumidor", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Diálogo" });
    const characterId = await warrior(project.id);

    // Retrato por imagem + referência do personagem (rota genérica rotulada).
    const portraitAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "portrait", kind: "portrait", name: "Guerreiro · retrato" });
    const p = await run(project.id, { operation: "generate_portrait", providerProfileId: "simulated", characterRevisionId: characterId, logicalSize: [48, 48] }, portraitAsset.id, "portrait:1");
    expect(p.error).toBeNull();
    expect(p.planned.plan.requiredCapabilities).toEqual(["text_to_image", "image_references", "alpha_output"]);
    expect(p.planned.plan.sources).toEqual([expect.objectContaining({ revisionId: characterId, role: "identity" })]);
    expect((p.planned.routeLabel as { en: string }).en).toMatch(/not a native portrait operation/);
    const portraitRev = getRevision(studio.db, project.id, p.result!.revisionIds[0]!);
    const portrait = PortraitPayload.parse(portraitRev.payload);
    expect(portrait).toMatchObject({ characterRevisionId: characterId, logicalSize: [48, 48] });
    const report = portraitRev.technicalReport as { palette: { nearReferenceRatio: number }; scale: { ratio: number }; receivedSize: number[]; regions: { reviewed: boolean } };
    expect(report.palette.nearReferenceRatio).toBeGreaterThan(0.6);
    expect(report.receivedSize).toEqual([96, 96]);
    expect(report.regions.reviewed).toBe(false);
    // Expressão antes da revisão das regiões: bloqueia antes de cobrar.
    await expect(buildPlan(studio, project.id, { operation: "generate_visemes", providerProfileId: "simulated", portraitRevisionId: portraitRev.id, expressionKey: "neutral" } as never)).rejects.toThrow(/precisa estar aprovada/);
    const reviewed = reviewPortrait(studio, project.id, { revisionId: portraitRev.id, faceAnchor: portrait.faceAnchor, faceRect: portrait.faceRect!, mouthRect: portrait.mouthRect! });
    expect((reviewed.revision.technicalReport as { regions: { reviewed: boolean } }).regions.reviewed).toBe(true);
    approve(project.id, reviewed.revision.id);

    // Uma expressão por job e por aprovação; mesma quantidade/ordem de visemes.
    const expressions: Record<string, string> = {};
    for (const key of ["neutral", "happy"]) {
      const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "portrait", kind: "expression", name: `Guerreiro · ${key}` });
      const e = await run(project.id, { operation: "generate_visemes", providerProfileId: "simulated", portraitRevisionId: reviewed.revision.id, expressionKey: key, expressionBrief: key === "happy" ? "sorriso largo" : "" }, asset.id, `visemes:${key}`);
      expect(e.error).toBeNull();
      expect(e.planned.plan.params).toMatchObject({ visemeIds: [...VISEME_IDS], sheet: { columns: 4, rows: 2, cell: [48, 48] } });
      const rev = getRevision(studio.db, project.id, e.result!.revisionIds[0]!);
      const payload = ExpressionPayload.parse(rev.payload);
      expect(payload.visemes.map((v) => v.visemeId)).toEqual([...VISEME_IDS]);
      expect(payload.visemes[5]!.rect).toEqual([48, 48, 48, 48]);
      const stability = (rev.technicalReport as { stability: { maxOutsideMouth: number; outsideFace: number; complete: boolean } }).stability;
      expect(stability).toMatchObject({ maxOutsideMouth: 0, complete: true });
      expect(stability.outsideFace).toBeLessThanOrEqual(0.05);
      approve(project.id, rev.id);
      expressions[key] = rev.id;
    }
    // Gerar de novo a mesma expressão do mesmo retrato vai para o mesmo asset (nova candidata).
    const again = await buildPlan(studio, project.id, { operation: "generate_visemes", providerProfileId: "simulated", portraitRevisionId: reviewed.revision.id, expressionKey: "happy" } as never);
    expect((again as Record<string, unknown>).targetAssetId).toBe(getRevision(studio.db, project.id, expressions.happy!).assetId);
    const compare = await compareExpressions(studio, project.id, { a: expressions.neutral!, b: expressions.happy! });
    expect(compare.compatibility.compatible).toBe(true);
    expect(compare.samePortrait).toBe(true);
    const charged = studio.simulatedStore.read().charged;
    expect(charged).toBe(3);

    // Duas falas reutilizam os visemes aprovados: zero jobs de geração.
    const jobsBefore = studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generation'")!.n;
    const preview = previewSpeech(studio, project.id, { expressionRevisionId: expressions.neutral!, textKey: "npc.greeting", language: "pt-BR", text: "Olá, viajante! Vamos à aventura?" });
    expect(preview.generationJobs).toBe(0);
    expect((preview.routeLabel as { en: string }).en).toMatch(/does not synthesize voice/);
    const s1 = await publishSpeech(studio, project.id, { expressionRevisionId: expressions.neutral!, textKey: "npc.greeting", language: "pt-BR", text: "Olá, viajante! Vamos à aventura?", name: "Saudação" });
    const s2 = await publishSpeech(studio, project.id, { expressionRevisionId: expressions.neutral!, textKey: "npc.potion", language: "pt-BR", text: "Use a poção de cura.", name: "Poção" });
    expect(SpeechPayload.parse(s1.revision.payload).timeline).toEqual(preview.timeline);
    expect(studio.simulatedStore.read().charged).toBe(charged);
    expect(studio.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'generation'")!.n).toBe(jobsBefore);
    expect(s1.revision.files.map((f) => [f.fileKey, f.mime])).toEqual(expect.arrayContaining([["preview-gif", "image/gif"]]));
    // Reabrir reproduz a mesma sequência e durações.
    expect(verifySpeech(SpeechPayload.parse(getRevision(studio.db, project.id, s1.revision.id).payload))).toMatchObject({ reproducible: true, totalMs: preview.totalMs });
    approve(project.id, s1.revision.id);
    approve(project.id, s2.revision.id);

    // Trocar a expressão: mesmos IDs/ordem → mesmos passos, nova revisão; a anterior não muda.
    const swapped = await retargetSpeech(studio, project.id, { speechRevisionId: s1.revision.id, expressionRevisionId: expressions.happy! });
    const swappedPayload = SpeechPayload.parse(swapped.revision.payload);
    expect(swappedPayload.expressionRevisionId).toBe(expressions.happy);
    expect(swappedPayload.timeline).toEqual(preview.timeline);
    expect(SpeechPayload.parse(getRevision(studio.db, project.id, s1.revision.id).payload).expressionRevisionId).toBe(expressions.neutral);
    approve(project.id, swapped.revision.id);
    expect(studio.simulatedStore.read().charged).toBe(charged);

    const catalog = dialogueCatalog(studio, project.id);
    expect(catalog.speeches.flatMap((s) => s.revisions).every((r) => r.verify?.reproducible)).toBe(true);

    // Exportação: falas puxam expressões e retrato (fecho de dependências); o consumidor reproduz a sequência.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [swapped.revision.id, s2.revision.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect([ready.state, ready.error]).toEqual(["ready", null]);
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    expect(manifest.entries.map((e: { kind: string }) => e.kind).sort()).toEqual(["expression", "expression", "portrait", "speech", "speech"]);
    expect(manifest.files.some((f: { mime: string }) => f.mime === "image/gif")).toBe(false);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-dialogue-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "fala.zip"), zip);
    const reader = spawnSync(PYTHON, [READER, path.join(dir, "fala.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(reader.status, reader.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const read = summary.entries.find((e: { revisionId: string }) => e.revisionId === swapped.revision.id);
    expect(read.sequence.map((s: { visemeId: string; durationMs: number }) => [s.visemeId, s.durationMs])).toEqual(preview.timeline.map((s) => [s.visemeId, s.durationMs]));
    expect(read.totalMs).toBe(preview.totalMs);
    expect(read.expression).toBe(expressions.happy);
    const expr = summary.entries.find((e: { kind: string; expressionKey?: string }) => e.kind === "expression" && e.expressionKey === "happy");
    expect(expr.visemes).toEqual([...VISEME_IDS]);
  });

  it("fonte: folha-base pelo gabarito lista ausentes, extensão por imagem + glyphs-base completa o kit português, texto de teste e consumidor", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Tipografia" });
    const fontAsset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "font", kind: "bitmap", name: "Fonte de metal" });
    const base = await run(project.id, { operation: "generate_pixel_font", providerProfileId: "simulated", brief: "metal forjado", glyphSize: 8, kit: "basic_pt" }, fontAsset.id, "font:base");
    expect(base.error).toBeNull();
    expect(base.planned.plan.requiredCapabilities).toEqual(["text_to_image", "image_references"]);
    expect(base.planned.plan.parts.length).toBe(4);
    for (const cp of codepointsOf(PT_KIT)) expect(base.planned.plan.params).toMatchObject({ requiredCodepoints: expect.arrayContaining([cp]) });
    const baseRev = getRevision(studio.db, project.id, base.result!.revisionIds[0]!);
    const basePayload = FontPayload.parse(baseRev.payload);
    // O simulado ignora acentos na folha-base: ausentes listados, sem substituição por letra sem acento.
    const baseReport = baseRev.technicalReport as { missing: number[]; routeLabel: { en: string } };
    expect(baseReport.missing).toEqual(expect.arrayContaining(codepointsOf("ãÁç—")));
    expect(basePayload.glyphs.some((g) => g.codepoint === "ã".codePointAt(0))).toBe(false);
    expect(basePayload.missingGlyph).toEqual({ policy: "report" });
    expect(basePayload.ttf).toBeNull();
    expect(baseReport.routeLabel.en).toMatch(/not a native pixel font nor a TTF/);
    expect(basePayload.metrics.baseline).toBe(basePayload.metrics.ascent);
    const coverage = fontCoverage(studio, project.id, { fontRevisionId: baseRev.id });
    expect(coverage.complete).toBe(false);
    expect(coverage.missing).toEqual(expect.arrayContaining(codepointsOf(PT_KIT)));
    const before = await renderFontText(studio, project.id, { fontRevisionId: baseRev.id, texts: ["Ação, Poção, Coração — ÁRVORE"] });
    expect(new Set((before.texts[0] as unknown as { missing: { char: string }[] }).missing.map((m) => m.char))).toEqual(new Set(["ç", "ã", "—", "Á"]));
    approve(project.id, baseRev.id);

    // Extensão: só os ausentes, com referência dos glyphs aprovados; registra a revisão-base por glyph.
    const ext = await run(project.id, { operation: "generate_pixel_font", providerProfileId: "simulated", mode: "extend", baseRevisionId: baseRev.id, kit: "basic_pt" }, fontAsset.id, "font:ext");
    expect(ext.error).toBeNull();
    expect(ext.planned.targetAssetId).toBe(fontAsset.id);
    const extPlan = ext.planned.plan;
    if (extPlan.operation !== "generate_pixel_font") throw new Error("Plano inesperado");
    expect(extPlan.sources.every((s) => s.revisionId === baseRev.id && s.role === "style")).toBe(true);
    expect(new Set(extPlan.params.requiredCodepoints)).toEqual(new Set(baseReport.missing));
    const extRev = getRevision(studio.db, project.id, ext.result!.revisionIds[0]!);
    const extPayload = FontPayload.parse(extRev.payload);
    const extended = extPayload.glyphs.filter((g) => g.origin === "extended");
    expect(extended.length).toBe(baseReport.missing.length);
    expect(extended.every((g) => g.baseRevisionId === baseRev.id && g.fileId.startsWith("ext1-"))).toBe(true);
    expect(extPayload.glyphs.filter((g) => g.origin === "generated").length).toBe(basePayload.glyphs.length);
    const extendedA = extended.find((g) => g.codepoint === "Á".codePointAt(0))!;
    expect(-extendedA.bearingY).toBeGreaterThan(8);
    expect(extPayload.metrics.ascent).toBeGreaterThanOrEqual(-extendedA.bearingY);
    expect(fontCoverage(studio, project.id, { fontRevisionId: extRev.id })).toMatchObject({ complete: true, missing: [] });
    const rendered = await renderFontText(studio, project.id, { fontRevisionId: extRev.id, zoom: 3 });
    const texts = rendered.texts as unknown as { missing: unknown[]; width: number; height: number }[];
    expect(texts.every((t) => t.missing.length === 0)).toBe(true);
    expect(texts[0]!.height).toBe(extPayload.metrics.lineHeight);
    const wrapped = await renderFontText(studio, project.id, { fontRevisionId: extRev.id, texts: ["Ação Poção Coração", "Inventário"], maxWidth: 30 });
    const [w0, w1] = wrapped.texts as unknown as { wrapped: boolean; lines: number; overflow: boolean }[];
    expect(w0).toMatchObject({ wrapped: true, lines: 3 });
    expect(w1!.overflow).toBe(true);
    approve(project.id, extRev.id);

    // Exporta atlas + métricas como autoridade (sem TTF); o consumidor renderiza o texto de teste sem ausentes.
    const { export: requested } = requestExport(studio, project.id, { revisionIds: [extRev.id], profile: "portable-v1" });
    expect(await studio.runner().runOnce()).toBe(true);
    const ready = getExport(studio.db, project.id, requested.id);
    expect(ready.state).toBe("ready");
    const zip = new Uint8Array(readFileSync(exportFilePath(studio.config.paths.exports, ready)));
    const manifest = JSON.parse(new TextDecoder().decode(readZip(zip).read("manifest.json")));
    expect(validateManifest(manifest).issues).toEqual([]);
    expect(manifest.files.every((f: { mime: string }) => f.mime === "image/png")).toBe(true);
    const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-font-"));
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "fonte.zip"), zip);
    const reader = spawnSync(PYTHON, [READER, path.join(dir, "fonte.zip"), path.join(dir, "out")], { encoding: "utf8" });
    expect(reader.status, reader.stderr).toBe(0);
    const summary = JSON.parse(readFileSync(path.join(dir, "out", "summary.json"), "utf8"));
    const font = summary.entries.find((e: { family: string }) => e.family === "font");
    expect(font.renders.map((r: { missing: unknown[] }) => r.missing)).toEqual([[], [], [], []]);
    expect(font.origins).toMatchObject({ generated: basePayload.glyphs.length, extended: extended.length });
    expect(font.renders[0].size[1]).toBe(extPayload.metrics.lineHeight);
    expect(font.renders[0].width).toBe(texts[0]!.width);
  });

  it("importar atlas existente é caminho distinto: grade declarada, células vazias ignoradas, cobertura = tinta", async () => {
    studio = makeTestStudio();
    const project = createProject(studio.db, studio.clock, { name: "Importada" });
    const atlas = createImage(24, 10);
    fillRect(atlas, 1, 1, 4, 6, [255, 255, 255, 255]); // A
    fillRect(atlas, 7, 1, 3, 6, [255, 255, 255, 255]); // B
    fillRect(atlas, 19, 3, 4, 4, [255, 255, 255, 255]); // c (célula 3 vazia: espaço)
    const uploadId = await upload(project.id, "atlas.png", encodePng(atlas));
    const imported = await importFontAtlas(studio, project.id, { uploadId, columns: 4, rows: 1, cell: [6, 10], baselineY: 7, capHeight: 6, chars: "AB c", license: { name: "CC0-1.0", provenance: "Atlas de teste" } });
    const payload = FontPayload.parse(imported.revision.payload);
    expect(payload.glyphs.map((g) => [String.fromCodePoint(g.codepoint), g.origin])).toEqual([["A", "imported"], ["B", "imported"], ["c", "imported"]]);
    expect(payload.glyphs[0]).toMatchObject({ rect: [1, 1, 4, 6], bearingY: -6, advanceX: 5 });
    expect((imported.revision.technicalReport as { routeLabel: { en: string } }).routeLabel.en).toMatch(/Imported atlas/);
    await expect(importFontAtlas(studio, project.id, { uploadId, columns: 2, rows: 1, cell: [6, 10], baselineY: 7, capHeight: 6, chars: "ABC", license: { name: "x", provenance: "y" } })).rejects.toThrow(/Mais caracteres que células/);
  });
});
