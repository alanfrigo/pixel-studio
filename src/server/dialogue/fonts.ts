import { z } from "zod";
import { type FontPayload, FontPayload as FontSchema, formatCodepoint, HexColor, Id, type Glyph } from "@/contracts";
import { cellsFromChars, coverageReport, FONT_TEST_STRINGS, lineMetrics, sortCodepoints } from "@/domain/dialogue/font";
import { tx } from "@/i18n/locales";
import { createAsset, getAsset, getBlob, getRevision, publishRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { resolveLocalInput } from "../services";
import type { Studio } from "../studio";
import { dataUrl, outputOf, runWorldPython, storeOutput } from "../world/python";
import { DIALOGUE_ROUTE_LABELS } from "./core";
import { fontPages } from "./font-pages";
import { projectRequirement } from "./plans";

/**
 * Bancada da fonte (cartão D1): cobertura exigida pelo projeto × glyphs
 * inspecionados, texto de teste renderizado com o atlas + métricas (1×, zoom
 * inteiro, ausentes, largura e quebra) e importação de atlas existente como
 * caminho distinto da geração. Nada substitui glyph ausente em silêncio.
 */

function fontRevision(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "font") throw new DomainFailure("validation_failed", tx(`${asset.name} não é uma fonte`, `${asset.name} is not a font`));
  return { revision, asset };
}

export const CoverageInput = z.strictObject({
  fontRevisionId: Id.nullable().default(null),
  kit: z.enum(["basic", "basic_pt"]).default("basic_pt"),
  extraText: z.string().max(4000).default(""),
});

export function fontCoverage(studio: Studio, projectId: string, raw: z.input<typeof CoverageInput>) {
  const input = CoverageInput.parse(raw);
  const required = projectRequirement(studio, projectId, input.kit, input.extraText);
  const font = input.fontRevisionId ? (FontSchema.parse(fontRevision(studio, projectId, input.fontRevisionId).revision.payload) as FontPayload) : null;
  const report = coverageReport(font, required.codepoints);
  return {
    kit: input.kit,
    ...report,
    codepoints: required.codepoints,
    sources: required.sources,
    /** Glyphs da fonte por origem (gerado, estendido, importado). */
    origins: font ? Object.fromEntries(["generated", "extended", "imported"].map((o) => [o, font.glyphs.filter((g) => g.origin === o).length])) : null,
    testStrings: FONT_TEST_STRINGS,
  };
}

export const RenderInput = z.strictObject({
  fontRevisionId: Id,
  texts: z.array(z.string().min(1).max(2000)).min(1).max(8).default([...FONT_TEST_STRINGS]),
  maxWidth: z.number().int().min(8).max(1024).nullable().default(null),
  zoom: z.number().int().min(1).max(8).default(3),
  color: HexColor.nullable().default(null),
  background: HexColor.nullable().default(null),
});

/** Diagnóstico de um texto de teste (relatório de `font_render`). */
export interface RenderedText {
  text: string;
  lines: number;
  lineWidths: number[];
  width: number;
  height: number;
  missing: { char: string; codepoint: number; position: number; line: number }[];
  overflow: boolean;
  wrapped: boolean;
}

/** Texto de teste com o atlas e as métricas da revisão (mesma regra do leitor independente). */
export async function renderFontText(studio: Studio, projectId: string, raw: z.input<typeof RenderInput>) {
  const input = RenderInput.parse(raw);
  const { revision } = fontRevision(studio, projectId, input.fontRevisionId);
  const font = fontPages(revision);
  const run = await runWorldPython(studio, "font_render", font.pages.map((p) => ({ role: "layer", sha256: p.sha256 })), {
    glyphs: font.glyphs,
    metrics: font.metrics,
    kerning: font.kerning,
    texts: input.texts,
    maxWidth: input.maxWidth,
    zoom: input.zoom,
    color: input.color,
    background: input.background,
  });
  const texts = (run.report as { texts: RenderedText[] }).texts;
  return {
    metrics: { ...font.metrics, baseline: font.payload.metrics.baseline ?? font.metrics.ascent, nativeGlyphPx: font.payload.nativeGlyphPx },
    zoom: input.zoom,
    maxWidth: input.maxWidth,
    texts: texts.map((t, i) => ({
      ...t,
      one: dataUrl(run.outputs.find((o) => o.role === "text" && o.key === String(i))!),
      zoomed: dataUrl(run.outputs.find((o) => o.role === "text_zoom" && o.key === String(i))!),
    })),
    warnings: run.warnings,
  };
}

