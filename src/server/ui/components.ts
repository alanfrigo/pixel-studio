import { z } from "zod";
import {
  ButtonPayload,
  Id,
  MenuItemPayload,
  MeterPayload,
  PanelPayload,
  Rect,
  Slug,
  SlotPayload,
  type TemplateCell,
  TemplatePayload,
  TextKey,
  UiState,
  UiTransform,
} from "@/contracts";
import { suggestedGuides } from "@/domain/ui-geometry";
import { DEFAULT_REQUIRED_STATES, groupCells } from "@/domain/ui-template";
import { type TextValue, tx } from "@/i18n/locales";
import { type AssetView, type BlobRecord, createAsset, getAsset, getProject, getRevision, getStyleRevision, publishRevision, type RevisionView } from "../catalog/catalog";
import { DomainFailure } from "../errors";
import type { Studio } from "../studio";
import { outputOf, runWorldPython, storeOutput, type WorldOutput } from "../world/python";
import { nextStatefulPayload } from "./component-revision";
import { focusColor, UI_ROUTE_LABELS } from "./core";
import { stateful } from "./plans";

/**
 * Casos de uso locais do kit de UI (cartão U3), todos sem IA: separar o
 * template aprovado em componentes por retângulos revisados, derivar estados
 * por transformação local explícita, desenhar o overlay de foco e montar itens
 * de menu. Cada resultado é uma revisão CANDIDATA com origem registrada.
 */

function uiAsset(studio: Studio, projectId: string, assetId: string, kind: string): AssetView {
  const asset = getAsset(studio.db, projectId, assetId);
  if (asset.family !== "ui" || asset.kind !== kind) {
    throw new DomainFailure("validation_failed", tx(`O asset é ${asset.family}/${asset.kind}; esperado ui/${kind}`, `The asset is ${asset.family}/${asset.kind}; expected ui/${kind}`));
  }
  return asset;
}

function fileOf(revision: RevisionView, fileKey: string) {
  const file = revision.files.find((f) => f.fileKey === fileKey);
  if (!file) throw new DomainFailure("internal", tx(`Arquivo ${fileKey} sem vínculo na revisão`, `File ${fileKey} has no link in the revision`));
  return file;
}

