import { z } from "zod";
import { ExpressionPayload, Id, SpeechPayload, type SpeechTiming, TextKey } from "@/contracts";
import { planSpeech, speechFrames, timingAtRate, visemeCompatibility } from "@/domain/dialogue/visemes";
import { tx } from "@/i18n/locales";
import { type BlobRecord, createAsset, getAsset, getRevision, publishRevision, recordBlob, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { dataUrl, outputOf, runWorldPython, storeOutput } from "../world/python";
import { DIALOGUE_ROUTE_LABELS } from "./core";

/**
 * Fala (cartão D1): plano temporal LOCAL e determinístico a partir do texto
 * (regra letters-v1), gravado como revisão `portrait/speech` que cita a
 * expressão aprovada. Nenhum job de geração: duas falas reutilizam os mesmos
 * visemes aprovados; reabrir recalcula a mesma sequência; trocar a expressão
 * escolhe os quadros de mesmo ID numa expressão compatível. A prévia GIF/tira
 * é um derivado (não entra no pacote); o plano é a autoridade.
 */

export const SpeechInput = z.strictObject({
  expressionRevisionId: Id,
  textKey: TextKey,
  language: z.enum(["pt-BR", "en"]),
  text: z.string().trim().min(1).max(2000),
  /** Ritmo relativo aplicado aos parâmetros padrão (1 = normal). */
  rate: z.number().min(0.5).max(2).default(1),
});

function expressionOf(studio: Studio, projectId: string, revisionId: string) {
  const revision = getRevision(studio.db, projectId, revisionId);
  const asset = getAsset(studio.db, projectId, revision.assetId);
  if (asset.family !== "portrait" || asset.kind !== "expression") {
    throw new DomainFailure("validation_failed", tx(`${asset.name} r${revision.number} não é uma expressão (portrait/expression)`, `${asset.name} r${revision.number} is not an expression (portrait/expression)`));
  }
  if (revision.status !== "approved") throw new DomainFailure("source_not_approved", tx(`A expressão ${asset.name} r${revision.number} precisa estar aprovada`, `Expression ${asset.name} r${revision.number} must be approved`));
  if ((revision.technicalReport as { complete?: boolean } | null)?.complete === false) {
    throw new DomainFailure("coverage_incomplete", tx(`A expressão ${asset.name} r${revision.number} tem visemes vazios`, `Expression ${asset.name} r${revision.number} has empty visemes`));
  }
  return { revision, asset, payload: ExpressionPayload.parse(revision.payload) };
}

function checkVisemes(expression: ExpressionPayload, used: string[]) {
  const ids = expression.visemes.map((v) => v.visemeId);
  const missing = [...new Set(used)].filter((id) => !ids.includes(id));
  if (missing.length) {
    throw new DomainFailure("coverage_incomplete", tx(`A expressão não tem os visemes ${missing.join(", ")}`, `The expression lacks the visemes ${missing.join(", ")}`), { missing });
  }
}

export function previewSpeech(studio: Studio, projectId: string, raw: z.input<typeof SpeechInput>) {
  const input = SpeechInput.parse(raw);
  const { revision, asset, payload } = expressionOf(studio, projectId, input.expressionRevisionId);
  const timing = timingAtRate(input.rate);
  const plan = planSpeech(input.text, input.language, timing);
  checkVisemes(payload, plan.timeline.map((s) => s.visemeId));
  return {
    routeLabel: DIALOGUE_ROUTE_LABELS.speech,
    text: plan.text,
    timing,
    timeline: plan.timeline,
    frames: speechFrames(plan.timeline),
    totalMs: plan.totalMs,
    unresolved: plan.unresolved,
    expression: { revisionId: revision.id, assetId: asset.id, name: asset.name, number: revision.number },
    generationJobs: 0,
  };
}

/** GIF animado e tira PNG a partir da folha da expressão (prévia derivada, fora do pacote). */
async function speechPreviewFiles(studio: Studio, expression: RevisionView, payload: SpeechPayload) {
  const exp = ExpressionPayload.parse(expression.payload);
  const rects = new Map(exp.visemes.map((v) => [v.visemeId, v]));
  const sheet = exp.visemes[0]!.fileId;
  const file = expression.files.find((f) => f.fileKey === sheet);
  if (!file) throw new DomainFailure("internal", tx("Folha da expressão sem arquivo", "Expression sheet has no file"));
  const cell = exp.grid?.cell ?? [rects.get("rest")?.rect[2] ?? 1, rects.get("rest")?.rect[3] ?? 1];
  const run = await runWorldPython(studio, "speech_preview", [{ role: "source", sha256: file.sha256 }], {
    frames: payload.timeline.slice(0, 2000).map((s) => ({ rect: rects.get(s.visemeId)!.rect, durationMs: s.durationMs })),
    zoom: Math.max(1, Math.min(8, Math.floor(128 / Math.max(cell[0], cell[1])))),
    stripMax: 24,
  });
  const gif = outputOf(run, "gif");
  const stored = await studio.blobs.putBytes(gif.bytes);
  const gifBlob: BlobRecord = { sha256: stored.sha256, bytes: stored.bytes, mime: "image/gif", modality: "raster", metadata: { width: gif.width, height: gif.height, derived: "speech_preview" } };
  recordBlob(studio.db, studio.clock, gifBlob);
  const strip = await storeOutput(studio, outputOf(run, "strip"));
  return { gifBlob, strip, stripPreview: dataUrl(outputOf(run, "strip")) };
}

function report(payload: SpeechPayload, plan: ReturnType<typeof planSpeech>, extra: Record<string, unknown>) {
  return {
    operation: "speech_plan",
    routeLabel: DIALOGUE_ROUTE_LABELS.speech,
    rule: payload.timing?.rule ?? "letters-v1",
    timing: payload.timing,
    steps: payload.timeline.length,
    totalMs: payload.timeline.reduce((n, s) => n + s.durationMs, 0),
    unresolved: plan.unresolved,
    generationJobs: 0,
    derivedPreview: tx("GIF e tira são prévias derivadas; o pacote leva o plano temporal e os visemes", "The GIF and strip are derived previews; the package carries the timing plan and the visemes"),
    warnings: plan.unresolved.length
      ? [tx(`Caracteres sem regra (sem passo): ${plan.unresolved.map((u) => u.char).join(" ")}`, `Characters without a rule (no step): ${plan.unresolved.map((u) => u.char).join(" ")}`)]
      : [],
    ...extra,
  };
}

export const PublishSpeechInput = SpeechInput.extend({ assetId: Id.optional(), name: z.string().trim().min(1).max(120).optional() });

export async function publishSpeech(studio: Studio, projectId: string, raw: z.input<typeof PublishSpeechInput>) {
  const input = PublishSpeechInput.parse(raw);
  const { revision: expression, payload: exp } = expressionOf(studio, projectId, input.expressionRevisionId);
  const timing: SpeechTiming = timingAtRate(input.rate);
  const plan = planSpeech(input.text, input.language, timing);
  checkVisemes(exp, plan.timeline.map((s) => s.visemeId));
  const payload = SpeechPayload.parse({ textKey: input.textKey, language: input.language, sampleText: plan.text, expressionRevisionId: expression.id, timing, timeline: plan.timeline });
  const asset = input.assetId ? getAsset(studio.db, projectId, input.assetId) : createAsset(studio.db, studio.clock, { projectId, family: "portrait", kind: "speech", name: input.name ?? input.textKey });
  if (asset.family !== "portrait" || asset.kind !== "speech") throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; esperado portrait/speech`, `The asset is ${asset.family}/${asset.kind}; expected portrait/speech`));
  const preview = await speechPreviewFiles(studio, expression, payload);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: null,
    payload,
    files: [
      { fileKey: "preview-gif", role: "preview", idx: 0, blob: preview.gifBlob },
      { fileKey: "preview-strip", role: "preview", idx: 1, blob: preview.strip },
    ],
    technicalReport: report(payload, plan, {}),
  });
  return { revision, asset: getAsset(studio.db, projectId, asset.id), stripPreview: preview.stripPreview };
}

export const RetargetSpeechInput = z.strictObject({ speechRevisionId: Id, expressionRevisionId: Id });

/** Mesma fala com outra expressão: exige os mesmos IDs na mesma ordem; não sobrescreve a revisão anterior. */
export async function retargetSpeech(studio: Studio, projectId: string, raw: z.input<typeof RetargetSpeechInput>) {
  const input = RetargetSpeechInput.parse(raw);
  const source = getRevision(studio.db, projectId, input.speechRevisionId);
  const asset = getAsset(studio.db, projectId, source.assetId);
  if (asset.family !== "portrait" || asset.kind !== "speech") throw new DomainFailure("validation_failed", tx("A revisão não é uma fala", "The revision is not a speech"));
  const speech = SpeechPayload.parse(source.payload);
  const from = ExpressionPayload.parse(getRevision(studio.db, projectId, speech.expressionRevisionId).payload);
  const { revision: target, payload: to } = expressionOf(studio, projectId, input.expressionRevisionId);
  const compat = visemeCompatibility(
    from.visemes.map((v) => v.visemeId),
    to.visemes.map((v) => v.visemeId),
    speech.timeline.map((s) => s.visemeId),
  );
  if (!compat.compatible) {
    throw new DomainFailure(
      "validation_failed",
      tx(
        `Expressão incompatível: ${compat.missing.length ? `faltam ${compat.missing.join(", ")}` : "visemes em outra ordem/quantidade"}`,
        `Incompatible expression: ${compat.missing.length ? `missing ${compat.missing.join(", ")}` : "visemes in another order/count"}`,
      ),
      compat,
    );
  }
  const payload = SpeechPayload.parse({ ...speech, expressionRevisionId: target.id });
  const plan = planSpeech(speech.sampleText, speech.language, speech.timing);
  const preview = await speechPreviewFiles(studio, target, payload);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: null,
    predecessorId: source.id,
    payload,
    files: [
      { fileKey: "preview-gif", role: "preview", idx: 0, blob: preview.gifBlob },
      { fileKey: "preview-strip", role: "preview", idx: 1, blob: preview.strip },
    ],
    edges: [{ toRevisionId: source.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: report(payload, plan, { routeLabel: DIALOGUE_ROUTE_LABELS.speechRetarget, retargetedFrom: { speechRevisionId: source.id, expressionRevisionId: speech.expressionRevisionId } }),
  });
  return { revision, stripPreview: preview.stripPreview };
}

/** Reabrir: recalcula pela regra e parâmetros gravados e confere passo a passo. */
export function verifySpeech(payload: SpeechPayload) {
  const plan = planSpeech(payload.sampleText, payload.language, payload.timing);
  const same = plan.timeline.length === payload.timeline.length && plan.timeline.every((s, i) => s.visemeId === payload.timeline[i]!.visemeId && s.durationMs === payload.timeline[i]!.durationMs && s.textPosition === payload.timeline[i]!.textPosition);
  return { reproducible: same, totalMs: plan.totalMs };
}
