import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CostAmount, GenerationPlan } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { validatePlanReferences } from "@/domain/plan/references";
import { type AssetView, type BlobRecord, getAsset, getBlob, publishRevision, recordBlob } from "../../catalog/catalog";
import { catalogLookup } from "../../catalog/plan-lookup";
import { DomainFailure } from "../../errors";
import { getProfileRow } from "../../providers/registry";
import { ProviderError, type ProviderAdapter, type ProviderResult, type SubmitOutcome } from "../../providers/types";
import { runPython } from "../../python/bridge";
import { iso, newId, parseJson, sleep, slugify } from "../../util";
import { type HandlerContext, JobRequests } from "../context";
import { CancelRequestedError, type PartRow } from "../queue";
import { PIPELINES } from "./pipelines";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, python } from "./pipelines/shared";

export type { PipelineEnv } from "./pipelines/shared";
export { processInpaintCandidate } from "./pipelines/inpaint";
import type { ProcessResult } from "./pipelines/types";

/**
 * Geração em etapas (02 §jobs longos): preparo → envio → download →
 * processamento → publicação. Cada parte grava a intenção de envio antes da
 * chamada, o ID remoto ao ser aceita e a resposta bruta assim que chega.
 * Retomar consulta o job remoto ou reaproveita a resposta salva; nunca reenvia
 * uma parte aceita.
 */

export async function generationHandler(ctx: HandlerContext): Promise<void> {
  const request = JobRequests.generation.parse(JSON.parse(ctx.job.request_json));
  const { plan } = request;

  // ---- preparo: tudo que pode bloquear acontece antes de qualquer cobrança ----
  if (canonicalDigest(plan) !== request.planDigest) {
    throw new DomainFailure("validation_failed", "Plano alterado depois de congelado; recalcule o plano");
  }
  if (plan.projectId !== ctx.job.project_id) throw new DomainFailure("cross_project_reference", "Plano de outro projeto");
  const adapter = ctx.providers.adapterFor(plan.providerProfileId);
  const missing = plan.requiredCapabilities.filter((c) => !adapter.capabilities(plan.operation).includes(c));
  if (missing.length > 0) {
    throw new DomainFailure("capability_missing", `O perfil ${plan.providerProfileId} não oferece: ${missing.join(", ")}`, { missing });
  }
  const refIssues = validatePlanReferences(plan, catalogLookup(ctx.db));
  if (refIssues.length > 0) {
    throw new DomainFailure(refIssues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", refIssues[0]!.message, {
      issues: refIssues,
    });
  }
  const asset = getAsset(ctx.db, ctx.job.project_id, request.targetAssetId);
  assertPublishable(ctx, plan, asset);

  ctx.queue.ensureParts(ctx.attempt, plan.parts);
  recordRun(ctx, plan);

  // ---- envio e download por parte ----
  ctx.queue.setStage(ctx.attempt, "submit");
  for (const initial of ctx.queue.parts(ctx.job.id)) {
    let part = initial;
    if (part.remote_state === "completed") continue;

    if (part.remote_state === "sending" || part.remote_state === "uncertain") {
      if (!adapter.idempotentSubmit) {
        // Caiu entre registrar a intenção e o aceite: o provedor pode ter cobrado.
        ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "uncertain" });
        ctx.queue.needsAttention(
          ctx.attempt,
          new DomainFailure("submission_uncertain", "Envio incerto: o provedor pode ter recebido e cobrado este pedido", {
            partKey: part.part_key,
          }),
        );
        return;
      }
      part = ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "not_sent" });
    }

    if (part.remote_state === "not_sent") {
      ctx.checkpoint();
      const outcome = await submitPart(ctx, adapter, plan, part);
      if (outcome === "stopped") return;
      part = outcome;
    }

    if (part.remote_state === "accepted") {
      ctx.queue.setStage(ctx.attempt, "download");
      await awaitAndDownload(ctx, adapter, part);
    }
  }

  // ---- processamento local (idempotente: reaproveita resultados salvos) ----
  ctx.queue.setStage(ctx.attempt, "process");
  for (const part of ctx.queue.parts(ctx.job.id)) {
    if (part.processed_json) continue;
    await processPart(ctx, plan, part);
  }

  // ---- publicação: candidatas + conclusão na mesma transação ----
  ctx.queue.setStage(ctx.attempt, "publish");
  const parts = ctx.queue.parts(ctx.job.id);
  ctx.queue.succeed(ctx.attempt, () => {
    const variants = plan.operation === "generate_asset" ? plan.params.variants : parts.length;
    const perPart = Math.max(1, Math.ceil(variants / parts.length));
    const revisionIds = parts.flatMap((part) => publishPart(ctx, plan, asset, part, perPart));
    const cost = sumCosts(parts);
    ctx.db.run("UPDATE generation_runs SET cost_actual_json = :c WHERE attempt_id = :a", {
      c: cost ? JSON.stringify(cost) : null,
      a: ctx.attempt.id,
    });
    return { assetId: asset.id, revisionIds, cost };
  });
}