const titleOf = (id: string) => id.replace(/[-_.]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Separar o template (recorte local explícito)
// ---------------------------------------------------------------------------

export const SplitTemplateInput = z.strictObject({
  templateRevisionId: Id,
  pieces: z
    .array(
      z.strictObject({
        componentId: Id,
        /** Retângulos revisados pelo artista (pré-preenchidos com a proposta), em pixels do template. */
        rects: z.array(z.strictObject({ localId: Id, rect: Rect })).min(1).max(3),
        /** Asset existente que recebe a nova revisão; ausente = cria um asset com `name`. */
        assetId: Id.optional(),
        name: z.string().trim().min(1).max(120).optional(),
      }),
    )
    .min(1)
    .max(16),
});

interface Crop {
  out: WorldOutput;
  report: { key: string; rect: [number, number, number, number]; opaquePixels: number; emptyCoverage: number | null };
}

export async function splitTemplate(studio: Studio, projectId: string, raw: z.input<typeof SplitTemplateInput>) {
  const input = SplitTemplateInput.parse(raw);
  const template = getRevision(studio.db, projectId, input.templateRevisionId);
  uiAsset(studio, projectId, template.assetId, "template");
  if (template.status !== "approved") {
    throw new DomainFailure("source_not_approved", tx(`Aprove o template r${template.number} antes de separar as peças`, `Approve template r${template.number} before splitting its pieces`));
  }
  const payload = TemplatePayload.parse(template.payload);
  const groups = groupCells(payload.cells);
  const plan = input.pieces.map((piece) => {
    const cells = groups.get(piece.componentId);
    if (!cells) throw new DomainFailure("validation_failed", tx(`Componente ${piece.componentId} não existe no template`, `Component ${piece.componentId} does not exist in the template`));
    const type = cells[0]!.componentType;
    const rects = new Map(piece.rects.map((r) => [r.localId, r.rect]));
    for (const id of rects.keys()) {
      if (!cells.some((c) => c.localId === id)) throw new DomainFailure("validation_failed", tx(`Peça ${id} não pertence a ${piece.componentId}`, `Piece ${id} does not belong to ${piece.componentId}`));
    }
    const missing = cells.filter((c) => !rects.has(c.localId)).map((c) => c.localId);
    if (missing.length) throw new DomainFailure("validation_failed", tx(`Faltam retângulos para ${missing.join(", ")}`, `Missing rectangles for ${missing.join(", ")}`));
    for (const [id, [x, y, w, h]] of rects) {
      if (x + w > payload.logicalSize[0] || y + h > payload.logicalSize[1]) {
        throw new DomainFailure("validation_failed", tx(`Retângulo de ${id} fora do template ${payload.logicalSize.join("×")}`, `Rectangle of ${id} outside the ${payload.logicalSize.join("×")} template`));
      }
    }
    return { piece, cells, type, rects };
  });

  // Moldura da barra: o miolo (área do preenchimento) precisa ficar vazio para o preenchimento aparecer.
  const emptyRectFor = (cells: TemplateCell[], localId: string, rects: Map<string, [number, number, number, number]>): [number, number, number, number] | null => {
    const cell = cells.find((c) => c.localId === localId)!;
    if (cell.meterPart !== "frame") return null;
    const frame = rects.get(localId)!;
    const fill = rects.get(cells.find((c) => c.meterPart === "fill")!.localId)!;
    const ox = Math.floor((frame[2] - fill[2]) / 2);
    const oy = Math.floor((frame[3] - fill[3]) / 2);
    return fill[2] <= frame[2] && fill[3] <= frame[3] ? [ox, oy, fill[2], fill[3]] : null;
  };
  const crops = plan.flatMap((p) => [...p.rects].map(([key, rect]) => ({ key, rect, emptyRect: emptyRectFor(p.cells, key, p.rects) })));
  const source = fileOf(template, payload.image.fileId);
  const run = await runWorldPython(studio, "ui_crop", [{ role: "source", sha256: source.sha256 }], { crops });
  const reports = new Map((run.report.crops as Crop["report"][]).map((r) => [r.key, r]));
  const blobs = new Map<string, BlobRecord>();
  for (const c of crops) blobs.set(c.key, await storeOutput(studio, run.outputs.find((o) => o.role === "crop" && o.key === c.key)!));
  const styleRevisionId = getProject(studio.db, projectId).activeStyleRevisionId;

  return studio.db.transaction(() =>
    plan.map(({ piece, cells, type, rects }) => {
      const kind = type === "menu_item" ? "button" : type;
      const asset = piece.assetId ? uiAsset(studio, projectId, piece.assetId, kind) : createAsset(studio.db, studio.clock, { projectId, family: "ui", kind, name: piece.name ?? titleOf(piece.componentId) });
      const originOf = (localId: string) => ({ kind: "template_split" as const, templateRevisionId: template.id, rect: rects.get(localId)! });
      const blobOf = (localId: string) => blobs.get(localId)!;
      const first = cells[0]!;
      const [, , w, h] = rects.get(first.localId)!;
      const required = first.requiredStates.length ? first.requiredStates : DEFAULT_REQUIRED_STATES[type];
      const warnings: TextValue[] = [...run.warnings.filter((wr) => cells.some((c) => JSON.stringify(wr).includes(c.localId)))];
      let built: { payload: unknown; files: { fileKey: string; role: string; idx: number; blob: BlobRecord }[] };
      if (kind === "button") {
        const guides = suggestedGuides([w, h]);
        const requiredStates = required.includes("normal") ? required : (["normal", ...required] as UiState[]);
        built = {
          payload: ButtonPayload.parse({
            logicalSize: [w, h],
            states: [{ state: "normal", fileId: "normal", rect: [0, 0, w, h], origin: originOf(first.localId) }],
            requiredStates,
            focus: null,
            nineSlice: guides.nineSlice,
            contentPadding: guides.contentPadding,
            stretch: { center: "stretch", edges: "stretch" },
            interactiveRect: null,
            text: null,
            accessibleName: asset.name,
            complete: requiredStates.every((s) => s === "normal"),
          }),
          files: [{ fileKey: "normal", role: "state", idx: 0, blob: blobOf(first.localId) }],
        };
      } else if (kind === "panel") {
        const guides = suggestedGuides([w, h]);
        built = {
          payload: PanelPayload.parse({
            logicalSize: [w, h],
            image: { fileId: "panel", rect: [0, 0, w, h] },
            nineSlice: guides.nineSlice,
            contentPadding: guides.contentPadding,
            stretch: { center: "stretch", edges: "stretch" },
            minSize: [guides.nineSlice.left + guides.nineSlice.right + 1, guides.nineSlice.top + guides.nineSlice.bottom + 1],
          }),
          files: [{ fileKey: "panel", role: "state", idx: 0, blob: blobOf(first.localId) }],
        };
      } else if (kind === "slot") {
        const inset = Math.max(1, Math.floor(Math.min(w, h) / 8));
        built = {
          payload: SlotPayload.parse({
            logicalSize: [w, h],
            states: [{ state: "empty", fileId: "empty", rect: [0, 0, w, h], origin: originOf(first.localId) }],
            requiredStates: required,
            nineSlice: null,
            iconRect: [inset, inset, w - 2 * inset, h - 2 * inset],
            counterAnchor: [w - 2, h - 2],
            counterAlign: "end",
            complete: required.every((s) => s === "empty"),
          }),
          files: [{ fileKey: "empty", role: "state", idx: 0, blob: blobOf(first.localId) }],
        };
      } else {
        // Barra: trilho, preenchimento e moldura vêm de peças separadas do template (regiões independentes).
        const part = (name: "track" | "fill" | "frame") => cells.find((c) => c.meterPart === name)!.localId;
        const track = rects.get(part("track"))!;
        const frame = rects.get(part("frame"))!;
        const fill = rects.get(part("fill"))!;
        if (track[2] !== frame[2] || track[3] !== frame[3]) {
          throw new DomainFailure("validation_failed", tx(`Trilho ${track[2]}×${track[3]} e moldura ${frame[2]}×${frame[3]} precisam do mesmo tamanho`, `Track ${track[2]}×${track[3]} and frame ${frame[2]}×${frame[3]} must be the same size`));
        }
        if (fill[2] > track[2] || fill[3] > track[3]) throw new DomainFailure("validation_failed", tx("O preenchimento não cabe no trilho", "The fill does not fit inside the track"));
        const offset: [number, number] = [Math.floor((track[2] - fill[2]) / 2), Math.floor((track[3] - fill[3]) / 2)];
        built = {
          payload: MeterPayload.parse({
            logicalSize: [track[2], track[3]],
            track: { fileId: "track", rect: [0, 0, track[2], track[3]] },
            fill: { fileId: "fill", rect: [0, 0, fill[2], fill[3]], offset },
            frame: { fileId: "frame", rect: [0, 0, frame[2], frame[3]] },
            usefulRect: [offset[0], offset[1], fill[2], fill[3]],
            axis: track[2] >= track[3] ? "horizontal" : "vertical",
            direction: "forward",
            range: { min: 0, max: 100 },
            rounding: "floor",
            nineSlice: null,
          }),
          files: (["track", "fill", "frame"] as const).map((name, idx) => ({ fileKey: name, role: "part", idx, blob: blobOf(part(name)) })),
        };
        const coverage = reports.get(part("frame"))?.emptyCoverage;
        if (coverage !== null && coverage !== undefined && coverage > 0.05) {
          warnings.push(tx("A moldura cobre a área útil: o componente dinâmico não está pronto (refaça ou edite a moldura)", "The frame covers the useful area: the dynamic component is not ready (redo or edit the frame)"));
        }
      }
      const revision = publishRevision(studio.db, studio.clock, {
        projectId,
        assetId: asset.id,
        origin: "local_process",
        styleRevisionId,
        payload: built.payload,
        files: built.files,
        edges: [{ toRevisionId: template.id, role: "template", ordinal: 0, runtime: false }],
        technicalReport: {
          operation: "ui_split",
          routeLabel: UI_ROUTE_LABELS.split,
          templateRevisionId: template.id,
          componentId: piece.componentId,
          componentType: type,
          rects: Object.fromEntries(rects),
          crops: cells.map((c) => reports.get(c.localId)),
          warnings,
        },
      });
      return { componentId: piece.componentId, asset, revision };
    }),
  );
}

// ---------------------------------------------------------------------------
// Estados por transformação local e overlay de foco
// ---------------------------------------------------------------------------

/** Blob do estado: o arquivo inteiro ou o recorte da região num atlas. */
async function stateBlob(studio: Studio, revision: RevisionView, state: { fileId: string; rect: [number, number, number, number] }): Promise<BlobRecord> {
  const file = fileOf(revision, state.fileId);
  const meta = file.metadata as { width?: number; height?: number };
  if (state.rect[0] === 0 && state.rect[1] === 0 && meta.width === state.rect[2] && meta.height === state.rect[3]) {
    return { sha256: file.sha256, bytes: file.bytes, mime: file.mime, modality: "raster", metadata: file.metadata };
  }
  const run = await runWorldPython(studio, "ui_crop", [{ role: "source", sha256: file.sha256 }], { crops: [{ key: "state", rect: state.rect, emptyRect: null }] });
  return storeOutput(studio, run.outputs[0]!);
}

export const LocalStateInput = z.strictObject({
  componentRevisionId: Id,
  /** Estado a produzir. */
  state: UiState,
  /** Estado de origem; padrão = estado-base (normal/empty). */
  fromState: UiState.optional(),
  transform: UiTransform,
});

export async function applyLocalState(studio: Studio, projectId: string, raw: z.input<typeof LocalStateInput>) {
  const input = LocalStateInput.parse(raw);
  const c = stateful(studio, projectId, input.componentRevisionId);
  if (input.state === c.baseState) {
    throw new DomainFailure("validation_failed", tx(`O estado-base ${c.baseState} é a referência; troque-o no editor do componente`, `The ${c.baseState} base state is the reference; replace it in the component editor`));
  }
  const fromState = input.fromState ?? c.baseState;
  const from = c.payload.states.find((s) => s.state === fromState);
  if (!from) throw new DomainFailure("validation_failed", tx(`${c.asset.name} r${c.revision.number} não tem o estado ${fromState}`, `${c.asset.name} r${c.revision.number} has no ${fromState} state`));
  const project = getProject(studio.db, projectId);
  const style = project.activeStyleRevisionId ? getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload : null;
  const source = await stateBlob(studio, c.revision, from);
  const run = await runWorldPython(studio, "ui_state_transform", [{ role: "source", sha256: source.sha256 }], {
    transform: input.transform,
    palette: style?.palette.colors.map((col) => col.hex) ?? [],
    keepBorderPx: input.transform.kind === "offset" ? 2 : 1,
  });
  const blob = await storeOutput(studio, outputOf(run, "state"));
  const next = nextStatefulPayload(studio.db, c.revision, c.asset.kind as "button" | "slot", [
    { state: input.state, blob, origin: { kind: "local_transform", sourceRevisionId: c.revision.id, sourceState: fromState, transform: input.transform } },
  ]);
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: c.asset.id,
    origin: "local_process",
    styleRevisionId: project.activeStyleRevisionId,
    predecessorId: c.revision.id,
    payload: next.payload,
    files: next.files,
    edges: [{ toRevisionId: c.revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: {
      operation: "ui_state_transform",
      routeLabel: UI_ROUTE_LABELS.localTransform,
      state: input.state,
      fromState,
      transform: input.transform,
      report: run.report,
      complete: next.payload.complete,
      missing: next.missing,
      warnings: [...run.warnings, ...(next.missing.length ? [tx(`Componente incompleto: faltam ${next.missing.join(", ")}`, `Component incomplete: missing ${next.missing.join(", ")}`)] : [])],
    },
  });
  return { revision, complete: next.payload.complete, missing: next.missing };
}

export const FocusOverlayInput = z.strictObject({
  componentRevisionId: Id,
  widthPx: z.number().int().min(1).max(3).default(1),
  /** Cor de foco; padrão = cor reservada do estilo. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export async function applyFocusOverlay(studio: Studio, projectId: string, raw: z.input<typeof FocusOverlayInput>) {
  const input = FocusOverlayInput.parse(raw);
  const c = stateful(studio, projectId, input.componentRevisionId);
  if (c.asset.kind !== "button") throw new DomainFailure("validation_failed", tx("Foco por overlay vale para botões", "Overlay focus applies to buttons"));
  const project = getProject(studio.db, projectId);
  const style = project.activeStyleRevisionId ? getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload : null;
  const color = (input.color ?? (style ? focusColor(style) : "#ffd600")).toLowerCase();
  const source = await stateBlob(studio, c.revision, c.base);
  const run = await runWorldPython(studio, "ui_focus_overlay", [{ role: "source", sha256: source.sha256 }], { color, widthPx: input.widthPx });
  const blob = await storeOutput(studio, outputOf(run, "focus"));
  const next = nextStatefulPayload(studio.db, c.revision, "button", [], { blob, origin: { kind: "local_overlay", sourceRevisionId: c.revision.id, color, widthPx: input.widthPx } });
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: c.asset.id,
    origin: "local_process",
    styleRevisionId: project.activeStyleRevisionId,
    predecessorId: c.revision.id,
    payload: next.payload,
    files: next.files,
    edges: [{ toRevisionId: c.revision.id, role: "source", ordinal: 0, runtime: false }],
    technicalReport: { operation: "ui_focus_overlay", routeLabel: UI_ROUTE_LABELS.focusOverlay, color, widthPx: input.widthPx, report: run.report, warnings: run.warnings },
  });
  return { revision };
}

// ---------------------------------------------------------------------------
// Item de menu (sem arte própria: botão aprovado + legenda por chave)
// ---------------------------------------------------------------------------

export const MenuItemInput = z.strictObject({
  assetId: Id.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  buttonRevisionId: Id,
  iconRevisionId: Id.nullable().default(null),
  actionId: Slug,
  text: z.strictObject({
    key: TextKey,
    sample: z.string().trim().min(1).max(500),
    align: z.enum(["start", "center", "end"]).default("center"),
    verticalAlign: z.enum(["top", "middle", "bottom"]).default("middle"),
    wrap: z.enum(["none", "word"]).default("none"),
    overflow: z.enum(["grow", "paginate", "ellipsis", "report"]).default("report"),
    fontRevisionId: Id.nullable().default(null),
  }),
  shortcut: z.string().trim().max(32).nullable().default(null),
  selectable: z.boolean().default(true),
});

export function publishMenuItem(studio: Studio, projectId: string, raw: z.input<typeof MenuItemInput>) {
  const input = MenuItemInput.parse(raw);
  const button = getRevision(studio.db, projectId, input.buttonRevisionId);
  const buttonAsset = uiAsset(studio, projectId, button.assetId, "button");
  if (button.status !== "approved") throw new DomainFailure("source_not_approved", tx(`Aprove ${buttonAsset.name} r${button.number} antes de usá-lo no menu`, `Approve ${buttonAsset.name} r${button.number} before using it in the menu`));
  if (input.iconRevisionId) {
    const icon = getRevision(studio.db, projectId, input.iconRevisionId);
    const iconAsset = getAsset(studio.db, projectId, icon.assetId);
    if (iconAsset.family !== "item" || icon.status !== "approved") {
      throw new DomainFailure("validation_failed", tx("O ícone precisa ser uma revisão aprovada de item", "The icon must be an approved item revision"));
    }
  }
  const payload = MenuItemPayload.parse({
    buttonRevisionId: button.id,
    iconRevisionId: input.iconRevisionId,
    actionId: input.actionId,
    text: input.text,
    shortcut: input.shortcut || null,
    selectable: input.selectable,
  });
  const buttonPayload = ButtonPayload.parse(button.payload);
  const warnings: TextValue[] = [];
  if (input.selectable && !buttonPayload.states.some((s) => s.state === "selected")) {
    warnings.push(tx(`${buttonAsset.name} ainda não tem o estado selected; o item selecionável fica sem aparência própria`, `${buttonAsset.name} has no selected state yet; the selectable item has no look of its own`));
  }
  const asset = input.assetId ? uiAsset(studio, projectId, input.assetId, "menu_item") : createAsset(studio.db, studio.clock, { projectId, family: "ui", kind: "menu_item", name: input.name ?? input.text.sample.slice(0, 120) });
  const revision = publishRevision(studio.db, studio.clock, {
    projectId,
    assetId: asset.id,
    origin: "composition",
    styleRevisionId: getProject(studio.db, projectId).activeStyleRevisionId,
    payload,
    files: [],
    technicalReport: { operation: "ui_menu_item", routeLabel: UI_ROUTE_LABELS.menuItem, warnings },
  });
  return { asset, revision, warnings };
}
