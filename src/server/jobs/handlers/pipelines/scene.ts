import type { GenerationPlan, SceneLayerPayload, ScenePayload } from "@/contracts";
import { type AssetView, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { SCENE_ROUTE_LABELS } from "../../../scenes/core";
import { layerCheckPayload, runLayerCheck } from "../../../scenes/layer-check";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { normalizeCanvas } from "./scene-shared";
import { mustBlob, partResults, type PipelineEnv, type ProcessedPart } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";
import { scaledReferences } from "./world-texture";

/**
 * Cena ilustrada (cartão T2 · 06 §cenas): `flat_image` publica uma imagem
 * plana rotulada como tal (sem mapa, colisão nem objetos); `layers` gera UM
 * plano declarado por vez (arquivo próprio, repetição validada localmente).
 * Nunca decompõe uma imagem achatada fingindo que é nativo.
 */

type ScenePlan = Extract<GenerationPlan, { operation: "generate_scene" }>;

async function processScene(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string): Promise<ProcessResult> {
  if (plan.operation !== "generate_scene") throw new Error("inalcançável");
  const p = plan.params;
  const layer = p.layer;
  const result = await normalizeCanvas(env, sha256, dir, { size: p.logicalSize, key: layer?.transparent ? (p.backgroundKey ?? null) : null, alphaThreshold: layer?.transparent ? 128 : null });
  if (!layer) return result;
  const check = await runLayerCheck(env, result.stored.sha256, { x: layer.repeatX, y: false }, layer.depth === "ground" || layer.depth === "mid");
  const extraBlobs = [];
  const previews: { role: string; sha256: string }[] = [];
  for (const out of check.outputs) {
    const blob = await env.blobs.putBytes(out.bytes);
    extraBlobs.push({ blob, width: out.width, height: out.height });
    previews.push({ role: out.role, sha256: blob.sha256 });
  }
  const processed: ProcessedPart = { ...result.processed, warnings: [...result.processed.warnings, ...check.warnings], details: { check: check.report, previews } };
  return { processed, stored: result.stored, extraBlobs };
}

function publishScene(ctx: HandlerContext, plan: ScenePlan, asset: AssetView, part: PartRow, perPart: number): string[] {
  const p = plan.params;
  return partResults(ctx, part.part_key)
    .slice(0, perPart)
    .map((row) => {
      const processed = parseJson<ProcessedPart>(row.processed_json)!;
      const [w, h] = [processed.width, processed.height];
      const common = {
        projectId: ctx.job.project_id,
        assetId: asset.id,
        origin: "generation" as const,
        styleRevisionId: plan.styleRevisionId,
        jobAttemptId: ctx.attempt.id,
      };
      const report = {
        operation: "generate_scene",
        partKey: part.part_key,
        remoteId: part.remote_id,
        requestedSize: p.logicalSize,
        receivedSize: processed.receivedSize,
        composition: p.composition ?? null,
        lighting: p.lighting ?? null,
        requiredElements: p.requiredElements,
        steps: processed.steps ?? [],
        warnings: processed.warnings,
      };
      if (!p.layer) {
        const payload: ScenePayload = {
          outputKind: "flat_image",
          projection: p.projection,
          logicalSize: [w, h],
          image: { fileId: "image", rect: [0, 0, w, h] },
          layers: [],
          supportPoints: [],
          characterScale: null,
          groundLineY: null,
          editable: { map: false, collisions: false, objects: false },
          cameraTest: null,
        };
        return publishRevision(ctx.db, ctx.clock, {
          ...common,
          payload,
          files: [
            { fileKey: "image", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
            { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
          ],
          technicalReport: { ...report, routeLabel: SCENE_ROUTE_LABELS.flat, outputKind: "flat_image", notAMap: "Imagem plana: árvores, ponte e chão não são objetos, colisões nem terreno editável" },
        }).id;
      }
      const details = processed.details as { check: Parameters<typeof layerCheckPayload>[0]; previews: { role: string; sha256: string }[] };
      const payload: SceneLayerPayload = layerCheckPayload(details.check, {
        fileId: "layer",
        depth: p.layer.depth,
        obtained: "generated_separately",
        requested: { x: p.layer.repeatX, y: false },
        derivation: null,
        groundFromCheck: p.layer.depth === "ground",
      });
      return publishRevision(ctx.db, ctx.clock, {
        ...common,
        payload,
        files: [
          { fileKey: "layer", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
          { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
          ...details.previews.map((pv, idx) => ({ fileKey: pv.role.replaceAll("_", "-"), role: "preview", idx, blob: mustBlob(ctx.db, pv.sha256) })),
        ],
        technicalReport: { ...report, routeLabel: SCENE_ROUTE_LABELS.layer, layer: p.layer, check: details.check },
      }).id;
    });
}

export const scenePipeline: OperationPipeline = {
  validateTarget({ plan, asset }) {
    if (plan.operation !== "generate_scene") throw new Error("inalcançável");
    const kind = plan.params.layer ? "scene_layer" : "scene";
    if (asset.family !== "map" || asset.kind !== kind) {
      throw new DomainFailure("validation_failed", `${plan.params.layer ? "Plano de paralaxe" : "Cena plana"} publica em map/${kind}; o asset é ${asset.family}/${asset.kind}`);
    }
  },
  loadInputs: (ctx, plan) => scaledReferences(ctx, plan),
  process: processScene,
  publish: (ctx, plan, asset, part, perPart) => publishScene(ctx, plan as ScenePlan, asset, part, perPart),
};