function assertPublishable(ctx: HandlerContext, plan: GenerationPlan, asset: AssetView) {
  const pipeline = PIPELINES[plan.operation];
  if (pipeline) return pipeline.validateTarget({ db: ctx.db, projectId: ctx.job.project_id, plan, asset });
  if (plan.operation !== "generate_asset") {
    throw new DomainFailure("capability_missing", `A publicação de ${plan.operation} entra com o cartão responsável`);
  }
  if (plan.params.family !== asset.family || plan.params.kind !== asset.kind) {
    throw new DomainFailure("validation_failed", `Plano gera ${plan.params.family}/${plan.params.kind}, mas o asset é ${asset.family}/${asset.kind}`);
  }
  if (asset.family !== "item") {
    throw new DomainFailure("capability_missing", `Montagem de candidatas da família ${asset.family} entra com o cartão responsável`);
  }
}

function recordRun(ctx: HandlerContext, plan: GenerationPlan) {
  const profile = getProfileRow(ctx.db, plan.providerProfileId);
  ctx.queue.fenced(ctx.attempt, () => {
    const id = newId("run");
    const inserted = ctx.db.run(
      `INSERT OR IGNORE INTO generation_runs (id, job_id, attempt_id, provider_profile_id, profile_snapshot_json, recipe_revision_id,
         brief, prompt_sent, params_json, cost_estimated_json, created_at)
       VALUES (:id, :job, :attempt, :profile, :snapshot, :recipe, :brief, :prompt, :params, :estimate, :now)`,
      {
        id,
        job: ctx.job.id,
        attempt: ctx.attempt.id,
        profile: profile.id,
        // Snapshot sem segredo: só a referência ao nome da variável.
        snapshot: JSON.stringify({ ...profile, config: JSON.parse(profile.config_json), config_json: undefined }),
        recipe: plan.recipeRevisionId,
        brief: plan.prompt.brief,
        prompt: plan.prompt.compiled,
        params: JSON.stringify(plan.params),
        estimate: JSON.stringify(plan.limits.estimate),
        now: iso(ctx.clock.now()),
      },
    );
    if (inserted.changes === 1) {
      plan.sources.forEach((s) =>
        ctx.db.run(
          "INSERT INTO run_inputs (run_id, ordinal, revision_id, file_key, sha256, role) VALUES (:run, :o, :rev, :key, :sha, :role)",
          { run: id, o: s.ordinal, rev: s.revisionId, key: s.fileId, sha: s.sha256, role: s.role },
        ),
      );
    }
  });
}

