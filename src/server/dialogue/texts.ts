import { ScreenPayload } from "@/contracts";
import type { CoverageSource } from "@/domain/dialogue/font";
import { listAssets, listRevisions } from "../catalog/catalog";
import type { Studio } from "../studio";

/**
 * Textos do projeto que a fonte precisa cobrir (07 §cobertura do projeto):
 * amostras de legenda dos componentes de UI (chave + amostra), textos
 * substituídos nas telas, traduções do catálogo da tela e falas. Lê a
 * revisão aprovada de cada asset (ou a mais recente, se nenhuma foi aprovada).
 */

const TEXT_FIELDS = new Set(["sample", "text", "sampleText"]);

function collect(value: unknown, path: string[], out: { key: string; text: string }[]) {
  if (Array.isArray(value)) value.forEach((v, i) => collect(v, [...path, String(i)], out));
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(obj)) {
      if (TEXT_FIELDS.has(k) && typeof v === "string" && v.trim()) out.push({ key: (typeof obj.key === "string" ? obj.key : typeof obj.textKey === "string" ? obj.textKey : null) ?? [...path, k].join("."), text: v });
      else collect(v, [...path, k], out);
    }
  }
}

export function projectTexts(studio: Studio, projectId: string): CoverageSource[] {
  const sources: CoverageSource[] = [];
  for (const family of ["ui", "portrait"] as const) {
    for (const asset of listAssets(studio.db, projectId, { family })) {
      if (family === "portrait" && asset.kind !== "speech") continue;
      const revisions = listRevisions(studio.db, projectId, asset.id);
      const revision = revisions.find((r) => r.id === asset.approvedRevisionId) ?? revisions[0];
      if (!revision) continue;
      const found: { key: string; text: string }[] = [];
      collect(revision.payload, [], found);
      for (const f of found) sources.push({ source: `${family === "ui" ? "ui" : "speech"}:${f.key}`, text: f.text });
      if (family === "ui" && asset.kind === "screen") {
        const screen = ScreenPayload.safeParse(revision.payload);
        if (!screen.success) continue;
        for (const entry of screen.data.textCatalog?.entries ?? []) {
          for (const text of Object.values(entry.text)) {
            if (text.trim()) sources.push({ source: `ui:${entry.key}`, text });
          }
        }
      }
    }
  }
  return sources;
}
