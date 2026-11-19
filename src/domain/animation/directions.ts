import { CARDINAL_4, DIRECTIONS_8, type Direction, type ProjectionKind, type WorldToViewMap } from "@/contracts";
import { isoWorldToView } from "@/domain/projection";

/**
 * Direções e vistas (04 §gerar quatro/oito vistas e orientar no isométrico).
 *
 * - Rotação é arte nova da direção do sujeito: nunca bitmap girado.
 * - Vista ausente continua ausente: espelho só existe como derivação local
 *   autorizada por par explícito, nunca implícito (escudo, marca lateral e luz
 *   direcional trocariam de lado).
 * - Isométrico guarda direção no mundo → vista projetada na tela; na projeção
 *   de referência as quatro cardinais do mundo usam vistas diagonais.
 */

export const DIRECTION_LABEL: Record<Direction, string> = {
  N: "norte",
  NE: "nordeste",
  E: "leste",
  SE: "sudeste",
  S: "sul",
  SW: "sudoeste",
  W: "oeste",
  NW: "noroeste",
};

const DIRECTION_EN: Record<Direction, string> = {
  N: "north",
  NE: "north-east",
  E: "east",
  SE: "south-east",
  S: "south",
  SW: "south-west",
  W: "west",
  NW: "north-west",
};

/** Como a direção aparece na tela (top-down/lateral), para o prompt. Sem cores nem códigos. */
export function facingPhrase(direction: Direction, language: "pt-BR" | "en"): string {
  const screenPt: Record<Direction, string> = {
    N: "de costas para quem olha, virado para o alto da tela",
    NE: "de costas, em diagonal para o canto superior direito da tela",
    E: "de perfil, virado para a direita da tela",
    SE: "de frente, em diagonal para o canto inferior direito da tela",
    S: "de frente para quem olha, virado para baixo na tela",
    SW: "de frente, em diagonal para o canto inferior esquerdo da tela",
    W: "de perfil, virado para a esquerda da tela",
    NW: "de costas, em diagonal para o canto superior esquerdo da tela",
  };
  const screenEn: Record<Direction, string> = {
    N: "seen from behind, facing the top of the screen",
    NE: "seen from behind, facing diagonally toward the top-right of the screen",
    E: "in profile, facing the right side of the screen",
    SE: "facing the viewer diagonally toward the bottom-right of the screen",
    S: "facing the viewer, toward the bottom of the screen",
    SW: "facing the viewer diagonally toward the bottom-left of the screen",
    W: "in profile, facing the left side of the screen",
    NW: "seen from behind, facing diagonally toward the top-left of the screen",
  };
  return language === "en" ? `facing ${DIRECTION_EN[direction]} (${screenEn[direction]})` : `voltado para ${DIRECTION_LABEL[direction]} (${screenPt[direction]})`;
}

export function identityWorldToView(): WorldToViewMap {
  return Object.fromEntries(DIRECTIONS_8.map((d) => [d, d])) as WorldToViewMap;
}

/** Orientação padrão da projeção: isométrico usa a tabela de referência; demais, a própria direção. */
export function orientationFor(projection: ProjectionKind): { projection: ProjectionKind; worldToView: WorldToViewMap } {
  return { projection, worldToView: projection === "isometric" ? isoWorldToView() : identityWorldToView() };
}

/** Vista que o consumidor desenha para um movimento no mundo. */
export function viewForWorld(world: Direction, orientation?: { worldToView: WorldToViewMap } | null): Direction {
  return orientation?.worldToView[world] ?? world;
}

/**
 * Vistas a gerar para um conjunto de 4 ou 8 direções no mundo. No isométrico
 * de referência as quatro cardinais do mundo pedem as quatro diagonais da tela.
 */
export function viewSet(count: 4 | 8, projection: ProjectionKind): Direction[] {
  if (count === 8) return [...DIRECTIONS_8];
  const orientation = orientationFor(projection);
  return CARDINAL_4.map((d) => viewForWorld(d, orientation));
}

export type ViewResolution =
  | { kind: "view"; direction: Direction }
  | { kind: "mirror"; direction: Direction; from: Direction }
  | { kind: "missing"; direction: Direction; reason: string };

/**
 * De onde vem a arte da direção pedida. Sem a vista, a resposta é `missing`
 * mesmo que a oposta exista: o espelho só vale com par explícito e revisado.
 */
export function resolveView(
  direction: Direction,
  views: readonly { direction: Direction }[],
  mirror: { policy: "none" } | { policy: "explicit"; pairs: { source: Direction; target: Direction }[] } = { policy: "none" },
): ViewResolution {
  if (views.some((v) => v.direction === direction)) return { kind: "view", direction };
  if (mirror.policy === "explicit") {
    const pair = mirror.pairs.find((p) => p.target === direction && views.some((v) => v.direction === p.source));
    if (pair) return { kind: "mirror", direction, from: pair.source };
  }
  return { kind: "missing", direction, reason: `Sem vista ${direction} aprovada; gere a vista (arte nova) — espelho não é implícito` };
}

/** Diagonais mais próximas primeiro: a melhor vista aprovada para servir de fonte de uma nova direção. */
export function closestView(target: Direction, available: readonly Direction[]): Direction | null {
  if (available.length === 0) return null;
  const idx = (d: Direction) => DIRECTIONS_8.indexOf(d);
  const dist = (d: Direction) => {
    const diff = Math.abs(idx(d) - idx(target)) % 8;
    return Math.min(diff, 8 - diff);
  };
  // Empate: preferir a vista frontal (S), depois a ordem da lista.
  return [...available].sort((a, b) => dist(a) - dist(b) || (a === "S" ? -1 : b === "S" ? 1 : 0))[0]!;
}