async function submitPart(ctx: HandlerContext, adapter: ProviderAdapter, plan: GenerationPlan, part: PartRow): Promise<PartRow | "stopped"> {
  // Intenção registrada ANTES da chamada remota.
  ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "sending", error_json: null }, { countSubmission: true });
  let outcome: SubmitOutcome;
  try {
    outcome = await adapter.submit(
      {
        idempotencyKey: `${ctx.job.id}:${part.part_key}`,
        operation: plan.operation,
        prompt: plan.prompt.compiled,
        params: plan.params as Record<string, unknown>,
        references: PIPELINES[plan.operation] ? await PIPELINES[plan.operation]!.loadInputs(ctx, plan, adapter) : await loadReferences(ctx, plan),
      },
      ctx.signal,
    );
  } catch (err) {
    const error = err instanceof ProviderError ? err : new ProviderError("ambiguous", err instanceof Error ? err.message : String(err));
    const errorJson = JSON.stringify({ kind: error.kind, message: error.message });
    if (error.kind === "ambiguous") {
      if (adapter.idempotentSubmit) {
        ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "not_sent", error_json: errorJson });
        throw new DomainFailure("provider_unavailable", `Falha ambígua no envio; o provedor deduplica pela chave: ${error.message}`);
      }
      ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "uncertain", error_json: errorJson });
      ctx.queue.needsAttention(
        ctx.attempt,
        new DomainFailure("submission_uncertain", `Envio incerto: ${error.message}. O provedor pode ter recebido e cobrado o pedido.`, {
          partKey: part.part_key,
        }),
      );
      return "stopped";
    }
    ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: error.kind === "rejected" ? "rejected" : "not_sent", error_json: errorJson });
    throw providerFailure(error);
  }
  if (outcome.kind === "async") {
    // HTTP 200/202 com job remoto: aceito, não concluído.
    return ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "accepted", remote_id: outcome.remoteId });
  }
  // Resposta síncrona sem ID remoto: grava os bytes já, antes de qualquer outra coisa.
  return storeResults(ctx, part.part_key, outcome, null);
}

/** Fontes congeladas no plano, em ordem, com bytes conferidos pelo hash. */
/** Lado mínimo enviado: sprites pequenos sobem por fator inteiro (vizinho mais próximo, sem detalhe novo). */
const MIN_REFERENCE_SIDE = 256;
const MAX_REFERENCE_SIDE = 2048;

/** Fontes congeladas no plano, em ordem, com bytes conferidos pelo hash. */
async function loadReferences(ctx: HandlerContext, plan: GenerationPlan) {
  const refs = [];
  for (const source of plan.sources) {
    if (source.fileId === null) continue; // revisões só de dados (ex.: movimento) seguem nos parâmetros
    const blob = getBlob(ctx.db, source.sha256);
    const { width = 0, height = 0 } = (blob?.metadata ?? {}) as { width?: number; height?: number };
    let bytes = await ctx.blobs.read(source.sha256);
    const key = plan.operation === "generate_asset" ? (plan.params.backgroundKey ?? null) : null;
    // Alguns provedores exigem os dois lados ≥ 256 px (Black Forest Labs: 422 abaixo disso).
    const small = width > 0 && Math.min(width, height) < MIN_REFERENCE_SIDE;
    if (blob?.mime === "image/png" && width > 0 && (small || key)) {
      const factor = small ? Math.max(1, Math.min(Math.ceil(MIN_REFERENCE_SIDE / Math.min(width, height)), Math.floor(MAX_REFERENCE_SIDE / Math.max(width, height)))) : 1;
      const dir = path.join(ctx.workDir, "refs", String(source.ordinal));
      await mkdir(path.join(dir, "in"), { recursive: true });
      await writeFile(path.join(dir, "in", "source"), bytes);
      const scaled = await runPython(
        {
          protocolVersion: 1,
          jobId: ctx.job.id,
          attemptId: ctx.attempt.id,
          operation: "make_thumbnail",
          inputs: [{ ordinal: 0, role: "source", sha256: source.sha256, relPath: "in/source" }],
          recipe: { version: 1, maxSize: Math.max(width, height) * factor, ...(key ? { flattenOnto: key } : {}) },
        },
        { python: ctx.config.python, workDir: dir, timeoutMs: ctx.config.pythonTimeoutMs, signal: ctx.signal },
      );
      if (scaled.status === "error") throw new DomainFailure("internal", `Falha ao ampliar referência: ${scaled.message}`);
      bytes = new Uint8Array(await readFile(scaled.outputs[0]!.absolutePath));
    }
    refs.push({ role: source.role, mime: blob?.mime ?? "image/png", bytes });
  }
  return refs;
}

