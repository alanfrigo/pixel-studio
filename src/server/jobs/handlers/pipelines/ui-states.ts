import path from "node:path";
import type { GenerationPlan, UiState, UiStateSheet } from "@/contracts";
import { stateSheetCells } from "@/domain/ui-geometry";
import { type TextValue, tx } from "@/i18n/locales";
import { getAsset, getRevision, publishRevision } from "../../../catalog/catalog";
import { DomainFailure } from "../../../errors";
import { nextStatefulPayload, type StateChange } from "../../../ui/component-revision";
import { UI_ROUTE_LABELS } from "../../../ui/core";
import { parseJson } from "../../../util";
import type { HandlerContext } from "../../context";
import type { PartRow } from "../../queue";
import { guideScale } from "./room";
import { normalizeCanvas, outputBytes } from "./scene-shared";
import { envOf, mustBlob, partResults, type PipelineEnv, type ProcessedPart, pythonWith } from "./shared";
import type { OperationPipeline, ProcessResult } from "./types";

/**
 * Estados de UI por imagem + referência (cartão U3 · 07 §estados). Cada
 * componente aprovado vai numa folha-guia (célula 1 = estado-base; demais =
 * moldura cinza); o modelo repinta a mesma peça em cada célula. Localmente, a
 * folha volta à grade lógica, cada célula é recortada (só translação inteira é
 * corrigida) e conferida contra o estado-base. NÃO é geração nativa de
 * estados: a origem de cada estado fica registrada como derivada da referência.
 */

type StatesPlan = Extract<GenerationPlan, { operation: "generate_ui_states" }>;

function statesPlan(plan: GenerationPlan): StatesPlan & { params: { sheets: UiStateSheet[]; backgroundKey: string } } {
  if (plan.operation !== "generate_ui_states" || !plan.params.sheets || !plan.params.backgroundKey) throw new Error("inalcançável");
  return plan as never;
}

function sheetOf(plan: GenerationPlan, part?: PartRow): { sheet: UiStateSheet; index: number } {
  const p = statesPlan(plan);
  const index = part ? Number(part.part_key.split(":")[1]) : 0;
  const sheet = p.params.sheets[index];
  if (!sheet) throw new DomainFailure("internal", tx(`Parte ${part?.part_key} sem folha no plano`, `Part ${part?.part_key} has no sheet in the plan`));
  return { sheet, index };
}

function baseSha(plan: StatesPlan, sheet: UiStateSheet): string {
  const source = plan.sources.find((s) => s.revisionId === sheet.componentRevisionId);
  if (!source) throw new DomainFailure("internal", tx("Estado-base não congelado nas fontes do plano", "Base state not frozen in the plan sources"));
  return source.sha256;
}

async function loadStatesInputs(ctx: HandlerContext, plan: GenerationPlan, _adapter: unknown, part?: PartRow) {
  const p = statesPlan(plan);
  const { sheet, index } = sheetOf(plan, part);
  const cells = stateSheetCells(sheet, sheet.states.length + 1);
  const run = await pythonWith(envOf(ctx), path.join(ctx.workDir, `ui-state-guide-${index}`), "ui_state_guide", [{ role: "source", sha256: baseSha(p, sheet) }], {
    version: 1,
    sheetSize: sheet.sheetSize,
    scale: guideScale(sheet.sheetSize),
    backgroundKey: p.params.backgroundKey,
    cells,
  });
  if (run.status === "error") throw new DomainFailure("validation_failed", run.message, { code: run.code });
  const guide = await outputBytes(run, "guide");
  return [{ role: "base", mime: "image/png", bytes: guide.bytes }];
}

async function processStates(env: PipelineEnv, plan: GenerationPlan, sha256: string, dir: string, part?: PartRow): Promise<ProcessResult> {
  const p = statesPlan(plan);
  const { sheet } = sheetOf(plan, part);
  const result = await normalizeCanvas(env, sha256, dir, { size: sheet.sheetSize, key: p.params.backgroundKey, alphaThreshold: 128 });
  const cells = stateSheetCells(sheet, sheet.states.length + 1);
  const check = await pythonWith(
    env,
    path.join(dir, "check"),
    "ui_state_sheet",
    [
      { role: "source", sha256: baseSha(p, sheet) },
      { role: "candidate", sha256: result.stored.sha256 },
    ],
    {
      version: 1,
      cell: sheet.cell,
      cells: sheet.states.map((state, i) => ({ state, rect: cells[i + 1]! })),
      nineSlice: null,
      contentPadding: sheet.contentPadding ?? null,
      searchPx: Math.min(8, sheet.gapPx),
      outlineTolerance: 0.25,
    },
  );
  if (check.status === "error") throw new DomainFailure("validation_failed", check.message, { code: check.code });
  const extras = [];
  const states: { state: UiState; sha256: string }[] = [];
  for (const state of sheet.states) {
    const out = await outputBytes(check, "state", state);
    const blob = await env.blobs.putBytes(out.bytes);
    extras.push({ blob, width: out.width, height: out.height });
    states.push({ state, sha256: blob.sha256 });
  }
  const processed: ProcessedPart = {
    ...result.processed,
    warnings: [...result.processed.warnings, ...check.warnings],
    steps: [...(result.processed.steps ?? []), { operation: "ui_state_sheet", ...check.report }],
    details: { states, check: check.report },
  };
  return { processed, stored: result.stored, extraBlobs: extras };
}

