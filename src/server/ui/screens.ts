import { z } from "zod";
import { ButtonPayload, Id, MenuItemPayload, ScreenPayload, type Size, SlotPayload, type TextSlot } from "@/contracts";
import { contentArea } from "@/domain/ui-geometry";
import { boxInside, layoutScreen, layoutText, resolveCaption, slotCounterRect } from "@/domain/ui-screen";
import { imageOfPayload } from "@/domain/ui-template";
import { type TextValue, tx } from "@/i18n/locales";
import { type AssetView, createAsset, getAsset, getProject, getRevision, getStyleRevision, listAssets, listRevisions, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { focusColor, UI_ROUTE_LABELS } from "./core";

/**
 * Telas de UI (cartão U3 · 07 §composição editável): catálogo do compositor,
 * salvar/reabrir/duplicar revisões e religar instâncias a uma nova revisão de
 * componente. A prévia não gera nada: legenda, idioma, estado e valor do
 * medidor são dados da tela.
 */

// ---------------------------------------------------------------------------
// Catálogo do compositor
// ---------------------------------------------------------------------------

export interface UiEntry {
  asset: AssetView;
  revisions: RevisionView[];
}

/** Revisão aprovada com imagem utilizável na tela (retrato, ícone) ou como fundo de inspeção. */
export interface ImageChoice {
  assetId: string;
  assetName: string;
  family: string;
  kind: string;
  revisionId: string;
  number: number;
  /** ID do arquivo da revisão (rota de mídia) e região dentro dele. */
  mediaFileId: string;
  rect: [number, number, number, number];
}

function imageChoice(asset: AssetView, revision: RevisionView): ImageChoice | null {
  const region = imageOfPayload(asset.family, asset.kind, revision.payload);
  const file = region ? revision.files.find((f) => f.fileKey === region.fileId) : undefined;
  if (!region || !file) return null;
  return { assetId: asset.id, assetName: asset.name, family: asset.family, kind: asset.kind, revisionId: revision.id, number: revision.number, mediaFileId: file.id, rect: region.rect };
}

const IMAGE_FAMILIES = new Set(["item", "portrait", "character"]);
const BACKGROUND_KINDS = new Set(["map/scene", "map/room", "map/scene_layer", "texture/material"]);

export function uiCatalog(studio: Studio, projectId: string) {
  const project = getProject(studio.db, projectId);
  const style = project.activeStyleRevisionId ? getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload : null;
  const ui: UiEntry[] = [];
  const images: ImageChoice[] = [];
  const backgrounds: ImageChoice[] = [];
  for (const asset of listAssets(studio.db, projectId)) {
    if (asset.family === "ui") {
      ui.push({ asset, revisions: listRevisions(studio.db, projectId, asset.id) });
      continue;
    }
    const isImage = IMAGE_FAMILIES.has(asset.family) && (asset.family !== "character" || asset.kind === "base");
    const isBackground = BACKGROUND_KINDS.has(`${asset.family}/${asset.kind}`);
    if (!isImage && !isBackground) continue;
    for (const revision of listRevisions(studio.db, projectId, asset.id)) {
      if (revision.status !== "approved") continue;
      const choice = imageChoice(asset, revision);
      if (!choice) continue;
      (isImage ? images : backgrounds).push(choice);
    }
  }
  const of = (kind: string) => ui.filter((e) => e.asset.kind === kind);
  return {
    components: ui.filter((e) => e.asset.kind !== "screen" && e.asset.kind !== "template"),
    templates: of("template"),
    screens: of("screen"),
    images,
    backgrounds,
    palette: style?.palette.colors.map((c) => c.hex) ?? [],
    focusColor: style ? focusColor(style) : "#ffd600",
  };
}

// ---------------------------------------------------------------------------
// Conferência da tela nas resoluções testadas
// ---------------------------------------------------------------------------

export interface ScreenCheck {
  resolution: Size;
  /** Instâncias que saem da tela. */
  offscreen: string[];
  /** Legendas/textos que não cabem e o que a política fez. */
  text: { instanceId: string; key: string | null; outcome: string; overflow: boolean }[];
  /** Contadores de slot fora do slot. */
  counters: string[];
}

function componentRevisions(studio: Studio, projectId: string, payload: ScreenPayload) {
  const map = new Map<string, { asset: AssetView; revision: RevisionView }>();
  const ids = new Set(payload.instances.flatMap((i) => [i.componentRevisionId, i.overrides.iconRevisionId]).filter((x): x is string => Boolean(x)));
  for (const id of ids) {
    const revision = getRevision(studio.db, projectId, id);
    map.set(id, { asset: getAsset(studio.db, projectId, revision.assetId), revision });
  }
  return map;
}

export function checkScreen(studio: Studio, projectId: string, payload: ScreenPayload, language?: string): ScreenCheck[] {
  const refs = componentRevisions(studio, projectId, payload);
  const resolutions = payload.testedResolutions?.length ? payload.testedResolutions : [payload.referenceResolution];
  const lang = language ?? payload.textCatalog?.languages[0] ?? "pt-BR";
  return resolutions.map((resolution) => {
    const check: ScreenCheck = { resolution, offscreen: [], text: [], counters: [] };
    for (const r of layoutScreen(payload, resolution)) {
      if (!r.visible) continue;
      const inst = r.instance;
      const [x, y, w, h] = r.rect;
      if (x < 0 || y < 0 || x + w > resolution[0] || y + h > resolution[1]) check.offscreen.push(inst.instanceId);
      const ref = inst.componentRevisionId ? refs.get(inst.componentRevisionId) : undefined;
      let slot: TextSlot | null = inst.text ?? null;
      let area: [number, number] = [w, h];
      if (ref?.asset.kind === "button" || ref?.asset.kind === "menu_item") {
        const menu = ref.asset.kind === "menu_item" ? MenuItemPayload.parse(ref.revision.payload) : null;
        const buttonRev = menu ? refs.get(menu.buttonRevisionId)?.revision ?? getRevision(studio.db, projectId, menu.buttonRevisionId) : ref.revision;
        const button = ButtonPayload.parse(buttonRev.payload);
        slot = menu?.text ?? button.text;
        try {
          const [, , cw, ch] = contentArea([w, h], button.contentPadding);
          area = [cw, ch];
        } catch {
          area = [0, 0];
        }
      }
      if (slot) {
        const caption = resolveCaption(inst, slot, payload.textCatalog, lang);
        if (caption.text) {
          const layout = layoutText(caption.text, area, slot);
          if (layout.overflow) check.text.push({ instanceId: inst.instanceId, key: caption.key, outcome: layout.outcome, overflow: true });
        }
      }
      if (ref?.asset.kind === "slot" && inst.overrides.quantity !== undefined) {
        const s = SlotPayload.parse(ref.revision.payload);
        if (!boxInside(slotCounterRect(s, inst.overrides.quantity), [0, 0, ...s.logicalSize])) check.counters.push(inst.instanceId);
      }
    }
    return check;
  });
}

function checkWarnings(checks: ScreenCheck[]): TextValue[] {
  const out: TextValue[] = [];
  for (const c of checks) {
    const res = c.resolution.join("×");
    if (c.offscreen.length) out.push(tx(`${res}: fora da tela — ${c.offscreen.join(", ")}`, `${res}: off screen — ${c.offscreen.join(", ")}`));
    for (const t of c.text.filter((t) => t.outcome === "report")) out.push(tx(`${res}: texto ${t.key ?? t.instanceId} excede a área (política: acusar)`, `${res}: text ${t.key ?? t.instanceId} exceeds its area (policy: report)`));
    if (c.counters.length) out.push(tx(`${res}: contador fora do slot — ${c.counters.join(", ")}`, `${res}: counter outside the slot — ${c.counters.join(", ")}`));
  }
  return out;
}

/** Instância só referencia componente de UI, item (ícone), retrato ou personagem (imagem aprovada); fundo é cena/sala/plano/textura. */
function assertReferences(studio: Studio, projectId: string, payload: ScreenPayload) {
  for (const { asset, revision } of componentRevisions(studio, projectId, payload).values()) {
    const ok = (asset.family === "ui" && asset.kind !== "screen" && asset.kind !== "template") || asset.family === "item" || asset.family === "portrait" || (asset.family === "character" && asset.kind === "base");
    if (!ok) throw new DomainFailure("validation_failed", tx(`${asset.name} (${asset.family}/${asset.kind}) não pode ser instância de tela`, `${asset.name} (${asset.family}/${asset.kind}) cannot be a screen instance`), { revisionId: revision.id });
  }
  if (payload.background) {
    const rev = getRevision(studio.db, projectId, payload.background.revisionId);
    const asset = getAsset(studio.db, projectId, rev.assetId);
    if (!BACKGROUND_KINDS.has(`${asset.family}/${asset.kind}`)) {
      throw new DomainFailure("validation_failed", tx(`${asset.name} não serve de fundo (use cena, sala, plano ou textura)`, `${asset.name} cannot be a background (use a scene, room, layer or texture)`));
    }
  }
}

// ---------------------------------------------------------------------------
// Salvar, reabrir (revisões) e religar
// ---------------------------------------------------------------------------

export const SaveScreenInput = z.strictObject({
  assetId: Id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  payload: z.unknown(),
  /** Idioma em que a prévia conferiu as legendas. */
  language: z.string().max(16).optional(),
});

export function saveScreen(studio: Studio, projectId: string, raw: z.input<typeof SaveScreenInput>) {
  const input = SaveScreenInput.parse(raw);
  const parsed = ScreenPayload.safeParse(input.payload);
  if (!parsed.success) {
    throw new DomainFailure("validation_failed", tx("Tela inválida", "Invalid screen"), { issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String), message: i.message })) });
  }
  const payload = parsed.data;
  assertReferences(studio, projectId, payload);
  const checks = checkScreen(studio, projectId, payload, input.language);
  return studio.db.transaction(() => {
    const asset = input.assetId ? getAsset(studio.db, projectId, input.assetId) : createAsset(studio.db, studio.clock, { projectId, family: "ui", kind: "screen", name: input.name ?? "Tela" });
    if (asset.family !== "ui" || asset.kind !== "screen") throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; esperado ui/screen`, `The asset is ${asset.family}/${asset.kind}; expected ui/screen`));
    const revision = publishRevision(studio.db, studio.clock, {
      projectId,
      assetId: asset.id,
      origin: "composition",
      styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
      payload,
      files: [],
      technicalReport: { operation: "ui_screen", routeLabel: UI_ROUTE_LABELS.screen, checks, warnings: checkWarnings(checks) },
    });
    return { asset, revision, checks };
  });
}

export const RebindScreenInput = z.strictObject({
  screenRevisionId: Id,
  replacements: z.array(z.strictObject({ from: Id, to: Id })).min(1).max(32),
});

/** Nova revisão da tela com as instâncias apontando para a revisão escolhida do componente (a anterior fica no histórico). */
export function rebindScreen(studio: Studio, projectId: string, raw: z.input<typeof RebindScreenInput>) {
  const input = RebindScreenInput.parse(raw);
  const base = getRevision(studio.db, projectId, input.screenRevisionId);
  const asset = getAsset(studio.db, projectId, base.assetId);
  if (asset.family !== "ui" || asset.kind !== "screen") throw new DomainFailure("validation_failed", tx("Religar vale para telas", "Rebinding applies to screens"));
  const swap = new Map(input.replacements.map((r) => [r.from, r.to]));
  for (const r of input.replacements) {
    const from = getAsset(studio.db, projectId, getRevision(studio.db, projectId, r.from).assetId);
    const to = getAsset(studio.db, projectId, getRevision(studio.db, projectId, r.to).assetId);
    if (from.id !== to.id) throw new DomainFailure("validation_failed", tx(`${to.name} não é outra revisão de ${from.name}`, `${to.name} is not another revision of ${from.name}`));
  }
  const payload = ScreenPayload.parse(base.payload);
  let changed = 0;
  const next: ScreenPayload = {
    ...payload,
    instances: payload.instances.map((inst) => {
      const to = inst.componentRevisionId ? swap.get(inst.componentRevisionId) : undefined;
      const icon = inst.overrides.iconRevisionId ? swap.get(inst.overrides.iconRevisionId) : undefined;
      if (!to && !icon) return inst;
      changed++;
      return { ...inst, ...(to ? { componentRevisionId: to } : {}), overrides: { ...inst.overrides, ...(icon ? { iconRevisionId: icon } : {}) } };
    }),
  };
  if (changed === 0) throw new DomainFailure("validation_failed", tx("Nenhuma instância usa as revisões indicadas", "No instance uses the given revisions"));
  const checks = checkScreen(studio, projectId, next);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: base.styleRevisionId,
    predecessorId: base.id,
    payload: next,
    files: [],
    edges: [{ toRevisionId: base.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: { operation: "ui_screen_rebind", routeLabel: UI_ROUTE_LABELS.rebind, replacements: input.replacements, instances: changed, checks, warnings: checkWarnings(checks) },
  });
  return { revision, instances: changed };
}
