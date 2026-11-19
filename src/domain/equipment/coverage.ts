import type { Direction } from "@/contracts";
import type { ClipRef, OverlayRef } from "./types";

/**
 * Matriz de cobertura peça × clipe × frame × parte (04 §caso de ponta a
 * ponta): cada peça precisa cobrir os IDs de frames e partes pedidos. Com
 * quatro vistas e ataques de 4 e 6 frames, a cota exige 4 × (4 + 6) = 40 poses
 * por parte. Célula vazia explícita conta como coberta; ausência é lacuna;
 * cobertura de outra revisão do mesmo clipe é "a revisar" (revincular ou refazer).
 */

export type CellState = "covered" | "empty" | "missing" | "stale" | "incompatible";

export interface MatrixColumn {
  action: string;
  direction: Direction;
  stance: string | null;
  clipRevisionId: string;
  clipName: string;
  frameId: string;
}

export interface MatrixRow {
  overlayRevisionId: string;
  overlayName: string;
  /** Parte desenhável, ou `rigid` para os usos de vista rígida. */
  partId: string;
  kind: "part" | "rigid";
}

export interface CoverageMatrix {
  rows: MatrixRow[];
  columns: MatrixColumn[];
  /** `cells[r][c]`. */
  cells: CellState[][];
  counts: { covered: number; empty: number; missing: number; stale: number; incompatible: number; total: number }[];
  totals: { covered: number; empty: number; missing: number; stale: number; incompatible: number; total: number };
}

export interface MatrixInput {
  rigRevisionId: string;
  overlays: readonly Pick<OverlayRef, "revisionId" | "name" | "payload">[];
  /** Clipes resolvidos, um por combinação, na ordem de exibição. */
  combos: readonly { action: string; direction: Direction; stance: string | null; clip: Pick<ClipRef, "revisionId" | "name" | "payload" | "assetId"> }[];
  /** Asset de cada revisão de clipe conhecida (para detectar cobertura de revisão anterior). */
  clipAssetOf: (clipRevisionId: string) => string | undefined;
}

function zero() {
  return { covered: 0, empty: 0, missing: 0, stale: 0, incompatible: 0, total: 0 };
}

export function coverageMatrix(input: MatrixInput): CoverageMatrix {
  const columns: MatrixColumn[] = input.combos.flatMap((c) =>
    c.clip.payload.frames.map((f) => ({ action: c.action, direction: c.direction, stance: c.stance, clipRevisionId: c.clip.revisionId, clipName: c.clip.name, frameId: f.frameId })),
  );
  const clipAsset = new Map(input.combos.map((c) => [c.clip.revisionId, c.clip.assetId]));
  const rows: MatrixRow[] = [];
  const cells: CellState[][] = [];
  const counts: CoverageMatrix["counts"] = [];
  for (const ov of input.overlays) {
    const compatible = ov.payload.rigRevisionId === input.rigRevisionId;
    const rowsOf: { row: MatrixRow; state: (col: MatrixColumn) => CellState }[] = ov.payload.parts.map((part) => ({
      row: { overlayRevisionId: ov.revisionId, overlayName: ov.name, partId: part.partId, kind: "part" as const },
      state: (col: MatrixColumn) => {
        const exact = part.coverage.find((c) => c.clipRevisionId === col.clipRevisionId && c.frameId === col.frameId);
        if (exact) return exact.layer ? "covered" : "empty";
        const asset = clipAsset.get(col.clipRevisionId);
        const older = part.coverage.some((c) => c.frameId === col.frameId && c.clipRevisionId !== col.clipRevisionId && asset !== undefined && input.clipAssetOf(c.clipRevisionId) === asset);
        return older ? "stale" : "missing";
      },
    }));
    if (ov.payload.rigidViews.length > 0) {
      const placements = ov.payload.rigidPlacements ?? [];
      rowsOf.push({
        row: { overlayRevisionId: ov.revisionId, overlayName: ov.name, partId: "rigid", kind: "rigid" },
        state: (col) => {
          const p = placements.find((x) => x.clipRevisionId === col.clipRevisionId && x.frameId === col.frameId);
          if (p) return p.viewId ? "covered" : "empty";
          const asset = clipAsset.get(col.clipRevisionId);
          const older = placements.some((x) => x.frameId === col.frameId && x.clipRevisionId !== col.clipRevisionId && asset !== undefined && input.clipAssetOf(x.clipRevisionId) === asset);
          return older ? "stale" : "missing";
        },
      });
    }
    for (const { row, state } of rowsOf) {
      const line = columns.map((col) => (compatible ? state(col) : "incompatible"));
      const count = zero();
      for (const s of line) {
        count[s] += 1;
        count.total += 1;
      }
      rows.push(row);
      cells.push(line);
      counts.push(count);
    }
  }
  const totals = counts.reduce((acc, c) => {
    for (const k of Object.keys(acc) as (keyof typeof acc)[]) acc[k] += c[k];
    return acc;
  }, zero());
  return { rows, columns, cells, counts, totals };
}