function providerFailure(error: ProviderError): DomainFailure {
  switch (error.kind) {
    case "auth":
      return new DomainFailure("provider_auth", `Credencial recusada pelo provedor: ${error.message}`);
    case "balance":
      return new DomainFailure("provider_balance", `Saldo insuficiente no provedor: ${error.message}`);
    case "rejected":
      return new DomainFailure("provider_rejected", `Pedido recusado pelo provedor: ${error.message}`);
    default:
      return new DomainFailure("provider_unavailable", error.message, error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : undefined);
  }
}

async function awaitAndDownload(ctx: HandlerContext, adapter: ProviderAdapter, part: PartRow) {
  const remoteId = part.remote_id!;
  try {
    for (;;) {
      ctx.checkpoint();
      const status = await adapter.poll(remoteId, ctx.signal);
      if (status.state === "succeeded") break;
      if (status.state === "failed") {
        ctx.queue.updatePart(ctx.attempt, part.part_key, { remote_state: "rejected", error_json: JSON.stringify({ message: status.message }) });
        throw new DomainFailure("provider_rejected", `O provedor não concluiu a parte ${part.part_key}: ${status.message}`);
      }
      await sleep(adapter.pollIntervalMs, ctx.signal);
    }
  } catch (err) {
    if (err instanceof CancelRequestedError) {
      await adapter.cancel?.(remoteId).catch(() => undefined);
      throw new CancelRequestedError(ctx.job.id, {
        remoteCancelRequested: Boolean(adapter.cancel),
        note: "A parte já aceita pelo provedor pode ser cobrada mesmo cancelada",
        partKey: part.part_key,
      });
    }
    if (err instanceof ProviderError) {
      // Falha ao consultar não invalida o job remoto: nova tentativa volta a consultar, sem reenviar.
      throw new DomainFailure("provider_unavailable", `Falha ao consultar o job remoto: ${err.message}`, err.retryAfterMs ? { retryAfterMs: err.retryAfterMs } : undefined);
    }
    throw err;
  }
  let result: ProviderResult;
  try {
    result = await adapter.fetchResult(remoteId, ctx.signal);
  } catch (err) {
    if (err instanceof ProviderError) throw new DomainFailure("provider_unavailable", `Falha ao baixar o resultado: ${err.message}`);
    throw err;
  }
  await storeResults(ctx, part.part_key, result, remoteId);
}

/** Persiste a resposta bruta (todas as imagens) assim que chega; a partir daqui, retomar não fala com o provedor. */
async function storeResults(ctx: HandlerContext, partKey: string, result: ProviderResult, remoteId: string | null): Promise<PartRow> {
  if (result.images.length === 0) {
    ctx.queue.updatePart(ctx.attempt, partKey, { remote_state: "rejected", error_json: JSON.stringify({ message: "Resposta sem imagem" }) });
    throw new DomainFailure("provider_rejected", "O provedor respondeu sem nenhuma imagem");
  }
  const blobs: BlobRecord[] = [];
  for (const [index, image] of result.images.entries()) {
    const stored = await ctx.blobs.putBytes(image.bytes);
    blobs.push({ sha256: stored.sha256, bytes: stored.bytes, mime: image.mime, modality: "raster", metadata: { source: "provider_raw", remoteId, index } });
  }
  return ctx.queue.fenced(
    ctx.attempt,
    () => {
      blobs.forEach((blob, idx) => {
        recordBlob(ctx.db, ctx.clock, blob);
        ctx.db.run(
          `INSERT OR REPLACE INTO job_part_results (job_id, part_key, idx, blob_sha256, mime) VALUES (:job, :part, :idx, :sha, :mime)`,
          { job: ctx.job.id, part: partKey, idx, sha: blob.sha256, mime: blob.mime },
        );
      });
      return ctx.queue.updatePart(ctx.attempt, partKey, {
        remote_state: "completed",
        raw_blob_sha256: blobs[0]!.sha256,
        raw_mime: blobs[0]!.mime,
        cost_json: result.cost ? JSON.stringify(result.cost) : null,
      });
    },
    { allowCancelRequested: true },
  );
}

