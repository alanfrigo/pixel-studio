import { ButtonPayload, type FocusOrigin, SlotPayload, type StateOrigin, UiState } from "@/contracts";
import type { BlobRecord, PublishFile, RevisionView } from "../catalog/catalog";
import type { Db } from "../db/connection";
import { carryFiles } from "../scenes/revision-files";

/**
 * Próxima revisão de um componente com estados (botão ou slot): mantém os
 * estados existentes com suas origens, substitui/acrescenta os novos (cada um
 * com a própria origem) e recalcula `complete` — nunca marca completo quando
 * falta um estado obrigatório.
 */

export interface StateChange {
  state: UiState;
  blob: BlobRecord;
  origin: StateOrigin;
}

export function nextStatefulPayload(db: Db, base: RevisionView, kind: "button" | "slot", changes: StateChange[], focus?: { blob: BlobRecord; origin: FocusOrigin }) {
  const payload = kind === "button" ? ButtonPayload.parse(base.payload) : SlotPayload.parse(base.payload);
  const [w, h] = payload.logicalSize;
  const replaced = new Set(changes.map((c) => c.state));
  const order = UiState.options;
  const states = [
    ...payload.states.filter((s) => !replaced.has(s.state)),
    ...changes.map((c) => ({ state: c.state, fileId: `state-${c.state}`, rect: [0, 0, w, h] as [number, number, number, number], origin: c.origin })),
  ].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state));
  const present = new Set(states.map((s) => s.state));
  const next = {
    ...payload,
    states,
    complete: payload.requiredStates.every((s) => present.has(s)),
    ...(focus && kind === "button" ? { focus: { mode: "overlay" as const, fileId: "focus", rect: [0, 0, w, h] as [number, number, number, number], origin: focus.origin } } : {}),
  };
  const newKeys = [...changes.map((c) => `state-${c.state}`), ...(focus ? ["focus"] : [])];
  const carried = carryFiles(db, base, "ui", kind, next, { skip: newKeys }).filter((f) => !(focus && f.role === "focus"));
  // (revisão, papel, posição) é único: novos estados entram depois das posições já usadas.
  const nextIdx = (role: string) => Math.max(-1, ...carried.filter((f) => f.role === role).map((f) => f.idx)) + 1;
  const stateIdx = nextIdx("state");
  const files: PublishFile[] = [
    ...carried,
    ...changes.map((c, i) => ({ fileKey: `state-${c.state}`, role: "state", idx: stateIdx + i, blob: c.blob })),
    ...(focus ? [{ fileKey: "focus", role: "focus", idx: nextIdx("focus"), blob: focus.blob }] : []),
  ];
  const missing = payload.requiredStates.filter((s) => !present.has(s));
  return { payload: next, files, missing };
}