interface SheetCheck {
  states: { state: UiState; found: "aligned" | "missing" | "size_mismatch"; shift: [number, number]; passed: boolean; checks: Record<string, boolean>; silhouetteIoU: number; outlineMatch: number; centerCoverage: number }[];
}

/** Publica na última parte: uma revisão candidata por componente, com todos os estados conferidos da folha dele. */
function publishStates(ctx: HandlerContext, plan: GenerationPlan, part: PartRow): string[] {
  if (part.part_key !== plan.parts.at(-1)!.partKey) return [];
  const p = statesPlan(plan);
  const ids: string[] = [];
  p.params.sheets.forEach((sheet, index) => {
    const [row] = partResults(ctx, `component:${index}`);
    const base = getRevision(ctx.db, ctx.job.project_id, sheet.componentRevisionId);
    const asset = getAsset(ctx.db, ctx.job.project_id, base.assetId);
    if (!row) throw new DomainFailure("provider_rejected", tx(`O provedor não devolveu a folha de ${asset.name}`, `The provider returned no sheet for ${asset.name}`));
    const processed = parseJson<ProcessedPart>(row.processed_json)!;
    const details = processed.details as { states: { state: UiState; sha256: string }[]; check: SheetCheck };
    const checks = new Map(details.check.states.map((s) => [s.state, s]));
    // Estado ausente ou fora da célula não entra: o componente fica incompleto (estados parcialmente falhos não completam o kit).
    const usable = details.states.filter((s) => checks.get(s.state)?.found === "aligned");
    const skipped = details.states.filter((s) => checks.get(s.state)?.found !== "aligned").map((s) => s.state);
    const changes: StateChange[] = usable.map((s) => ({
      state: s.state,
      blob: mustBlob(ctx.db, s.sha256),
      origin: { kind: "generated_reference", referenceRevisionId: base.id, referenceState: sheet.baseState },
    }));
    const kind = asset.kind as "button" | "slot";
    const next = nextStatefulPayload(ctx.db, base, kind, changes);
    const warnings: TextValue[] = [...processed.warnings];
    if (skipped.length) warnings.push(tx(`Estados não aproveitados (ausentes ou fora da célula): ${skipped.join(", ")}`, `States not used (missing or off-cell): ${skipped.join(", ")}`));
    if (next.missing.length) warnings.push(tx(`Componente incompleto: faltam ${next.missing.join(", ")}`, `Component incomplete: missing ${next.missing.join(", ")}`));
    const revision = publishRevision(ctx.db, ctx.clock, {
      projectId: ctx.job.project_id,
      assetId: asset.id,
      origin: "generation",
      styleRevisionId: plan.styleRevisionId,
      jobAttemptId: ctx.attempt.id,
      predecessorId: base.id,
      payload: next.payload,
      files: [...next.files, { fileKey: "raw", role: "raw", idx: 0, blob: mustBlob(ctx.db, row.blob_sha256) }, { fileKey: "sheet", role: "preview", idx: 0, blob: mustBlob(ctx.db, processed.normalizedSha256) }],
      edges: [{ toRevisionId: base.id, role: "reference", ordinal: 0, runtime: false }],
      technicalReport: {
        operation: "generate_ui_states",
        routeLabel: UI_ROUTE_LABELS.states,
        partKey: `component:${index}`,
        remoteId: part.remote_id,
        referenceRevisionId: base.id,
        referenceState: sheet.baseState,
        generated: usable.map((s) => s.state),
        skipped,
        checks: details.check.states,
        complete: next.payload.complete,
        missing: next.missing,
        steps: processed.steps ?? [],
        warnings,
      },
    });
    ids.push(revision.id);
  });
  return ids;
}

export const uiStatesPipeline: OperationPipeline = {
  validateTarget({ db, projectId, plan, asset }) {
    const p = statesPlan(plan);
    const owners = p.params.componentRevisionIds.map((id) => getRevision(db, projectId, id).assetId);
    if (!owners.includes(asset.id)) {
      throw new DomainFailure("validation_failed", tx("O asset alvo não é um dos componentes do plano de estados", "The target asset is not one of the components in the states plan"));
    }
  },
  loadInputs: (ctx, plan, adapter, part) => loadStatesInputs(ctx, plan, adapter, part),
  process: processStates,
  publish: (ctx, plan, _asset, part) => publishStates(ctx, plan, part),
};
