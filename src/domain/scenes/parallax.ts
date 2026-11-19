/**
 * Paralaxe por eixo (06 §perspectivas, lateral com rolagem). Cada plano tem
 * offset, fator por eixo e repetição por eixo. Com a câmera em `c`, o plano
 * aparece em `offset − ⌊c × fator⌋`; repetido, cobre a tela com cópias de
 * período igual à sua largura/altura. A mesma regra roda no editor, no
 * Python (`scenes.py`) e no consumidor independente.
 */

export interface LayerGeometry {
  size: readonly [number, number];
  offset: readonly [number, number];
  parallax: { x: number; y: number };
  repeat: { x: boolean; y: boolean };
}

/** Canto da cópia-base do plano na tela, em px inteiros. */
export function layerOrigin(layer: LayerGeometry, camera: readonly [number, number]): [number, number] {
  return [layer.offset[0] - Math.floor(camera[0] * layer.parallax.x), layer.offset[1] - Math.floor(camera[1] * layer.parallax.y)];
}

function axisCopies(origin: number, period: number, repeat: boolean, viewport: number): number[] {
  if (!repeat) return [origin];
  const first = origin - period * Math.ceil(origin / period);
  const out: number[] = [];
  for (let p = first; p < viewport; p += period) out.push(p);
  return out;
}

/** Posições (canto superior esquerdo) de todas as cópias do plano que tocam a tela. */
export function layerCopies(layer: LayerGeometry, camera: readonly [number, number], viewport: readonly [number, number]): [number, number][] {
  const [ox, oy] = layerOrigin(layer, camera);
  const xs = axisCopies(ox, layer.size[0], layer.repeat.x, viewport[0]);
  const ys = axisCopies(oy, layer.size[1], layer.repeat.y, viewport[1]);
  return ys.flatMap((y) => xs.map((x): [number, number] => [x, y]));
}

/**
 * Deslocamento horizontal da câmera que faz o plano repetido mais distante
 * (menor fator > 0) percorrer duas larguras próprias. Sem plano repetido,
 * duas larguras da tela.
 */
export function cameraSpan(layers: readonly LayerGeometry[], viewport: readonly [number, number]): number {
  const spans = layers.filter((l) => l.repeat.x && l.parallax.x > 0).map((l) => (2 * l.size[0]) / l.parallax.x);
  return Math.ceil(spans.length ? Math.max(...spans) : 2 * viewport[0]);
}

/** Posições da câmera de 0 a `span` (inclusive), em passos inteiros. */
export function cameraStops(span: number, steps: number): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => Math.round((span * i) / steps));
}

/**
 * Plano da largura da tela (ou maior), sem repetição, que deixa de cobri-la em
 * algum ponto da rolagem (sai por um lado ou deixa faixa vazia do outro).
 * Elementos menores que a tela (sol, nuvem) são finitos por intenção.
 */
export function layerLeavesGap(layer: LayerGeometry, span: number, viewport: readonly [number, number]): boolean {
  if (layer.repeat.x || layer.size[0] < viewport[0]) return false;
  const [x0] = layerOrigin(layer, [0, 0]);
  const [x1] = layerOrigin(layer, [span, 0]);
  return Math.max(x0, x1) > 0 || Math.min(x0, x1) + layer.size[0] < viewport[0];
}
