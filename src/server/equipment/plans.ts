import { type LocalizedText, type TextValue, tx } from "@/i18n/locales";
import { z } from "zod";
import {
  type Capability,
  type ClipPayload,
  CostAmount,
  CoverageZone,
  type CoverageStrip,
  GenerationPlan,
  Id,
  type OverlayCoverageParams,
  PixelIndex,
  type PlanSource,
  ProtectZone,
  type Rect,
  type ReusedCell,
  Size,
  Slug,
  type StylePayload,
} from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { colorName } from "@/domain/color-names";
import { equivalentCells } from "@/domain/equipment/digest";
import { clampRect, estimatedZone, growRect, handProtect, planStrips, stripCanvas, zoneFromExisting } from "@/domain/equipment/template";
import { validatePlanReferences } from "@/domain/plan/references";
import { getAsset, getProject, getRevision, getStyleRevision } from "../catalog/catalog";
import { catalogLookup } from "../catalog/plan-lookup";
import { DomainFailure } from "../errors";
import { getProfileRow } from "../providers/registry";
import { chooseKeyColor } from "../services";
import type { Studio } from "../studio";
import { blobOf, loadOverlay, loadRig } from "./load";
import { clipDigests, latestOverlays } from "./overlays";
import { EQUIPMENT_ROUTE_LABELS } from "./provider-caps";
import { runEquipmentPython } from "./python";

/**
 * "Criar peça para este personagem" (04 §criar uma roupa ou armadura
 * compatível): o plano mostra a matriz de cobertura e o número de tiras antes
 * de gerar, reaproveita desenhos de poses equivalentes e gera só as lacunas,
 * podendo começar por uma pose de prova. Peças rígidas geram uma vista por
 * plano, com as empunhaduras do gabarito.
 *
 * Capacidades honestas por rota: nas rotas genéricas (OpenRouter), o modelo
 * recebe os frames da base e uma guia com a zona autorizada pintada e devolve
 * um CANDIDATO VESTIDO; a peça é recuperada localmente pela máscara explícita.
 * Isso nunca é anunciado como máscara nativa nem como overlay nativo.
 */

const Orientation = z.enum(["vertical_up", "vertical_down", "horizontal_right", "horizontal_left", "diagonal_up", "diagonal_down"]);

export const OverlayCoveragePlanInput = z.strictObject({
  operation: z.literal("generate_overlay_coverage"),
  providerProfileId: Id,
  rigRevisionId: Id,
  /** Peça aprovada a estender (cobertura nova, gerar lacunas). `null` = peça nova. */
  overlayRevisionId: Id.nullable().default(null),
  item: z.strictObject({ slots: z.array(Slug).min(1).max(4), stances: z.array(Slug).min(1).max(8) }).optional(),
  description: z.string().trim().min(1).max(500),
  mode: z.enum(["coverage", "rigid_view"]),
  // --- cobertura ---
  parts: z.array(Slug).max(8).default([]),
  clips: z.array(z.strictObject({ clipRevisionId: Id, frameIds: z.array(Id).max(64).optional() })).max(12).default([]),
  /** Começar por uma pose de prova: só este frame é gerado agora. */
  proofPose: z.strictObject({ clipRevisionId: Id, frameId: Id }).nullable().default(null),
  framesPerStrip: z.number().int().min(1).max(9).default(4),
  zones: z.array(CoverageZone).max(512).optional(),
  protect: z.array(ProtectZone).max(512).optional(),
  /** Folga em px ao derivar a zona de um desenho anterior (ombreiras, capas). */
  growZonePx: z.number().int().min(0).max(8).default(1),
  /** Refazer também células já cobertas (padrão: só as lacunas). */
  regenerate: z.boolean().default(false),
  // --- vista rígida ---
  view: z
    .strictObject({
      viewId: Id,
      size: Size,
      grips: z.array(z.strictObject({ socketId: Id, at: PixelIndex })).min(1).max(2),
      mirrorAllowed: z.boolean().default(false),
      orientation: Orientation.default("vertical_up"),
    })
    .optional(),
  /** Referência de material/forma aprovada (textura, item, outra peça). */
  materialReference: z.strictObject({ revisionId: Id, fileKey: z.string().min(1).max(128) }).optional(),
  costCeiling: CostAmount.nullable().optional(),
  language: z.enum(["pt-BR", "en"]).optional(),
});
export type OverlayCoveragePlanInput = z.input<typeof OverlayCoveragePlanInput>;

const cellKey = (clipRevisionId: string, frameId: string, partId: string) => `${clipRevisionId}#${frameId}#${partId}`;

