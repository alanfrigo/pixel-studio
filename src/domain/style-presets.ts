import type { StylePayload } from "@/contracts";

/**
 * Estilo inicial de um projeto novo (01 §primeiro uso com texto puro). O
 * artista ajusta perspectiva, escala e paleta; cada aprovação congela uma nova
 * revisão.
 */
export function defaultStyle(): StylePayload {
  const colors = ["#14141c", "#f4f1e8", "#3c5aa0", "#469632", "#3264c8", "#c82828", "#e0ac69", "#ffd600"];
  return {
    camera: {
      projection: { kind: "top_down", cellSize: [32, 32], tiltDeg: 30 },
      directions: ["N", "E", "S", "W"],
      scroll: "free",
    },
    scale: {
      logicalResolution: [320, 180],
      characterHeightPx: 48,
      uiScale: 1,
      familySizes: { character: [64, 64], item: [16, 16], tileset: [32, 32], vfx: [16, 16] },
    },
    palette: { name: "inicial", policy: "guided", colors: colors.map((hex, index) => ({ index, hex })) },
    lighting: { lightFrom: "NW", shadow: "drop", notes: "Luz do noroeste" },
    outline: { widthPx: 1, policy: "dark" },
    detailDensity: "medium",
    transparency: "binary",
    exceptions: [{ family: "vfx", rule: "partial_alpha", notes: "Efeitos podem usar alfa parcial" }],
    references: [],
    approvedExampleRevisionIds: [],
    briefLanguage: "pt-BR",
  };
}
