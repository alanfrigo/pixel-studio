import { exportBlockers } from "@/domain/equipment/resolve";
import { describeWhere, type Pendency } from "@/domain/equipment/types";
import type { Db } from "../db/connection";
import { resolveLoadoutRevision } from "./resolve";

/**
 * Verificador de conjuntos na exportação (04 §critérios: "remover a manga de
 * um frame em uma vista e exportar o conjunto completo: o verificador aponta
 * peça, direção, ação, postura e frame exatos"). Só os conjuntos da seleção
 * (e do fecho) são verificados; cada um contra o seu próprio snapshot, então a
 * lacuna de um conjunto não bloqueia outro.
 */

export interface LoadoutExportProblem extends Pendency {
  loadoutRevisionId: string;
  loadoutName: string;
  /** Texto do ponteiro exato, para a mensagem de erro. */
  pointer: string;
}

export function equipmentExportProblems(db: Db, projectId: string, revisionIds: readonly string[]): LoadoutExportProblem[] {
  const problems: LoadoutExportProblem[] = [];
  for (const id of revisionIds) {
    const row = db.get<{ family: string; kind: string }>(
      "SELECT a.family, a.kind FROM asset_revisions r JOIN assets a ON a.id = r.asset_id WHERE r.id = :id AND r.project_id = :p",
      { id, p: projectId },
    );
    if (row?.family !== "equipment" || row.kind !== "loadout") continue;
    const ctx = resolveLoadoutRevision({ db }, projectId, id);
    for (const p of exportBlockers(ctx.resolution)) {
      problems.push({ ...p, loadoutRevisionId: id, loadoutName: ctx.loadout?.name ?? id, pointer: describeWhere(p.where) });
    }
  }
  return problems;
}

export function exportProblemMessage(problems: readonly LoadoutExportProblem[]): string {
  const first = problems[0]!;
  const more = problems.length > 1 ? ` (+${problems.length - 1} pendência(s))` : "";
  return `${first.loadoutName}: ${first.message} — ${first.pointer}${more}. Exporte um subconjunto explicitamente completo ou resolva a pendência.`;
}