export interface CoveragePlanSummary {
  mode: "coverage" | "rigid_view";
  routeLabel: LocalizedText;
  requested: number;
  existing: number;
  empty: number;
  reused: number;
  toGenerate: number;
  strips: { stripKey: string; clipRevisionId: string; clipName: string; frameIds: string[]; grid: string; canvas: [number, number] }[];
  /** Matriz pedida: por clipe, frame e parte, o que acontece com cada célula. */
  cells: { clipRevisionId: string; clipName: string; frameId: string; partId: string; fate: "existing" | "empty" | "reused" | "generate" | "later" }[];
  warnings: TextValue[];
}

/** Cobertura: guia e prompt pedem o personagem inteiro vestido, só dentro da zona pintada. */
export function compileCoveragePrompt(o: { language: "pt-BR" | "en"; description: string; frames: number; columns: number; rows: number; cell: [number, number]; markColor: string; keyColor: string; material: boolean }): string {
  const mark = colorName(o.markColor, o.language);
  const key = colorName(o.keyColor, o.language);
  const grid = o.frames === 1 ? null : `${o.columns}×${o.rows}`;
  if (o.language === "en") {
    return [
      `Image 1 shows ${o.frames === 1 ? "one frame" : `${o.frames} frames in a ${grid} grid`} of a pixel art character animation, each cell ${o.cell[0]}×${o.cell[1]} logical pixels, on a flat ${key} background.`,
      `Image 2 is the same image with the area where the garment goes painted flat ${mark}.`,
      `Dress the character in: ${o.description}. Draw the garment only inside the painted area of each frame, following each pose; keep the hands and face exactly as in image 1.`,
      o.material ? "Image 3 shows the material and shape to follow." : "",
      `Everything outside the painted area must stay identical to image 1: same pose, framing, size, pixel grid, colors and outline.`,
      `Draw exactly ${o.frames === 1 ? "one character" : `${o.frames} characters, one per cell`}, in the same place as in image 1; do not add characters and do not show image 2 side by side.`,
      `Return the whole image (all frames, same layout), with no ${mark} left, background flat ${key}, no text and no borders.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `A imagem 1 mostra ${o.frames === 1 ? "um frame" : `${o.frames} frames numa grade ${grid}`} de uma animação de personagem em pixel art, cada célula com ${o.cell[0]}×${o.cell[1]} pixels lógicos, sobre fundo ${key} chapado.`,
    `A imagem 2 é a mesma imagem com a área onde vai a peça pintada de ${mark} chapado.`,
    `Vista o personagem com: ${o.description}. Desenhe a peça só dentro da área pintada de cada frame, seguindo cada pose; mantenha mãos e rosto exatamente como na imagem 1.`,
    o.material ? "A imagem 3 mostra o material e a forma a seguir." : "",
    `Tudo fora da área pintada deve ficar idêntico à imagem 1: mesma pose, enquadramento, tamanho, grade de pixels, cores e contorno.`,
    `Desenhe exatamente ${o.frames === 1 ? "um personagem" : `${o.frames} personagens, um por célula`}, no mesmo lugar da imagem 1; não acrescente personagens nem mostre a imagem 2 ao lado.`,
    `Devolva a imagem inteira (todos os frames, mesma disposição), sem sobrar ${mark}, fundo ${key} chapado, sem texto e sem moldura.`,
  ]
    .filter(Boolean)
    .join(" ");
}

const ORIENTATION_TEXT = {
  vertical_up: { "pt-BR": "na vertical, ponta para cima, empunhadura embaixo", en: "vertical, tip up, grip at the bottom" },
  vertical_down: { "pt-BR": "na vertical, ponta para baixo, empunhadura em cima", en: "vertical, tip down, grip at the top" },
  horizontal_right: { "pt-BR": "na horizontal, ponta para a direita, empunhadura à esquerda", en: "horizontal, tip pointing right, grip on the left" },
  horizontal_left: { "pt-BR": "na horizontal, ponta para a esquerda, empunhadura à direita", en: "horizontal, tip pointing left, grip on the right" },
  diagonal_up: { "pt-BR": "na diagonal, ponta para cima e para a direita", en: "diagonal, tip up and to the right" },
  diagonal_down: { "pt-BR": "na diagonal, ponta para baixo e para a direita", en: "diagonal, tip down and to the right" },
} as const;

export function compileRigidPrompt(o: { language: "pt-BR" | "en"; description: string; size: [number, number]; orientation: z.infer<typeof Orientation>; keyColor: string; style: StylePayload; material: boolean }): string {
  const key = colorName(o.keyColor, o.language);
  const orient = ORIENTATION_TEXT[o.orientation][o.language];
  if (o.language === "en") {
    return [
      `A single game item in pixel art: ${o.description}, ${orient}, about ${o.size[0]}×${o.size[1]} logical pixels, centered, alone.`,
      o.material ? "Follow the material and shape of the reference image." : "",
      `Dark ${o.style.outline.widthPx} px outline, light from the ${o.style.lighting.lightFrom}. Flat ${key} background, no character, no hands, no shadow, no text.`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  return [
    `Um único item de jogo em pixel art: ${o.description}, ${orient}, com cerca de ${o.size[0]}×${o.size[1]} pixels lógicos, centralizado e sozinho.`,
    o.material ? "Siga o material e a forma da imagem de referência." : "",
    `Contorno escuro de ${o.style.outline.widthPx} px, luz vinda de ${o.style.lighting.lightFrom}. Fundo ${key} chapado, sem personagem, sem mãos, sem sombra e sem texto.`,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Caixa do conteúdo de cada frame (união das camadas da base), para o gabarito estimado. */
async function frameContentBoxes(studio: Studio, projectId: string, clipRevisionId: string): Promise<Record<string, Rect | null>> {
  const rev = getRevision(studio.db, projectId, clipRevisionId);
  const clip = rev.payload as ClipPayload;
  const inputs: { role: "layer"; sha256: string }[] = [];
  const ordinal = new Map<string, number>();
  const regions = clip.frames.flatMap((f, fi) =>
    f.layers.map((l, li) => {
      const sha = blobOf(studio.db, rev.id, l.fileId);
      if (!ordinal.has(sha)) {
        ordinal.set(sha, inputs.length);
        inputs.push({ role: "layer", sha256: sha });
      }
      return { key: `${fi}:${li}`, inputOrdinal: ordinal.get(sha)!, rect: l.rect };
    }),
  );
  const run = await runEquipmentPython(studio, "equipment_region_hashes", inputs, { regions });
  const boxes = run.report.contentBoxes as Record<string, Rect | null>;
  return Object.fromEntries(
    clip.frames.map((f, fi) => {
      let acc: [number, number, number, number] | null = null;
      f.layers.forEach((l, li) => {
        const b = boxes[`${fi}:${li}`];
        if (!b) return;
        const x0 = l.offset[0] + b[0];
        const y0 = l.offset[1] + b[1];
        acc = acc ? [Math.min(acc[0], x0), Math.min(acc[1], y0), Math.max(acc[2], x0 + b[2]), Math.max(acc[3], y0 + b[3])] : [x0, y0, x0 + b[2], y0 + b[3]];
      });
      const a = acc as [number, number, number, number] | null;
      return [f.frameId, a ? ([a[0], a[1], a[2] - a[0], a[3] - a[1]] as Rect) : null];
    }),
  );
}

export async function buildOverlayCoveragePlan(studio: Studio, projectId: string, raw: OverlayCoveragePlanInput) {
  const input = OverlayCoveragePlanInput.parse(raw);
  const project = getProject(studio.db, projectId);
  if (!project.activeStyleRevisionId) throw new DomainFailure("validation_failed", tx("Projeto sem estilo ativo", "Project has no active style"));
  const style = getStyleRevision(studio.db, projectId, project.activeStyleRevisionId).payload;
  studio.providers.assertReady(input.providerProfileId);
  const adapter = studio.providers.adapterFor(input.providerProfileId);
  const required: Capability[] = input.mode === "coverage" ? ["image_references"] : ["text_to_image"];
  const offered = adapter.capabilities("generate_overlay_coverage");
  if (!required.every((c) => offered.includes(c))) {
    throw new DomainFailure(
      "capability_missing",
      offered.length === 0
        ? tx(
            `O perfil ${input.providerProfileId} não tem rota para criar peças por frame. Alternativas: uma rota de imagem + referências (candidato vestido extraído localmente) ou "transferir roupa" para um clipe vestido e extrair a cobertura dele`,
            `Provider profile ${input.providerProfileId} has no route to create pieces per frame. Alternatives: an image + references route (dressed candidate extracted locally) or "outfit transfer" to a dressed clip and extract its coverage`,
          )
        : tx(
            `O perfil ${input.providerProfileId} não recebe as duas referências (frames da base e guia da zona) que a cobertura exige`,
            `Provider profile ${input.providerProfileId} does not accept the two references (base frames and zone guide) that coverage requires`,
          ),
      { missing: required.filter((c) => !offered.includes(c)), offered },
    );
  }
  const language = input.language ?? (style.briefLanguage === "en" ? "en" : "pt-BR");
  const palette = style.palette.colors.map((c) => c.hex);
  const keyColor = chooseKeyColor(palette);
  const markColor = chooseKeyColor([...palette, keyColor]);

  const rig = loadRig(studio.db, projectId, input.rigRevisionId);
  if (getRevision(studio.db, projectId, rig.ref.revisionId).status !== "approved") throw new DomainFailure("source_not_approved", tx("O rig precisa estar aprovado", "The rig must be approved"));
  const base = input.overlayRevisionId ? loadOverlay(studio.db, projectId, input.overlayRevisionId) : null;
  if (base && base.status !== "approved") throw new DomainFailure("source_not_approved", tx(`${base.name} r${base.number} precisa estar aprovada para receber coberturas novas`, `${base.name} r${base.number} must be approved to receive new coverage`));
  if (base && base.payload.rigRevisionId !== rig.ref.revisionId) {
    throw new DomainFailure("validation_failed", tx(
        `${base.name} foi feita para outra base; crie uma peça nova para esta base (a arte dela pode ir como referência de material)`,
        `${base.name} was made for another base; create a new piece for this base (its art can go as a material reference)`,
      ));
  }
  const slots = base?.payload.slots ?? input.item?.slots;
  const stances = base?.payload.stances ?? input.item?.stances;
  if (!slots || !stances) throw new DomainFailure("validation_failed", tx("Peça nova precisa de slots e posturas", "A new piece needs slots and stances"));
  const unknownSlot = slots.find((s) => !rig.ref.payload.slots.some((x) => x.slotId === s));
  if (unknownSlot) throw new DomainFailure("validation_failed", tx(`Slot ${unknownSlot} não existe no rig`, `Slot ${unknownSlot} does not exist in the rig`));

  const sources: PlanSource[] = [];
  const pushSource = (s: Omit<PlanSource, "ordinal">) => sources.push({ ...s, ordinal: sources.length });
  if (base) pushSource({ revisionId: base.revisionId, fileId: null, sha256: canonicalDigest(base.payload), role: "equipment" });
  let materialSha: string | null = null;
  if (input.materialReference) {
    const ref = getRevision(studio.db, projectId, input.materialReference.revisionId);
    const file = ref.files.find((f) => f.fileKey === input.materialReference!.fileKey);
    if (!file || file.mime !== "image/png") throw new DomainFailure("not_found", tx(`A referência não tem a imagem ${input.materialReference.fileKey}`, `The reference has no image ${input.materialReference.fileKey}`));
    materialSha = file.sha256;
  }

  const estimateCeiling = (parts: number) => {
    const estimate = adapter.estimate("generate_overlay_coverage", parts);
    return { maxSubmissions: parts, costCeiling: input.costCeiling ?? null, estimate };
  };

  // ------------------------------------------------------------------ vista rígida
  if (input.mode === "rigid_view") {
    const view = input.view;
    if (!view) throw new DomainFailure("validation_failed", tx("Informe a vista rígida (tamanho, empunhaduras e orientação)", "Provide the rigid view (size, grips and orientation)"));
    for (const g of view.grips) {
      if (g.at[0] >= view.size[0] || g.at[1] >= view.size[1]) throw new DomainFailure("validation_failed", tx(`Empunhadura ${g.socketId} fora da vista ${view.size.join("×")}`, `Grip ${g.socketId} is outside the ${view.size.join("×")} view`));
      if (!rig.ref.payload.sockets.some((s) => s.socketId === g.socketId)) throw new DomainFailure("validation_failed", tx(`Socket ${g.socketId} não existe no rig`, `Socket ${g.socketId} does not exist in the rig`));
    }
    if (input.materialReference) pushSource({ revisionId: input.materialReference.revisionId, fileId: input.materialReference.fileKey, sha256: materialSha!, role: "material" });
    const params: OverlayCoverageParams = {
      mode: "rigid_view",
      rigRevisionId: rig.ref.revisionId,
      overlayRevisionId: base?.revisionId ?? null,
      slots,
      stances,
      itemDescription: input.description,
      backgroundKey: keyColor,
      viewId: view.viewId,
      size: view.size,
      grips: view.grips,
      mirrorAllowed: view.mirrorAllowed,
      orientation: view.orientation,
    };
    const plan: GenerationPlan = {
      planVersion: 1,
      projectId,
      operation: "generate_overlay_coverage",
      styleRevisionId: project.activeStyleRevisionId,
      recipeRevisionId: "builtin-equipment-rigid-view-v1",
      providerProfileId: input.providerProfileId,
      prompt: { brief: input.description, compiled: compileRigidPrompt({ language, description: input.description, size: view.size, orientation: view.orientation, keyColor, style, material: Boolean(materialSha) }), language },
      sources,
      requiredCapabilities: required,
      parts: [{ partKey: `view:${view.viewId}`, unit: "view", label: `Vista rígida ${view.viewId}` }],
      limits: estimateCeiling(1),
      params,
    };
    return finish(studio, projectId, plan, {
      mode: "rigid_view",
      routeLabel: EQUIPMENT_ROUTE_LABELS.rigid_view,
      requested: 1,
      existing: base?.payload.rigidViews.some((v) => v.viewId === view.viewId) ? 1 : 0,
      empty: 0,
      reused: 0,
      toGenerate: 1,
      strips: [],
      cells: [],
      warnings: base?.payload.rigidViews.some((v) => v.viewId === view.viewId) ? [tx(`A vista ${view.viewId} já existe; a nova substitui na candidata`, `View ${view.viewId} already exists; the new one replaces it in the candidate`)] : [],
    });
  }

  // ------------------------------------------------------------------ cobertura
  const parts = input.parts.length ? input.parts : (base?.payload.parts.map((p) => p.partId) ?? []);
  if (parts.length === 0) throw new DomainFailure("validation_failed", tx("Escolha as partes desenháveis da peça (ex.: torso, manga próxima)", "Choose the drawable parts of the piece (e.g. torso, near sleeve)"));
  for (const p of parts) if (!rig.ref.payload.parts.some((x) => x.partId === p)) throw new DomainFailure("validation_failed", tx(`Parte ${p} não existe no rig`, `Part ${p} does not exist in the rig`));
  if (input.clips.length === 0) throw new DomainFailure("validation_failed", tx("Escolha os movimentos e vistas a entregar", "Choose the motions and views to deliver"));

  const clips = input.clips.map((c) => {
    const rev = getRevision(studio.db, projectId, c.clipRevisionId);
    const asset = getAsset(studio.db, projectId, rev.assetId);
    if (asset.family !== "character" || asset.kind !== "clip") throw new DomainFailure("validation_failed", tx(`${asset.name} não é um clipe`, `${asset.name} is not a clip`));
    if (rev.status !== "approved") throw new DomainFailure("source_not_approved", tx(`${asset.name} r${rev.number} precisa estar aprovado: aprove a animação da base antes de produzir coberturas`, `${asset.name} r${rev.number} must be approved: approve the base animation before producing coverage`));
    const payload = rev.payload as ClipPayload;
    if (payload.rigRevisionId !== rig.ref.revisionId) throw new DomainFailure("validation_failed", tx(`${asset.name} usa outro rig`, `${asset.name} uses another rig`));
    if (payload.stance && !stances.includes(payload.stance) && !(payload.sharedStances ?? []).some((s) => stances.includes(s))) {
      throw new DomainFailure("validation_failed", tx(`${asset.name} é da postura ${payload.stance}, que a peça não declara`, `${asset.name} belongs to stance ${payload.stance}, which the piece does not declare`));
    }
    const frameIds = c.frameIds?.length ? c.frameIds : payload.frames.map((f) => f.frameId);
    for (const f of frameIds) if (!payload.frames.some((x) => x.frameId === f)) throw new DomainFailure("validation_failed", tx(`Frame ${f} não existe em ${asset.name}`, `Frame ${f} does not exist in ${asset.name}`));
    return { revisionId: rev.id, name: asset.name, number: rev.number, payload, frameIds, revision: rev };
  });

  // Estado de cada célula pedida na peça de origem.
  const fate = new Map<string, CoveragePlanSummary["cells"][number]["fate"]>();
  const gaps: { clipRevisionId: string; frameId: string; partId: string }[] = [];
  for (const clip of clips) {
    for (const frameId of clip.frameIds) {
      for (const partId of parts) {
        const cell = base?.payload.parts.find((p) => p.partId === partId)?.coverage.find((c) => c.clipRevisionId === clip.revisionId && c.frameId === frameId);
        if (cell && !input.regenerate) fate.set(cellKey(clip.revisionId, frameId, partId), cell.layer ? "existing" : "empty");
        else gaps.push({ clipRevisionId: clip.revisionId, frameId, partId });
      }
    }
  }

  // Poses equivalentes (mesmo digest de geometria) que já têm a parte desenhada na peça.
  const reused: ReusedCell[] = [];
  const warnings: TextValue[] = [];
  if (base && gaps.length > 0) {
    const coveredClips = [...new Set(base.payload.parts.flatMap((p) => p.coverage.filter((c) => c.layer).map((c) => c.clipRevisionId)))];
    const digestOf = new Map<string, Record<string, string>>();
    for (const id of new Set([...coveredClips, ...clips.map((c) => c.revisionId)])) {
      try {
        digestOf.set(id, await clipDigests(studio, projectId, id));
      } catch {
        warnings.push(tx(`Não foi possível medir o digest do clipe ${id}; sem reaproveitamento por equivalência`, `Could not measure the digest of clip ${id}; no reuse by equivalence`));
      }
    }
    const existing = base.payload.parts.flatMap((p) =>
      p.coverage.filter((c) => c.layer && digestOf.get(c.clipRevisionId)?.[c.frameId]).map((c) => ({ clipRevisionId: c.clipRevisionId, frameId: c.frameId, partId: p.partId, digest: digestOf.get(c.clipRevisionId)![c.frameId]! })),
    );
    const wanted = gaps.filter((g) => digestOf.get(g.clipRevisionId)?.[g.frameId]).map((g) => ({ ...g, digest: digestOf.get(g.clipRevisionId)![g.frameId]! }));
    for (const [key, from] of equivalentCells(wanted, existing)) {
      const [clipRevisionId, frameId, partId] = key.split("#") as [string, string, string];
      reused.push({ clipRevisionId, frameId, partId, from, reason: "equivalent_pose" });
      fate.set(key, "reused");
    }
  }
  const reusedKeys = new Set(reused.map((r) => cellKey(r.clipRevisionId, r.frameId, r.partId)));
  let toGenerate = gaps.filter((g) => !reusedKeys.has(cellKey(g.clipRevisionId, g.frameId, g.partId)));
  if (input.proofPose) {
    const proof = input.proofPose;
    if (!clips.some((c) => c.revisionId === proof.clipRevisionId && c.frameIds.includes(proof.frameId))) throw new DomainFailure("validation_failed", tx("A pose de prova precisa estar entre os frames pedidos", "The proof pose must be among the requested frames"));
    for (const g of toGenerate) if (g.clipRevisionId !== proof.clipRevisionId || g.frameId !== proof.frameId) fate.set(cellKey(g.clipRevisionId, g.frameId, g.partId), "later");
    toGenerate = toGenerate.filter((g) => g.clipRevisionId === proof.clipRevisionId && g.frameId === proof.frameId);
  }
  for (const g of toGenerate) fate.set(cellKey(g.clipRevisionId, g.frameId, g.partId), "generate");

  const summaryCells: CoveragePlanSummary["cells"] = clips.flatMap((c) => c.frameIds.flatMap((frameId) => parts.map((partId) => ({ clipRevisionId: c.revisionId, clipName: c.name, frameId, partId, fate: fate.get(cellKey(c.revisionId, frameId, partId))! }))));
  const counts = (f: string) => summaryCells.filter((c) => c.fate === f).length;
  if (toGenerate.length === 0) {
    const nothing = reused.length
      ? tx(
          `Nada a gerar: ${reused.length} célula(s) reaproveitam poses equivalentes; aplique o reaproveitamento sem custo`,
          `Nothing to generate: ${reused.length} cell(s) reuse equivalent poses; apply the reuse at no cost`,
        )
      : tx("Nada a gerar: todas as células pedidas já estão cobertas", "Nothing to generate: every requested cell is already covered");
    throw new DomainFailure("validation_failed", nothing, {
      nothingToGenerate: true,
      reused,
      cells: summaryCells,
    });
  }

  // Tiras: frames pendentes de cada clipe, na ordem do clipe, em grade numa tela de proporção padrão.
  const pendingByClip = clips
    .map((c) => ({ clipRevisionId: c.revisionId, clipKey: `${c.payload.action}-${c.payload.stance ?? "x"}-${c.payload.direction}`.toLowerCase(), frameIds: c.frameIds.filter((f) => toGenerate.some((g) => g.clipRevisionId === c.revisionId && g.frameId === f)) }))
    .filter((c) => c.frameIds.length > 0);
  const groups = planStrips(pendingByClip, input.framesPerStrip);
  const strips: CoverageStrip[] = groups.map((g) => {
    const clip = clips.find((c) => c.revisionId === g.clipRevisionId)!;
    const cell = clip.payload.logicalSize;
    const { canvas, at } = stripCanvas(cell, g.columns, g.rows, g.frameIds.length);
    return {
      stripKey: g.stripKey,
      clipRevisionId: g.clipRevisionId,
      cell,
      canvas,
      columns: g.columns,
      rows: g.rows,
      frames: g.frameIds.map((frameId, i) => {
        const frame = clip.payload.frames.find((f) => f.frameId === frameId)!;
        // Só as partes em lacuna deste frame são publicadas; as já cobertas ficam como estão.
        const gapParts = toGenerate.filter((t) => t.clipRevisionId === clip.revisionId && t.frameId === frameId).map((t) => t.partId);
        return {
          frameId,
          at: at[i]!,
          ...(gapParts.length < parts.length ? { parts: gapParts } : {}),
          layers: frame.layers.map((l) => ({ sha256: blobOf(studio.db, clip.revisionId, l.fileId), rect: l.rect, offset: l.offset })),
        };
      }),
    };
  });

  // Gabarito: zona por parte e frame (pedido > desenho anterior > estimativa) e proteções (pedido > mãos).
  const template = await coverageTemplate(studio, projectId, {
    rig: rig.ref,
    slots,
    base: base?.payload ?? null,
    baseRevisionId: base?.revisionId ?? null,
    cells: strips.flatMap((s) => s.frames.map((f) => ({ clipRevisionId: s.clipRevisionId, frameId: f.frameId }))),
    parts,
    zones: input.zones,
    protect: input.protect,
    grow: input.growZonePx,
  });
  const { zones, protect } = template;
  warnings.push(...template.warnings);

  for (const clip of clips.filter((c) => strips.some((s) => s.clipRevisionId === c.revisionId))) {
    pushSource({ revisionId: clip.revisionId, fileId: null, sha256: canonicalDigest(clip.payload), role: "base" });
  }
  if (input.materialReference) pushSource({ revisionId: input.materialReference.revisionId, fileId: input.materialReference.fileKey, sha256: materialSha!, role: "material" });
  if (sources.length > 16) throw new DomainFailure("validation_failed", tx("Clipes demais num plano: divida por movimento ou vista (até 12 clipes por plano)", "Too many clips in one plan: split by motion or view (up to 12 clips per plan)"));

  const firstStrip = strips[0]!;
  const params: OverlayCoverageParams = {
    mode: "coverage",
    rigRevisionId: rig.ref.revisionId,
    overlayRevisionId: base?.revisionId ?? null,
    slots,
    stances,
    itemDescription: input.description,
    backgroundKey: keyColor,
    parts,
    strips,
    zones,
    protect,
    reused,
    proofPose: Boolean(input.proofPose),
    strategy: "dressed_candidate",
    markColor,
  };
  const plan: GenerationPlan = {
    planVersion: 1,
    projectId,
    operation: "generate_overlay_coverage",
    styleRevisionId: project.activeStyleRevisionId,
    recipeRevisionId: "builtin-equipment-coverage-v1",
    providerProfileId: input.providerProfileId,
    prompt: {
      brief: input.description,
      compiled: compileCoveragePrompt({ language, description: input.description, frames: firstStrip.frames.length, columns: firstStrip.columns, rows: firstStrip.rows, cell: firstStrip.cell, markColor, keyColor, material: Boolean(materialSha) }),
      language,
    },
    sources,
    requiredCapabilities: required,
    parts: strips.map((s) => ({ partKey: `strip:${s.stripKey}`, unit: "strip", label: `Tira ${s.stripKey} (${s.frames.length} frame(s))` })),
    limits: estimateCeiling(strips.length),
    params,
  };
  return finish(studio, projectId, plan, {
    mode: "coverage",
    routeLabel: EQUIPMENT_ROUTE_LABELS.dressed_candidate,
    requested: summaryCells.length,
    existing: counts("existing"),
    empty: counts("empty"),
    reused: counts("reused"),
    toGenerate: toGenerate.length,
    strips: strips.map((s) => ({ stripKey: s.stripKey, clipRevisionId: s.clipRevisionId, clipName: clips.find((c) => c.revisionId === s.clipRevisionId)!.name, frameIds: s.frames.map((f) => f.frameId), grid: `${s.columns}×${s.rows}`, canvas: s.canvas })),
    cells: summaryCells,
    warnings,
  });
}

function finish(studio: Studio, projectId: string, raw: GenerationPlan, summary: CoveragePlanSummary) {
  const parsed = GenerationPlan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new DomainFailure(issue.message.includes("teto") ? "budget_exceeded" : "validation_failed", issue.message, { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.map(String), message: i.message })) });
  }
  const plan = parsed.data;
  const issues = validatePlanReferences(plan, catalogLookup(studio.db));
  if (issues.length > 0) throw new DomainFailure(issues[0]!.code === "cross_project_reference" ? "cross_project_reference" : "validation_failed", issues[0]!.message, { issues });
  const profile = getProfileRow(studio.db, plan.providerProfileId);
  const e = plan.limits.estimate;
  const ceiling = plan.limits.costCeiling;
  const within = e.kind === "unknown" || !ceiling ? null : (e.kind === "known" ? e.amount : e.max).unit === ceiling.unit ? (e.kind === "known" ? e.amount : e.max).amount <= ceiling.amount : null;
  return {
    plan,
    digest: canonicalDigest(plan),
    destination: { profileId: profile.id, name: profile.name, transport: profile.transport, simulated: profile.transport === "simulated" },
    summary,
    costCheck: { kind: e.kind, withinCeiling: within },
  };
}

/**
 * Gabarito de cobertura por frame (04 §criar uma roupa, item 2): zona de cada
 * parte (pedida > desenho anterior da mesma parte, com folga > estimativa pela
 * caixa do conteúdo) e proteções (pedidas > mãos). Usado pelo plano de geração
 * e pela extração local de clipe vestido ou imagens importadas.
 */
export async function coverageTemplate(
  studio: Studio,
  projectId: string,
  o: {
    rig: { revisionId: string; payload: import("@/contracts").RigPayload };
    slots: readonly string[];
    base: import("@/contracts").OverlayPayload | null;
    baseRevisionId: string | null;
    cells: readonly { clipRevisionId: string; frameId: string }[];
    parts: readonly string[];
    zones?: readonly CoverageZone[] | undefined;
    protect?: readonly z.infer<typeof ProtectZone>[] | undefined;
    grow: number;
  },
) {
  const others = latestOverlays(studio.db, projectId).filter((x) => x.payload.rigRevisionId === o.rig.revisionId && x.payload.slots.some((s) => o.slots.includes(s)));
  const priors = [...(o.base ? [o.base] : []), ...others.filter((x) => x.revisionId !== o.baseRevisionId).map((x) => x.payload)];
  const gripSockets = new Set(o.rig.payload.sockets.filter((s) => s.purpose === "grip").map((s) => s.socketId));
  const zones: CoverageZone[] = [];
  const protect: z.infer<typeof ProtectZone>[] = [];
  const estimated: string[] = [];
  const clipCache = new Map<string, { payload: ClipPayload; name: string; boxes: Record<string, Rect | null> | null }>();
  for (const c of o.cells) {
    if (!clipCache.has(c.clipRevisionId)) {
      const rev = getRevision(studio.db, projectId, c.clipRevisionId);
      clipCache.set(c.clipRevisionId, { payload: rev.payload as ClipPayload, name: getAsset(studio.db, projectId, rev.assetId).name, boxes: null });
    }
    const clip = clipCache.get(c.clipRevisionId)!;
    const cell = clip.payload.logicalSize;
    const frame = clip.payload.frames.find((x) => x.frameId === c.frameId);
    if (!frame) throw new DomainFailure("validation_failed", tx(`Frame ${c.frameId} não existe em ${clip.name}`, `Frame ${c.frameId} does not exist in ${clip.name}`));
    for (const partId of o.parts) {
      const given = o.zones?.find((z) => z.clipRevisionId === c.clipRevisionId && z.frameId === c.frameId && z.partId === partId);
      let rects: Rect[] | null = given ? given.rects.map((r) => clampRect(r, cell)).filter((r): r is Rect => r !== null) : null;
      rects ??= zoneFromExisting(priors, c.clipRevisionId, c.frameId, partId, o.grow, cell);
      if (!rects) {
        clip.boxes ??= await frameContentBoxes(studio, projectId, c.clipRevisionId);
        const near = o.rig.payload.sockets.find((s) => s.purpose === "grip" && s.anatomicalSide === "right")?.socketId ?? null;
        rects = estimatedZone(partId, frame, clip.boxes[c.frameId] ?? null, cell, near).map((r) => growRect(r, 0, cell));
        estimated.push(`${clip.name}/${c.frameId}/${partId}`);
      }
      if (rects.length === 0) throw new DomainFailure("validation_failed", tx(`Zona vazia para ${partId} em ${c.frameId}`, `Empty zone for ${partId} in ${c.frameId}`));
      zones.push({ clipRevisionId: c.clipRevisionId, frameId: c.frameId, partId, rects });
    }
    const givenProtect = o.protect?.find((p) => p.clipRevisionId === c.clipRevisionId && p.frameId === c.frameId);
    protect.push({ clipRevisionId: c.clipRevisionId, frameId: c.frameId, rects: givenProtect ? [...givenProtect.rects] : handProtect(frame, cell, gripSockets) });
  }
  const warnings: LocalizedText[] = estimated.length
    ? [
        tx(
          `Zona estimada (sem desenho anterior) em ${estimated.length} célula(s): revise e amplie no gabarito se a peça for maior (ombreiras, capas)`,
          `Estimated zone (no earlier drawing) in ${estimated.length} cell(s): review it and enlarge it in the template if the piece is bigger (pauldrons, capes)`,
        ),
      ]
    : [];
  return { zones, protect, estimated, warnings };
}
