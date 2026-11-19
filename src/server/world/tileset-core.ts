import type { CornerTilesetPayload, IsoTilesetPayload, SideTilesetPayload, StylePayload, TilesetGeometry } from "@/contracts";
import { colorName } from "@/domain/color-names";
import { CORNER_SAMPLE, resolveCornerMap } from "@/domain/world/corner";
import { resolveSideMap, SIDE_SAMPLE } from "@/domain/world/side";
import type { Studio } from "../studio";
import { paletteNames } from "./core";
import { runWorldPython, type WorldRun } from "./python";

/**
 * Verificações e receitas de tileset (06 §verificações de emenda, §cobertura
 * lateral, §payload isométrico) sem dependência dos casos de uso HTTP: o
 * mesmo código roda na prévia do editor e no pipeline do worker.
 */

export type TilesetKind = "corner" | "sidescroller" | "isometric";
export type TilesetPayloadOf<K extends TilesetKind> = K extends "corner" ? CornerTilesetPayload : K extends "sidescroller" ? SideTilesetPayload : IsoTilesetPayload;
export type AnyTilesetPayload = CornerTilesetPayload | SideTilesetPayload | IsoTilesetPayload;

export const DEFAULT_PAIR_THRESHOLD = 1.6;
type Env = Pick<Studio, "config" | "blobs">;

export const ROUTE_LABELS = {
  corner_template: "Gabarito local: composição de duas texturas aprovadas pelas 16 máscaras; não é geração nativa de tileset",
  side_template: "Gabarito local da tabela lateral a partir de duas texturas aprovadas; não é geração nativa",
  iso_template: "Peças isométricas locais: textura aprovada projetada no losango + prop importado; não é geração nativa (/create-tiles-pro não ensaiado)",
  import: "Atlas importado com o layout declarado pelo artista; não demonstra geração",
  guided: "Gabarito local + candidato editado por modelo genérico com referências; faixa travada reaplicada localmente. Não é geração nativa de tileset",
} as const;

/** Geometria do gabarito congelada no plano: o worker confere o resultado sem ler o banco. */
export function geometryOf(kind: TilesetKind, payload: AnyTilesetPayload): TilesetGeometry {
  if (kind === "isometric") {
    const ts = payload as IsoTilesetPayload;
    return {
      layout: "isometric",
      diamond: ts.groundDiamondSize,
      elevationStepPx: ts.elevationStepPx,
      pieces: ts.pieces.map((p) => ({ key: p.pieceKey, kind: p.kind, rect: p.rect, groundOrigin: p.groundOrigin, supportPoint: p.supportPoint, footprintCells: p.footprintCells, elevation: p.elevation })),
    };
  }
  if (kind === "corner") {
    const ts = payload as CornerTilesetPayload;
    return { layout: "corner", cellSize: ts.cellSize, tiles: ts.tiles.map((t) => ({ key: t.tileKey, rect: t.rect, mask: t.mask })) };
  }
  const ts = payload as SideTilesetPayload;
  return { layout: "side", cellSize: ts.cellSize, tiles: ts.tiles.map((t) => ({ key: t.tileKey, rect: t.rect, configuration: t.configuration })) };
}

/** Amostra de validação montada pelas chaves: lago com ilha/canal/diagonais (cantos) ou plataforma com vão e degraus (lateral). */
export function tilesetSample(geometry: Exclude<TilesetGeometry, { layout: "isometric" }>): { size: [number, number]; cells: string[]; missing: string[] } {
  if (geometry.layout === "corner") {
    const tiles = geometry.tiles.map((t) => ({ tileKey: t.key, mask: t.mask, weight: 1 }));
    const res = resolveCornerMap(CORNER_SAMPLE.vertices, CORNER_SAMPLE.size, { tiles: tiles as CornerTilesetPayload["tiles"] }, { seed: 1, setKey: "sample" });
    return { size: CORNER_SAMPLE.size, cells: res.resolved.map((k) => k ?? ""), missing: res.missing.map(String) };
  }
  const tiles = geometry.tiles.map((t) => ({ tileKey: t.key, configuration: t.configuration, variant: 0 }));
  const res = resolveSideMap(SIDE_SAMPLE.solid, SIDE_SAMPLE.size, { tiles: tiles as SideTilesetPayload["tiles"] });
  return {
    size: SIDE_SAMPLE.size,
    cells: res.tileKeys.map((k, i) => k ?? (res.resolved[i] ? `!${res.resolved[i]}` : "")),
    missing: res.gaps,
  };
}

type IsoGeometry = Extract<TilesetGeometry, { layout: "isometric" }>;

