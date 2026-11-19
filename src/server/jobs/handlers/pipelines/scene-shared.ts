import { readFile } from "node:fs/promises";
import path from "node:path";
import { DomainFailure } from "../../../errors";
import { type PipelineEnv, type ProcessedPart, python, pythonWith } from "./shared";
import type { ProcessResult } from "./types";

/**
 * Peças comuns aos pipelines do cartão T2: levar a imagem recebida à grade
 * lógica sem faixas (grade aparente → cor-chave → recorte central/redução) e
 * ler em bytes as saídas do processador Python.
 */

/**
 * Imagem recebida → tamanho lógico: grade aparente (unzoom), remoção da
 * cor-chave pela matiz da borda (rota sem alfa), recorte central se a
 * proporção vier diferente e redução inteira/por maioria. Sem esticar e sem faixas.
 */
export async function normalizeCanvas(env: PipelineEnv, sha256: string, dir: string, o: { size: [number, number]; key: string | null; alphaThreshold: number | null }): Promise<ProcessResult> {
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  let out = ingest.outputs.find((x) => x.role === "normalized")!;
  const warnings = [...ingest.warnings];
  const steps: Record<string, unknown>[] = [];
  const step = async (name: "unzoom" | "remove_background_flood", recipe: Record<string, unknown>, role: string) => {
    const current = await env.blobs.putFile(out.absolutePath);
    const result = await python(env, path.join(dir, name), name, current.sha256, recipe);
    if (result.status === "error") throw new DomainFailure("validation_failed", `Etapa ${name} falhou: ${result.message}`, { code: result.code });
    out = result.outputs.find((x) => x.role === role)!;
    warnings.push(...result.warnings);
    steps.push({ operation: name, ...result.report });
  };
  // Múltiplo inteiro exato do alvo: a redução direta confere a grade (sem adivinhar célula num degradê).
  const k = out.width! / o.size[0];
  const exactMultiple = Number.isInteger(k) && out.height === o.size[1] * k;
  if ((out.width !== o.size[0] || out.height !== o.size[1]) && !exactMultiple) {
    await step("unzoom", { version: 1, minAgreement: 0.9, ...(o.key ? { ignoreKeyHue: { hueTolerance: 30, minSaturation: 96, minValue: 100 } } : {}) }, "native");
  }
  if (o.key) {
    await step(
      "remove_background_flood",
      { version: 1, color: o.key, tolerance: 0, seeds: { borders: true, points: [] }, connectivity: 4, match: { mode: "hue", hueTolerance: 25, minSaturation: 96, keyFrom: "border" } },
      "cutout",
    );
  }
  const current = await env.blobs.putFile(out.absolutePath);
  const fit = await pythonWith(env, path.join(dir, "fit"), "scene_fit", [{ role: "source", sha256: current.sha256 }], { version: 1, targetSize: o.size, alphaThreshold: o.alphaThreshold });
  if (fit.status === "error") throw new DomainFailure("validation_failed", fit.message, { code: fit.code });
  const fitted = fit.outputs.find((x) => x.role === "fitted")!;
  warnings.push(...fit.warnings);
  steps.push({ operation: "scene_fit", ...fit.report });
  const stored = await env.blobs.putFile(fitted.absolutePath);
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: fitted.width!,
    height: fitted.height!,
    ...(fitted.rgbaSha256 ? { rgbaSha256: fitted.rgbaSha256 } : {}),
    receivedSize: ingest.report.size as [number, number],
    steps,
    warnings,
  };
  return { processed, stored };
}

/** Saída de uma operação Python lida em bytes (para guardar como blob extra). */
export async function outputBytes(result: { outputs: { role: string; key?: string; absolutePath: string; width?: number; height?: number }[] }, role: string, key?: string) {
  const out = result.outputs.find((x) => x.role === role && (key === undefined || x.key === key));
  if (!out) throw new DomainFailure("internal", `Processador não devolveu ${role}`);
  return { bytes: new Uint8Array(await readFile(out.absolutePath)), width: out.width ?? 0, height: out.height ?? 0 };
}
