import { FontPayload } from "@/contracts";
import { tx } from "@/i18n/locales";
import type { RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";

/**
 * Páginas do atlas de uma revisão de fonte (cada `fileId` citado pelos glyphs
 * é uma página, na ordem da primeira citação) e a receita do texto de teste.
 * Mesma organização que o pacote portátil exporta.
 */
export function fontPages(revision: RevisionView) {
  const payload = FontPayload.parse(revision.payload);
  const keys = [...new Set(payload.glyphs.map((g) => g.fileId))];
  const pages = keys.map((fileKey) => {
    const file = revision.files.find((f) => f.fileKey === fileKey);
    if (!file) throw new DomainFailure("internal", tx(`Página ${fileKey} sem arquivo na revisão`, `Page ${fileKey} has no file in the revision`));
    return { fileKey, sha256: file.sha256, fileId: file.id };
  });
  const glyphs = payload.glyphs.map((g) => ({ codepoint: g.codepoint, page: keys.indexOf(g.fileId), rect: g.rect, bearingX: g.bearingX, bearingY: g.bearingY, advanceX: g.advanceX }));
  const { ascent, descent, lineHeight, spaceAdvance } = payload.metrics;
  return { payload, pages, glyphs, metrics: { ascent, descent, lineHeight, spaceAdvance }, kerning: payload.kerning };
}

/** Texto com os glyphs aprovados em linhas (referência visual da extensão). */
export function specimenText(codepoints: number[], perLine = 16): string {
  const chars = codepoints.map((cp) => String.fromCodePoint(cp));
  const lines: string[] = [];
  for (let i = 0; i < chars.length; i += perLine) lines.push(chars.slice(i, i + perLine).join(""));
  return lines.join("\n");
}
