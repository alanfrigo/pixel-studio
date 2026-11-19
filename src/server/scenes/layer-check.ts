import { SceneLayerPayload } from "@/contracts";
import type { Studio } from "../studio";
import { runWorldPython, type WorldOutput } from "../world/python";

/**
 * Bancada do plano de paralaxe: continuidade da repetição medida localmente
 * (bordas opostas × vizinhos internos, limiar declarado) e linha do chão. Um
 * eixo reprovado não vira repetível; repetir em x não promete y.
 */

export const LAYER_SEAM_THRESHOLD = 1.6;

export interface LayerAxisReport {
  seamDelta: number;
  interiorDelta: number;
  ratio: number;
  passed: boolean;
  flagged: { start: number; end: number; maxDelta: number }[];
}

export interface LayerCheckReport {
  size: [number, number];
  threshold: number;
  method: string;
  x: LayerAxisReport | null;
  y: LayerAxisReport | null;
  ground: { y: number; gaps: number; firstGap: number | null; continuous: boolean } | null;
  opaqueFraction: number;
  solidFromY: number | null;
  /** Primeira e última linha com algum pixel visível (alinhar o plano na tela). */
  contentRows: [number, number] | null;
}

export async function runLayerCheck(env: Pick<Studio, "config" | "blobs">, sha256: string, axes: { x: boolean; y: boolean }, ground: boolean, groundLineY: number | null = null) {
  const recipe = (gy: number | null) => ({ axes, threshold: LAYER_SEAM_THRESHOLD, groundLineY: gy, zoom: 2 });
  let run = await runWorldPython(env, "scene_layer_check", [{ role: "source", sha256 }], recipe(groundLineY));
  const first = run.report as unknown as LayerCheckReport;
  if (ground && groundLineY === null && first.solidFromY !== null) {
    // Plano de chão: a linha caminhável é a primeira linha opaca de borda a borda; confere a continuidade nela.
    run = await runWorldPython(env, "scene_layer_check", [{ role: "source", sha256 }], recipe(first.solidFromY));
  }
  return { report: run.report as unknown as LayerCheckReport, warnings: run.warnings, outputs: run.outputs as WorldOutput[] };
}

/** Payload do plano a partir da bancada: só eixos pedidos E aprovados viram repetíveis. */
export function layerCheckPayload(
  report: LayerCheckReport,
  o: {
    fileId: string;
    depth: SceneLayerPayload["depth"];
    obtained: SceneLayerPayload["obtained"];
    requested: { x: boolean; y: boolean };
    derivation: SceneLayerPayload["derivation"];
    groundFromCheck: boolean;
  },
): SceneLayerPayload {
  const [w, h] = report.size;
  const axis = (a: LayerAxisReport | null) => (a ? { method: report.method, threshold: report.threshold, seamDelta: a.seamDelta, interiorDelta: a.interiorDelta, passed: a.passed } : null);
  return SceneLayerPayload.parse({
    fileId: o.fileId,
    rect: [0, 0, w, h],
    logicalSize: [w, h],
    depth: o.depth,
    obtained: o.obtained,
    requestedRepeat: o.requested,
    repeat: { x: o.requested.x && Boolean(report.x?.passed), y: o.requested.y && Boolean(report.y?.passed) },
    continuity: { x: o.requested.x ? axis(report.x) : null, y: o.requested.y ? axis(report.y) : null },
    groundLineY: o.groundFromCheck ? (report.ground?.y ?? null) : null,
    derivation: o.derivation,
  });
}

export function layerVerdict(report: LayerCheckReport, requested: { x: boolean; y: boolean }): string {
  const parts = (["x", "y"] as const)
    .filter((a) => requested[a])
    .map((a) => `${a.toUpperCase()}: ${report[a]?.passed ? "repete" : "não repete"} (emenda/interior ${report[a]?.ratio ?? "?"} ≤ ${report.threshold}?)`);
  const ground = report.ground ? ` · chão em y=${report.ground.y}: ${report.ground.continuous ? "contínuo" : `${report.ground.gaps} px de falha`}` : "";
  return `${parts.join(" · ") || "sem repetição pedida"}${ground}`;
}
