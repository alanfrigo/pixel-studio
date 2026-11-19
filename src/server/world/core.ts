import { type StylePayload, TexturePayload } from "@/contracts";
import { colorName } from "@/domain/color-names";
import { type LocalizedText, tx } from "@/i18n/locales";

/**
 * Núcleo do mundo (T1) sem dependência dos casos de uso HTTP: usado pelos
 * pipelines do worker e pelos serviços. Não importa `services.ts` (evita ciclo
 * serviços → pipelines → mundo).
 */

export const DEFAULT_SEAM_THRESHOLD = 1.5;
export const SEAM_METHOD = "rgba-mean-ratio-p90-v1";

export interface SeamAxis {
  seamDelta: number;
  interiorDelta: number;
  ratio: number;
  seamP90: number;
  interiorP90: number;
  pixelLimit: number;
  passed: boolean;
  flagged: { start: number; end: number; maxDelta: number }[];
  flaggedPixels: number;
}

export interface SeamReport {
  size: [number, number];
  threshold: number;
  method: string;
  x: SeamAxis | null;
  y: SeamAxis | null;
  mosaicGrid: [number, number];
  shift: [number, number];
  passedAxes: ("x" | "y")[];
}

/** Payload da textura a partir do relatório: só eixos pedidos E aprovados viram repetíveis. */
export function texturePayloadFrom(report: SeamReport, o: { fileId: string; material: string; axes: { x: boolean; y: boolean } }): TexturePayload {
  const [w, h] = report.size;
  const axis = (a: SeamAxis | null) => (a ? { seamDelta: a.seamDelta, interiorDelta: a.interiorDelta, passed: a.passed } : null);
  return TexturePayload.parse({
    fileId: o.fileId,
    rect: [0, 0, w, h],
    logicalSize: [w, h],
    material: o.material.slice(0, 120),
    repeatAxes: { x: o.axes.x && Boolean(report.x?.passed), y: o.axes.y && Boolean(report.y?.passed) },
    requestedAxes: o.axes,
    seamReport: { method: SEAM_METHOD, threshold: report.threshold, x: axis(report.x), y: axis(report.y) },
  });
}

export function seamVerdict(report: SeamReport, axes: { x: boolean; y: boolean }): LocalizedText {
  const requested = (["x", "y"] as const).filter((a) => axes[a]);
  const failed = requested.filter((a) => !report[a]?.passed);
  const pt = requested.map((a) => `${a.toUpperCase()}: ${report[a]!.passed ? "aprovado" : "reprovado"} (emenda/interior ${report[a]!.ratio} ≤ ${report.threshold}?)`);
  const en = requested.map((a) => `${a.toUpperCase()}: ${report[a]!.passed ? "passed" : "failed"} (seam/interior ${report[a]!.ratio} ≤ ${report.threshold}?)`);
  return tx(
    `${pt.join(" · ")}${failed.length ? ` — não repetível em ${failed.join(" e ").toUpperCase()}; candidata guardada como amostra de material` : ""}`,
    `${en.join(" · ")}${failed.length ? ` — does not tile on ${failed.join(" and ").toUpperCase()}; candidate kept as a material sample` : ""}`,
  );
}

const LIGHT_WORDS: Record<string, { "pt-BR": string; en: string }> = {
  N: { "pt-BR": "do alto", en: "from the top" },
  NE: { "pt-BR": "do alto à direita", en: "from the top right" },
  E: { "pt-BR": "da direita", en: "from the right" },
  SE: { "pt-BR": "de baixo à direita", en: "from the bottom right" },
  S: { "pt-BR": "de baixo", en: "from the bottom" },
  SW: { "pt-BR": "de baixo à esquerda", en: "from the bottom left" },
  W: { "pt-BR": "da esquerda", en: "from the left" },
  NW: { "pt-BR": "do alto à esquerda", en: "from the top left" },
};

export function lightWords(style: StylePayload, language: "pt-BR" | "en"): string {
  return LIGHT_WORDS[style.lighting.lightFrom]?.[language] ?? style.lighting.lightFrom;
}

export function paletteNames(style: StylePayload, language: "pt-BR" | "en"): string {
  return [...new Set(style.palette.colors.map((c) => colorName(c.hex, language)))].join(", ");
}

/** Receita de material (03a §tiles): sem hex no texto, sem prometer emenda; a validação local decide. */
export function compileTexturePrompt(o: { language: "pt-BR" | "en"; brief: string; size: [number, number]; axes: { x: boolean; y: boolean }; style: StylePayload; references: number }): string {
  const [w, h] = o.size;
  const side = o.style.camera.projection.kind === "side";
  if (o.language === "en") {
    const axes = o.axes.x && o.axes.y ? "in both directions" : o.axes.x ? "horizontally" : "vertically";
    return [
      `Pixel art material texture for a game, ${side ? "seen from the front (side view)" : "seen from directly above, flat ground"}: ${o.brief}.`,
      "The whole image is the material, filling the frame edge to edge: no isolated object, no frame, no border, no vignette, no text.",
      `Even, continuous pattern meant to tile ${axes}: what leaves one edge continues on the opposite edge.`,
      `Crisp square pixels on a ${w}×${h} grid, few colors: ${paletteNames(o.style, "en")}.`,
      `Soft even light ${lightWords(o.style, "en")}, no cast shadow, no lighting gradient across the image.`,
      ...(o.references ? [`Images 1–${o.references}: approved materials of the same game; match their pixel size, palette and finish.`] : []),
    ].join(" ");
  }
  const axes = o.axes.x && o.axes.y ? "nos dois sentidos" : o.axes.x ? "na horizontal" : "na vertical";
  return [
    `Textura de material em pixel art para jogo, ${side ? "vista de frente (lateral)" : "vista de cima, chão plano"}: ${o.brief}.`,
    "A imagem inteira é o material, preenchendo o quadro de borda a borda: sem objeto isolado, sem moldura, sem borda, sem vinheta e sem texto.",
    `Padrão uniforme e contínuo para repetir lado a lado ${axes}: o que sai por uma borda continua na borda oposta.`,
    `Pixels quadrados e nítidos numa grade de ${w}×${h}, poucas cores: ${paletteNames(o.style, "pt-BR")}.`,
    `Luz suave e uniforme vinda ${lightWords(o.style, "pt-BR")}, sem sombra projetada nem degradê de iluminação na imagem.`,
    ...(o.references ? [`Imagens 1–${o.references}: materiais aprovados do mesmo jogo; siga o tamanho de pixel, a paleta e o acabamento.`] : []),
  ].join(" ");
}

