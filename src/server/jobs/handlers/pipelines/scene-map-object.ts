import { type GenerationPlan, MapObjectPayload } from "@/contracts";
import { type AssetView, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { MAP_OBJECT_ROUTE_LABEL } from "../../../scenes/core";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import { processProviderImage } from "../generation";
import type { PartRow } from "../../queue";
import { mustBlob, partResults, type PipelineEnv, type ProcessedPart } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";

/**
 * Prop independente (cartão T2 · 06 §props independentes): modelo de imagem
 * com alfa ou cor-chave removida localmente. O resultado é candidato com
 * apoio sugerido (base do conteúdo), footprint 1×1 e colisão VAZIA: o prompt
 * não cria colisão confiável; o artista revisa antes de colocar no mapa.
 */

type ObjectPlan = Extract<GenerationPlan, { operation: "generate_map_object" }>;

async function processObject(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  if (plan.operation !== "generate_map_object") throw new Error("inalcançável");
  const p = plan.params;
  // Mesmo caminho do ícone isolado: grade aparente, cor-chave, recorte ao conteúdo e escala inteira.
  const asIcon = { ...plan, operation: "generate_asset", params: { family: "map", kind: "object", logicalSize: p.logicalSize, transparent: true, variants: 1, backgroundKey: p.backgroundKey } } as GenerationPlan;
  return processProviderImage(env, asIcon, sha256, dir);
}

function publishObjects(ctx: HandlerContext, plan: ObjectPlan, asset: AssetView, part: PartRow, perPart: number): string[] {
  const p = plan.params;
  return partResults(ctx, part.part_key)
    .slice(0, perPart)
    .map((row) => {
      const processed = parseJson<ProcessedPart>(row.processed_json)!;
      const [w, h] = [processed.width, processed.height];
      const fit = processed.fit as { offset?: [number, number]; fittedSize?: [number, number] } | null | undefined;
      // Apoio sugerido: centro da base do conteúdo ajustado (não da tela), para revisão.
      const support: [number, number] = fit?.offset && fit.fittedSize ? [Math.round(fit.offset[0] + fit.fittedSize[0] / 2), Math.min(h, fit.offset[1] + fit.fittedSize[1])] : [Math.floor(w / 2), h];
      const payload = MapObjectPayload.parse({
        projection: p.projection,
        fileId: "image",
        rect: [0, 0, w, h],
        logicalSize: [w, h],
        supportPoint: support,
        footprintCells: [1, 1],
        collision: [],
        occlusionAboveY: null,
      });
      return publishRevision(ctx.db, ctx.clock, {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation",
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
        payload,
        files: [
          { fileKey: "image", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
          { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
        ],
        technicalReport: {
          operation: "generate_map_object",
          routeLabel: MAP_OBJECT_ROUTE_LABEL,
          partKey: part.part_key,
          remoteId: part.remote_id,
          requestedSize: p.logicalSize,
          receivedSize: processed.receivedSize,
          partialAlpha: processed.partialAlpha ?? false,
          steps: processed.steps ?? [],
          warnings: [...processed.warnings, "Colisão vazia e footprint 1×1 até revisão: o prompt não cria colisão confiável"],
        },
      }).id;
    });
}

export const sceneMapObjectPipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    if (plan.operation !== "generate_map_object") throw new Error("inalcançável");
    if (asset.family !== "map" || asset.kind !== "object") throw new DomainFailure("validation_failed", `Prop publica em map/object; o asset é ${asset.family}/${asset.kind}`);
  },
  loadInputs: async () => [],
  process: processObject,
  publish: (ctx, plan, asset, part, perPart) => publishObjects(ctx, plan as ObjectPlan, asset, part, perPart),
};