/**
 * Pipeline de uma imagem recebida: normaliza, recupera a grade, remove a
 * cor-chave e ajusta à escala lógica. Exportado para reprocessar avaliações.
 */
export async function processProviderImage(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string) {
  if (plan.operation !== "generate_asset") throw new Error("inalcançável");
  const [lw, lh] = plan.params.logicalSize;
  const ingest = await python(env, path.join(dir, "ingest"), "ingest_inspect", sha256, { version: 1, limits: env.config.rasterLimits });
  if (ingest.status === "error") {
    throw new DomainFailure("validation_failed", `Resposta do provedor não é uma imagem utilizável: ${ingest.message}`, { code: ingest.code });
  }
  let out = ingest.outputs.find((o) => o.role === "normalized")!;
  const warnings = [...ingest.warnings];
  const steps: Record<string, unknown>[] = [];
  let fit: Record<string, unknown> | null = null;
  const key = plan.params.backgroundKey ?? null;
  /** Etapa local encadeada: grava a saída atual e roda a próxima operação sobre ela. */
  const step = async (name: "unzoom" | "remove_background_flood" | "fit_logical", recipe: Record<string, unknown>, role: string) => {
    const current = await env.blobs.putFile(out.absolutePath);
    const result = await python(env, path.join(dir, name), name, current.sha256, recipe);
    if (result.status === "error") throw new DomainFailure("validation_failed", `Etapa ${name} falhou: ${result.message}`, { code: result.code });
    out = result.outputs.find((o) => o.role === role)!;
    warnings.push(...result.warnings);
    steps.push({ operation: name, ...result.report });
    return result.report;
  };
  if (out.width !== lw || out.height !== lh) {
    // 1. Grade aparente: modelos desenham pixel art numa célula própria (às vezes fracionária).
    await step(
      "unzoom",
      {
        version: 1,
        minAgreement: 0.9,
        // Objeto isolado: uma grade que deixaria o objeto com menos da metade do tamanho pedido é grossa demais.
        ...(key || plan.params.transparent ? { minContentCells: Math.ceil(Math.max(lw, lh) / 2) } : {}),
        ...(key ? { ignoreKeyHue: { hueTolerance: 30, minSaturation: 96, minValue: 100 } } : {}),
      },
      "native",
    );
  }
  if (key) {
    // 2. Rota sem alfa: remove a cor-chave (e a sombra dela) pela matiz medida na borda.
    await step(
      "remove_background_flood",
      {
        version: 1,
        color: key,
        tolerance: 0,
        seeds: { borders: true, points: [] },
        connectivity: 4,
        match: { mode: "hue", hueTolerance: 25, minSaturation: 96, keyFrom: "border" },
      },
      "cutout",
    );
  }
  const isolated = Boolean(key) || plan.params.transparent;
  if (out.width !== lw || out.height !== lh || isolated) {
    // 3. Ícone isolado: alfa binário, recorte ao conteúdo e escala lógica (ampliação só inteira).
    fit = await step(
      "fit_logical",
      { version: 1, targetSize: [lw, lh], ...(isolated ? { cropToContent: { padding: 0 }, alphaThreshold: 128 } : {}) },
      "fitted",
    );
  }
  const stored = await env.blobs.putFile(out.absolutePath);
  const processed: ProcessedPart = {
    normalizedSha256: stored.sha256,
    width: out.width!,
    height: out.height!,
    ...(out.rgbaSha256 ? { rgbaSha256: out.rgbaSha256 } : {}),
    partialAlpha: Boolean(ingest.report.partialAlpha),
    receivedSize: ingest.report.size as [number, number],
    fit,
    steps,
    warnings,
  };
  return { processed, stored };
}