export const ImportAtlasInput = z.strictObject({
  assetId: Id.optional(),
  name: z.string().trim().min(1).max(120).default("Fonte importada"),
  uploadId: Id,
  columns: z.number().int().min(1).max(16),
  rows: z.number().int().min(1).max(16),
  cell: z.tuple([z.number().int().min(3).max(64), z.number().int().min(3).max(64)]),
  /** Linha logo abaixo do corpo dos glyphs, contada do topo da célula. */
  baselineY: z.number().int().min(1).max(64),
  capHeight: z.number().int().min(3).max(48),
  /** Caracteres em ordem de leitura, um por célula; espaço = célula vazia. */
  chars: z.string().min(1).max(256),
  tracking: z.number().int().min(0).max(4).default(1),
  license: z.strictObject({ name: z.string().trim().min(1).max(120), provenance: z.string().trim().min(1).max(500) }),
});

/** Importação de atlas existente (caminho distinto da geração): grade declarada, cobertura = células com tinta. */
export async function importFontAtlas(studio: Studio, projectId: string, raw: z.input<typeof ImportAtlasInput>) {
  const input = ImportAtlasInput.parse(raw);
  const cells = cellsFromChars(input.chars);
  if (cells.length > input.columns * input.rows) throw new DomainFailure("validation_failed", tx("Mais caracteres que células na grade", "More characters than grid cells"));
  if (input.baselineY > input.cell[1] || input.capHeight > input.baselineY) throw new DomainFailure("validation_failed", tx("Baseline ou altura de maiúscula fora da célula", "Baseline or cap height outside the cell"));
  const sha = resolveLocalInput(studio, projectId, { kind: "upload", uploadId: input.uploadId });
  const run = await runWorldPython(studio, "font_measure", [{ role: "source", sha256: sha }], {
    columns: input.columns,
    rows: input.rows,
    cell: input.cell,
    baselineY: input.baselineY,
    padLeft: 0,
    capHeight: input.capHeight,
    codepoints: cells,
    alphaThreshold: 128,
    tracking: input.tracking,
    snapBaseline: false,
    keyColor: null,
  });
  const measured = run.report as { glyphs: { codepoint: number; rect: [number, number, number, number]; bearingX: number; bearingY: number; advanceX: number }[]; missing: number[] };
  if (!measured.glyphs.length) throw new DomainFailure("validation_failed", tx("Nenhuma célula do atlas tem tinta", "No atlas cell has ink"));
  const atlas = await storeOutput(studio, outputOf(run, "page"));
  const preview = await storeOutput(studio, outputOf(run, "preview"));
  const original = getBlob(studio.db, sha);
  const glyphs: Glyph[] = measured.glyphs.map((g) => ({ codepoint: g.codepoint, fileId: "atlas", rect: g.rect, bearingX: g.bearingX, bearingY: g.bearingY, advanceX: g.advanceX, origin: "imported" }));
  const payload = FontSchema.parse({
    nativeGlyphPx: input.capHeight,
    metrics: lineMetrics(glyphs, input.capHeight),
    glyphs,
    kerning: [],
    declaredCoverage: sortCodepoints(glyphs.map((g) => g.codepoint)),
    missingGlyph: { policy: "report" },
    ttf: null,
    license: input.license,
  });
  const asset = input.assetId ? getAsset(studio.db, projectId, input.assetId) : createAsset(studio.db, studio.clock, { projectId, family: "font", kind: "bitmap", name: input.name });
  if (asset.family !== "font") throw new DomainFailure("validation_failed", tx("O asset de destino não é uma fonte", "The target asset is not a font"));
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "import",
    styleRevisionId: null,
    payload,
    files: [
      { fileKey: "atlas", role: "atlas", idx: 0, blob: atlas },
      { fileKey: "preview", role: "preview", idx: 0, blob: preview },
      ...(original ? [{ fileKey: "original", role: "original", idx: 0, blob: original }] : []),
    ],
    technicalReport: {
      operation: "font_import",
      routeLabel: DIALOGUE_ROUTE_LABELS.fontImport,
      cells: cells.length,
      measured: glyphs.length,
      missing: measured.missing,
      missingLabels: measured.missing.map(formatCodepoint),
      metrics: payload.metrics,
      spacing: "proportional",
      warnings: run.warnings,
    },
  });
  return { revision, asset: getAsset(studio.db, projectId, asset.id) };
}
