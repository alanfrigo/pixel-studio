import type { SideConfiguration, SideTilesetPayload } from "@/contracts";

/**
 * Tabela própria do tileset lateral (06 §cobertura lateral): faces expostas
 * da célula sólida → configuração. Fora do mapa conta como sólido nas laterais
 * e embaixo (o terreno continua) e como ar em cima.
 */

type Bit = 0 | 1;

const RULES: Record<string, SideConfiguration> = {
  "": "interior",
  T: "surface_middle",
  TL: "surface_left",
  TR: "surface_right",
  TLR: "surface_single",
  L: "wall_left",
  R: "wall_right",
  LR: "column_middle",
  B: "ceiling_middle",
  BL: "ceiling_left",
  BR: "ceiling_right",
  BLR: "column_bottom",
  TB: "thin_middle",
  TBL: "thin_left",
  TBR: "thin_right",
  TBLR: "block_single",
};

export function sideConfiguration(solid: readonly Bit[], size: readonly [number, number], x: number, y: number): SideConfiguration | null {
  const [cols, rows] = size;
  const at = (cx: number, cy: number, outside: Bit): Bit => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? outside : (solid[cy * cols + cx] ?? 0));
  if (!at(x, y, 0)) return null;
  const top = !at(x, y - 1, 0);
  const left = !at(x - 1, y, 1);
  const right = !at(x + 1, y, 1);
  const bottom = !at(x, y + 1, 1);
  const key = `${top ? "T" : ""}${bottom ? "B" : ""}${left ? "L" : ""}${right ? "R" : ""}`;
  const config = RULES[key]!;
  if (config === "interior") {
    // Canto interno: tudo sólido em volta, mas ar na diagonal de cima (degrau).
    if (!at(x - 1, y - 1, 0)) return "inner_corner_left";
    if (!at(x + 1, y - 1, 0)) return "inner_corner_right";
  }
  return config;
}

export interface SideResolution {
  resolved: (SideConfiguration | null)[];
  /** Tile por célula; `null` = ar ou lacuna. */
  tileKeys: (string | null)[];
  /** Configurações usadas que o tileset não tem: lacunas visíveis. */
  gaps: SideConfiguration[];
}

export function resolveSideMap(solid: readonly Bit[], size: readonly [number, number], tileset: Pick<SideTilesetPayload, "tiles"> | null): SideResolution {
  const [cols, rows] = size;
  const byConfig = new Map<string, string>();
  for (const t of [...(tileset?.tiles ?? [])].sort((a, b) => a.variant - b.variant)) if (!byConfig.has(t.configuration)) byConfig.set(t.configuration, t.tileKey);
  const resolved: (SideConfiguration | null)[] = [];
  const tileKeys: (string | null)[] = [];
  const gaps = new Set<SideConfiguration>();
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const config = sideConfiguration(solid, size, x, y);
      resolved.push(config);
      const key = config ? (byConfig.get(config) ?? null) : null;
      if (config && !key) gaps.add(config);
      tileKeys.push(key);
    }
  }
  return { resolved, tileKeys, gaps: [...gaps].sort() };
}

/**
 * Demonstração lateral (06): plataforma longa, duas bordas, um vão, degraus
 * dos dois lados e os cantos internos correspondentes (12×5; 1 = sólido).
 */
export const SIDE_SAMPLE = {
  size: [12, 5] as [number, number],
  solid: [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0],
    [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1],
    [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1],
  ].flat() as Bit[],
};
