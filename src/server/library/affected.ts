import type { ClipPayload, OverlayPayload } from "@/contracts";
import type { Db } from "../db/connection";

/**
 * Rastreio do que depende de quadros alterados (04 §critérios: "eventos e
 * coberturas afetadas são rastreados"). Coberturas e usos de vista rígida de
 * peças (S2) referenciam `(clipRevisionId, frameId)`; a revisão anterior do
 * clipe continua resolvendo, e a nova precisa de revisão dessas peças.
 */

export interface AffectedOverlay {
  assetId: string;
  assetName: string;
  revisionId: string;
  number: number;
  status: string;
  kind: "coverage" | "rigid";
  partId: string | null;
  frameId: string;
}

export interface AffectedReport {
  clipRevisionId: string;
  frameIds: string[];
  events: { eventId: string; frameId: string; kind: string; vfxRevisionId: string | null; audioRevisionId: string | null }[];
  overlays: AffectedOverlay[];
}

export function affectedByFrames(db: Db, projectId: string, clipRevisionId: string, frameIds: string[]): AffectedReport {
  const frames = new Set(frameIds);
  const clipRow = db.get<{ payload_json: string }>("SELECT payload_json FROM asset_revisions WHERE id = :id AND project_id = :p", { id: clipRevisionId, p: projectId });
  const clip = clipRow ? (JSON.parse(clipRow.payload_json) as ClipPayload) : null;
  const events = (clip?.events ?? [])
    .filter((e) => frames.has(e.frameId))
    .map((e) => ({ eventId: e.eventId, frameId: e.frameId, kind: e.kind, vfxRevisionId: e.vfx?.revisionId ?? null, audioRevisionId: e.audio?.revisionId ?? null }));
  const overlays: AffectedOverlay[] = [];
  const rows = db.all<{ id: string; asset_id: string; name: string; number: number; status: string; payload_json: string }>(
    `SELECT r.id, r.asset_id, a.name, r.number, r.status, r.payload_json FROM asset_revisions r JOIN assets a ON a.id = r.asset_id
     WHERE r.project_id = :p AND a.family = 'equipment' AND a.kind = 'overlay' AND r.status != 'rejected' ORDER BY a.name, r.number`,
    { p: projectId },
  );
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as OverlayPayload & { rigidPlacements?: { clipRevisionId: string; frameId: string; viewId: string | null }[] };
    const base = { assetId: row.asset_id, assetName: row.name, revisionId: row.id, number: row.number, status: row.status };
    for (const part of payload.parts ?? []) {
      for (const cell of part.coverage) {
        if (cell.clipRevisionId === clipRevisionId && frames.has(cell.frameId)) overlays.push({ ...base, kind: "coverage", partId: part.partId, frameId: cell.frameId });
      }
    }
    for (const placement of payload.rigidPlacements ?? []) {
      if (placement.clipRevisionId === clipRevisionId && frames.has(placement.frameId)) overlays.push({ ...base, kind: "rigid", partId: placement.viewId, frameId: placement.frameId });
    }
  }
  return { clipRevisionId, frameIds, events, overlays };
}