/** Retalho isométrico de aceite: quatro losangos de chão, bloco ao lado (se houver) e o prop mais alto na célula da frente. */
export function isoDemoPatch(geometry: IsoGeometry) {
  const floor = geometry.pieces.find((p) => p.kind === "floor");
  const block = geometry.pieces.find((p) => p.kind === "block");
  const prop = [...geometry.pieces].filter((p) => p.kind === "prop").sort((a, b) => b.rect[3] - a.rect[3])[0];
  const cols = block ? 3 : 2;
  const cell = (key: string | undefined) => ({ key: key ?? null, elevation: 0 });
  const cells = block
    ? [cell(floor?.key), cell(floor?.key), cell(block.key), cell(floor?.key), cell(floor?.key), cell(undefined)]
    : [cell(floor?.key), cell(floor?.key), cell(floor?.key), cell(floor?.key)];
  return {
    size: [cols, 2] as [number, number],
    cells,
    props: prop ? [{ key: prop.key, cell: [1, 1] as [number, number] }] : [],
    // Personagem de teste atrás (0,0) e à frente (2,2) do prop: a copa cobre só o de trás.
    probes: [
      [0, 0],
      [2, 2],
    ] as [number, number][],
  };
}

export async function checkTilesetGeometry(env: Env, geometry: TilesetGeometry, atlasSha: string, opts: { guideSha?: string; lockedBandPx?: number; threshold?: number; zoom?: number } = {}): Promise<WorldRun> {
  if (geometry.layout === "isometric") {
    return runWorldPython(env, "iso_check", [{ role: "source", sha256: atlasSha }], {
      diamond: geometry.diamond,
      elevationStepPx: geometry.elevationStepPx,
      pieces: geometry.pieces,
      patch: isoDemoPatch(geometry),
      zoom: opts.zoom ?? 3,
    });
  }
  const sample = tilesetSample(geometry);
  const band = opts.guideSha ? (opts.lockedBandPx ?? 0) : 0;
  return runWorldPython(
    env,
    "tileset_seams",
    [{ role: "source", sha256: atlasSha }, ...(band > 0 && opts.guideSha ? [{ role: "layer", sha256: opts.guideSha }] : [])],
    {
      layout: geometry.layout,
      cellSize: geometry.cellSize,
      tiles: geometry.tiles,
      threshold: opts.threshold ?? DEFAULT_PAIR_THRESHOLD,
      lockedBandPx: band,
      sample: { size: sample.size, cells: sample.cells },
      zoom: opts.zoom ?? 3,
    },
  );
}

export function checkTilesetAtlas(env: Env, kind: TilesetKind, payload: AnyTilesetPayload, atlasSha: string, opts: { guideSha?: string; lockedBandPx?: number; threshold?: number; zoom?: number } = {}): Promise<WorldRun> {
  return checkTilesetGeometry(env, geometryOf(kind, payload), atlasSha, opts);
}

/** Regiões editáveis do gabarito na geração guiada: miolo dos tiles (sem a faixa travada) ou o losango das peças de chão/bloco; props ficam protegidos. */
export function editRegions(geometry: TilesetGeometry, lockedBandPx: number) {
  if (geometry.layout === "isometric") {
    return { regions: geometry.pieces.filter((p) => p.kind !== "prop").map((p) => ({ rect: p.rect, bandPx: 0 })), alphaEdgePx: 1 };
  }
  return { regions: geometry.tiles.map((t) => ({ rect: t.rect, bandPx: lockedBandPx })), alphaEdgePx: 1 };
}

