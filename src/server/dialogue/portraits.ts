import { z } from "zod";
import { ExpressionPayload, Id, PixelIndex, PortraitPayload, Rect } from "@/contracts";
import { visemeCompatibility } from "@/domain/dialogue/visemes";
import { tx } from "@/i18n/locales";
import { getAsset, getRevision, publishRevision } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import { fileBlob } from "../scenes/revision-files";
import type { Studio } from "../studio";
import { dataUrl, outputOf, runWorldPython } from "../world/python";
import { DIALOGUE_ROUTE_LABELS } from "./core";

/**
 * Bancada do retrato (cartão D1): revisar âncora facial e regiões do rosto e
 * da boca (nova revisão; a imagem não muda) e comparar duas expressões lado a
 * lado fora da boca. Aprovar continua pelo fluxo de pareceres existente.
 */

export const PortraitReviewInput = z.strictObject({ revisionId: Id, faceAnchor: PixelIndex, faceRect: Rect, mouthRect: Rect });

const inside = (inner: number[], outer: number[]) => inner[0]! >= outer[0]! && inner[1]! >= outer[1]! && inner[0]! + inner[2]! <= outer[0]! + outer[2]! && inner[1]! + inner[3]! <= outer[1]! + outer[3]!;

export function reviewPortrait(studio: Studio, projectId: string, raw: z.input<typeof PortraitReviewInput>) {
  const input = PortraitReviewInput.parse(raw);
  const revision = getRevision(studio.db, projectId, input.revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "portrait" || asset.kind !== "portrait") throw new DomainFailure("validation_failed", tx("A revisão não é um retrato", "The revision is not a portrait"));
  const base = PortraitPayload.parse(revision.payload);
  if (!inside(input.mouthRect, input.faceRect)) {
    throw new DomainFailure("validation_failed", tx("A boca precisa ficar dentro da região do rosto", "The mouth must lie inside the face region"));
  }
  const payload = PortraitPayload.parse({ ...base, faceAnchor: input.faceAnchor, faceRect: input.faceRect, mouthRect: input.mouthRect });
  const previous = (revision.technicalReport ?? {}) as Record<string, unknown>;
  const next = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "edit",
    styleRevisionId: revision.styleRevisionId,
    predecessorId: revision.id,
    payload,
    files: revision.files.map((f) => ({ fileKey: f.fileKey, role: f.role, idx: f.idx, blob: fileBlob(studio.db, f.sha256) })),
    edges: [{ toRevisionId: revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "portrait_review",
      routeLabel: DIALOGUE_ROUTE_LABELS.portraitReview,
      sourceRouteLabel: previous.routeLabel ?? null,
      palette: previous.palette ?? null,
      scale: previous.scale ?? null,
      regions: { faceAnchor: input.faceAnchor, faceRect: input.faceRect, mouthRect: input.mouthRect, reviewed: true },
      warnings: [],
    },
  });
  return { revision: next };
}

export const CompareExpressionsInput = z.strictObject({ a: Id, b: Id });

/** Repouso de duas expressões do mesmo retrato lado a lado, com os pixels alterados fora da boca destacados. */
export async function compareExpressions(studio: Studio, projectId: string, raw: z.input<typeof CompareExpressionsInput>) {
  const input = CompareExpressionsInput.parse(raw);
  const load = (id: string) => {
    const revision = getRevision(studio.db, projectId, id);
    const asset = getAsset(studio.db, projectId, revision.assetId);
    if (asset.family !== "portrait" || asset.kind !== "expression") throw new DomainFailure("validation_failed", tx(`${asset.name} não é uma expressão`, `${asset.name} is not an expression`));
    const payload = ExpressionPayload.parse(revision.payload);
    const rest = payload.visemes.find((v) => v.visemeId === "rest") ?? payload.visemes[0]!;
    const file = revision.files.find((f) => f.fileKey === rest.fileId)!;
    return { revision, payload, rest, file };
  };
  const a = load(input.a);
  const b = load(input.b);
  const portrait = PortraitPayload.parse(getRevision(studio.db, projectId, a.payload.portraitRevisionId).payload);
  if (!portrait.mouthRect) throw new DomainFailure("validation_failed", tx("O retrato não tem a região da boca revisada", "The portrait has no reviewed mouth region"));
  const run = await runWorldPython(studio, "expression_compare", [
    { role: "source", sha256: a.file.sha256 },
    { role: "layer", sha256: b.file.sha256 },
  ], { rectA: a.rest.rect, rectB: b.rest.rect, mouthRect: portrait.mouthRect, zoom: Math.max(1, Math.floor(128 / portrait.logicalSize[1])) });
  const ids = (p: ExpressionPayload) => p.visemes.map((v) => v.visemeId);
  return {
    report: run.report,
    compatibility: visemeCompatibility(ids(a.payload), ids(b.payload)),
    samePortrait: a.payload.portraitRevisionId === b.payload.portraitRevisionId,
    preview: dataUrl(outputOf(run, "compare")),
  };
}