/** Normaliza cada imagem recebida e, se preciso, a reduz para a escala lógica. Idempotente por resultado. */
async function processPart(ctx: HandlerContext, plan: GenerationPlan, part: PartRow) {
  const env = envOf(ctx);
  for (const row of partResults(ctx, part.part_key)) {
    if (row.processed_json) continue;
    ctx.checkpoint();
    const dir = path.join(ctx.workDir, safeSegment(part.part_key), String(row.idx));
    const pipeline = PIPELINES[plan.operation];
    const result: ProcessResult = pipeline ? await pipeline.process(env, plan, row.blob_sha256, dir) : await processProviderImage(env, plan, row.blob_sha256, dir);
    const { processed, stored } = result;
    ctx.queue.fenced(ctx.attempt, () => {
      recordBlob(ctx.db, ctx.clock, {
        sha256: stored.sha256,
        bytes: stored.bytes,
        mime: "image/png",
        modality: "raster",
        metadata: { width: processed.width, height: processed.height, rgbaSha256: processed.rgbaSha256 },
      });
      for (const extra of result.extraBlobs ?? []) {
        // Saídas auxiliares (candidato de inpainting, frames, guias) ficam registradas para publicação e comparação.
        recordBlob(ctx.db, ctx.clock, {
          sha256: extra.blob.sha256,
          bytes: extra.blob.bytes,
          mime: "image/png",
          modality: "raster",
          metadata: { width: extra.width, height: extra.height },
        });
      }
      ctx.db.run("UPDATE job_part_results SET processed_json = :p WHERE job_id = :job AND part_key = :part AND idx = :idx", {
        p: JSON.stringify(processed),
        job: ctx.job.id,
        part: part.part_key,
        idx: row.idx,
      });
    });
  }
  ctx.queue.updatePart(ctx.attempt, part.part_key, { processed_json: JSON.stringify({ results: partResults(ctx, part.part_key).length }) });
}

/** Uma candidata por imagem recebida, até o número de variantes pedido por parte; o resto fica guardado como resposta bruta. */
function publishPart(ctx: HandlerContext, plan: GenerationPlan, asset: AssetView, part: PartRow, perPart: number): string[] {
  const pipeline = PIPELINES[plan.operation];
  if (pipeline) return pipeline.publish(ctx, plan, asset, part, perPart);
  if (plan.operation !== "generate_asset") throw new Error("inalcançável");
  const rows = partResults(ctx, part.part_key);
  const [lw, lh] = plan.params.logicalSize;
  return rows.slice(0, perPart).map((row) => {
    const processed = parseJson<ProcessedPart>(row.processed_json)!;
    const [w, h] = [processed.width, processed.height];
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      payload: {
        itemKey: slugify(asset.name),
        representations: [
          { role: "icon", state: "default", fileId: "image", rect: [0, 0, w, h], sourceOffset: [0, 0], logicalSize: [w, h], pivot: [Math.floor(w / 2), Math.floor(h / 2)] },
        ],
      },
      files: [
        { fileKey: "image", role: "normalized", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) },
        { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) },
      ],
      technicalReport: {
        partKey: part.part_key,
        resultIndex: row.idx,
        candidatesInPart: rows.length,
        remoteId: part.remote_id,
        requestedSize: [lw, lh],
        receivedSize: processed.receivedSize ?? [w, h],
        sizeMatches: w === lw && h === lh,
        fittedToLogical: processed.fit,
        steps: processed.steps ?? [],
        partialAlpha: processed.partialAlpha ?? false,
        warnings: processed.warnings,
      },
    });
    return revision.id;
  });
}

function sumCosts(parts: PartRow[]): CostAmount[] | null {
  const totals = new Map<string, number>();
  for (const p of parts) {
    const c = parseJson<CostAmount>(p.cost_json);
    if (c) totals.set(c.unit, (totals.get(c.unit) ?? 0) + c.amount);
  }
  return totals.size ? [...totals].map(([unit, amount]) => ({ unit, amount })) : null;
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