/** Receita guiada (03a §tiles): mantém layout e áreas do gabarito; sem hex no texto. */
export function compileTilesetPrompt(o: {
  kind: TilesetKind;
  language: "pt-BR" | "en";
  brief: string;
  payload: AnyTilesetPayload;
  atlasSize: [number, number];
  scale: number;
  materials: string[];
  keyColor: string;
  style: StylePayload;
}): string {
  const en = o.language === "en";
  const names = paletteNames(o.style, o.language);
  const key = colorName(o.keyColor, o.language);
  const refs = o.materials.length
    ? en
      ? `Images 2–${o.materials.length + 1}: approved materials (${o.materials.join(", ")}); match their colors and texture.`
      : `Imagens 2–${o.materials.length + 1}: materiais aprovados (${o.materials.join(", ")}); siga a cor e a textura deles.`
    : "";
  if (o.kind === "isometric") {
    const [dw, dh] = (o.payload as IsoTilesetPayload).groundDiamondSize;
    return en
      ? [
          `Image 1: isometric pixel art tile pieces (${dw}×${dh} ground diamonds), shown ${o.scale}× enlarged on a flat ${key} background.`,
          `Repaint only the inside of each diamond and block face with richer pixel art detail: ${o.brief}.`,
          `Keep every diamond outline, position and size exactly; keep the ${key} background flat; no new objects, no text.`,
          refs,
          `Same palette: ${names}.`,
        ]
          .filter(Boolean)
          .join(" ")
      : [
          `Imagem 1: peças isométricas em pixel art (losangos de chão de ${dw}×${dh}), ampliadas ${o.scale}× sobre fundo ${key} chapado.`,
          `Repinte só o interior de cada losango e das faces do bloco com mais detalhe de pixel art: ${o.brief}.`,
          `Mantenha exatamente o contorno, a posição e o tamanho de cada losango; o fundo ${key} continua chapado; sem objetos novos e sem texto.`,
          refs,
          `Mesma paleta: ${names}.`,
        ]
          .filter(Boolean)
          .join(" ");
  }
  const ts = o.payload as CornerTilesetPayload | SideTilesetPayload;
  const [cw, ch] = ts.cellSize;
  const cols = Math.round(o.atlasSize[0] / cw);
  const rows = Math.round(o.atlasSize[1] / ch);
  if (o.kind === "corner") {
    const [a, b] = (ts as CornerTilesetPayload).terrains.map((t) => t.name);
    return en
      ? [
          `Image 1: a ${cols}×${rows} atlas of top-down pixel art terrain tiles, each ${cw}×${ch} pixels, shown ${o.scale}× enlarged.`,
          `Keep the grid, the position of every tile and the exact shape of the ${a} and ${b} areas: where there is ${b} it stays ${b}, where there is ${a} it stays ${a}.`,
          `Repaint the finish with richer pixel art detail: ${o.brief}.`,
          "Tile edges must keep matching their neighbors: no outline, frame, shadow or grid line between tiles.",
          refs,
          `Same palette: ${names}. Return the whole atlas at the same size, no text.`,
        ]
          .filter(Boolean)
          .join(" ")
      : [
          `Imagem 1: atlas de ${cols}×${rows} tiles de terreno em pixel art, vista de cima, cada tile com ${cw}×${ch} pixels, ampliado ${o.scale}×.`,
          `Mantenha a grade, a posição de cada tile e o desenho exato das áreas de ${a} e ${b}: onde há ${b} continua ${b}, onde há ${a} continua ${a}.`,
          `Redesenhe o acabamento com mais detalhe de pixel art: ${o.brief}.`,
          "As bordas de cada tile continuam encaixando com os vizinhos: sem contorno, moldura, sombra ou linha de grade entre os tiles.",
          refs,
          `Mesma paleta: ${names}. Devolva o atlas inteiro do mesmo tamanho, sem texto.`,
        ]
          .filter(Boolean)
          .join(" ");
  }
  const side = ts as SideTilesetPayload;
  return en
    ? [
        `Image 1: a ${cols}×${rows} atlas of side-view platform tiles in pixel art, each ${cw}×${ch} pixels, shown ${o.scale}× enlarged; body: ${side.platformMaterial}, walkable surface: ${side.surfaceMaterial}.`,
        `Keep the grid, the position of every tile, the surface on the exposed tops and the shaded exposed sides. Repaint with richer pixel art detail: ${o.brief}.`,
        `The ${key} areas are empty air: keep them flat ${key}. No text, no frame, no grid lines.`,
        refs,
        `Same palette: ${names}.`,
      ]
        .filter(Boolean)
        .join(" ")
    : [
        `Imagem 1: atlas de ${cols}×${rows} peças de plataforma em pixel art, vista lateral, cada uma com ${cw}×${ch} pixels, ampliado ${o.scale}×; corpo: ${side.platformMaterial}, superfície caminhável: ${side.surfaceMaterial}.`,
        `Mantenha a grade, a posição de cada peça, a superfície nos topos expostos e as laterais expostas sombreadas. Redesenhe com mais detalhe de pixel art: ${o.brief}.`,
        `As áreas ${key} são ar vazio: continuam ${key} chapado. Sem texto, sem moldura, sem linhas de grade.`,
        refs,
        `Mesma paleta: ${names}.`,
      ]
        .filter(Boolean)
        .join(" ");
}

/** Fator inteiro do gabarito enviado: lado maior perto de 1024 px. */
export function guideUpscale([w, h]: readonly [number, number]): number {
  return Math.max(1, Math.floor(1024 / Math.max(w, h)));
}
