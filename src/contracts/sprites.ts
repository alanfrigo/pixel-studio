import { z } from "zod";
import {
  checkUnique,
  DurationMs,
  GridPoint,
  gridPointInside,
  Id,
  Insets,
  Int,
  NonNegInt,
  Offset,
  PixelIndex,
  pixelIndexInside,
  Rect,
  rectFits,
  Size,
  Slug,
} from "./common";
import { AnatomicalSide } from "./motion";
import { Direction, DirectionSet, ProjectionKind, WorldToViewMap } from "./projection";

/**
 * Personagens, clipes e equipamentos (04). Base, rig, clipe e peça são
 * especializações de uma revisão de asset; vínculos sempre por ID de revisão.
 * Frames são endereçados por `(clipRevisionId, frameId)`.
 */

// ---------------------------------------------------------------------------
// Base com vistas direcionais (identidade aprovada, sem animação)
// ---------------------------------------------------------------------------

export const DirectionalView = z.strictObject({
  direction: Direction,
  fileId: Id,
  rect: Rect,
  sourceOffset: Offset,
});

export const BasePayload = z
  .strictObject({
    logicalSize: Size,
    groundOrigin: GridPoint,
    /** Estado visual (ex.: `default`, `wounded`). */
    state: Slug,
    /** Revisão do estado predecessor quando é um estado derivado. */
    predecessorRevisionId: Id.nullable(),
    views: z.array(DirectionalView).min(1).max(8),
    /**
     * Orientação das vistas (04 §isométrico): direção no mundo → vista do
     * asset na tela, com a projeção em que foram desenhadas. Opcional; sem
     * ela, a vista é a própria direção. Nunca implica espelho nem bitmap girado.
     */
    orientation: z.strictObject({ projection: ProjectionKind, worldToView: WorldToViewMap }).optional(),
  })
  .superRefine((base, ctx) => {
    checkUnique(ctx, base.views, (v) => v.direction, "Direção", ["views"]);
    if (!gridPointInside(base.groundOrigin, base.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Origem no chão fora da célula", path: ["groundOrigin"] });
    }
    base.views.forEach((v, i) => {
      if (!rectFits(v.rect, v.sourceOffset, base.logicalSize)) {
        ctx.addIssue({ code: "custom", message: "Vista não cabe na célula lógica", path: ["views", i] });
      }
    });
  });
export type BasePayload = z.infer<typeof BasePayload>;

// ---------------------------------------------------------------------------
// Rig de equipamento: anatomia vestível, slots e sockets (não é esqueleto)
// ---------------------------------------------------------------------------

export const RigSocket = z.strictObject({
  socketId: Id,
  /** Mãos nomeadas pela anatomia do personagem em todas as vistas. */
  anatomicalSide: AnatomicalSide,
  purpose: z.enum(["grip", "attach", "emit"]),
});

export const RigSlot = z.strictObject({
  slotId: Slug,
  label: z.string().min(1).max(64),
});

export const DrawablePart = z.strictObject({
  partId: Slug,
  label: z.string().min(1).max(64),
});

export const MirrorPolicy = z.discriminatedUnion("policy", [
  z.strictObject({ policy: z.literal("none") }),
  z.strictObject({
    policy: z.literal("explicit"),
    /** Espelho só como derivação autorizada e revisada; não conta como geração. */
    pairs: z.array(z.strictObject({ source: Direction, target: Direction })).min(1),
  }),
]);

export const RigPayload = z
  .strictObject({
    baseRevisionId: Id,
    logicalCell: Size,
    groundOrigin: GridPoint,
    directions: DirectionSet,
    mirror: MirrorPolicy,
    slots: z.array(RigSlot).min(1),
    sockets: z.array(RigSocket),
    parts: z.array(DrawablePart).min(1),
    stances: z.array(Slug).min(1),
    /** Desvio aceito da segunda mão sobre o encaixe, em px (inicialmente 1). */
    socketTolerancePx: NonNegInt,
  })
  .superRefine((rig, ctx) => {
    checkUnique(ctx, rig.slots, (s) => s.slotId, "Slot", ["slots"]);
    checkUnique(ctx, rig.sockets, (s) => s.socketId, "Socket", ["sockets"]);
    checkUnique(ctx, rig.parts, (p) => p.partId, "Parte", ["parts"]);
    checkUnique(ctx, rig.stances, (s) => s, "Postura", ["stances"]);
    if (!gridPointInside(rig.groundOrigin, rig.logicalCell)) {
      ctx.addIssue({ code: "custom", message: "Origem no chão fora da célula", path: ["groundOrigin"] });
    }
    if (rig.mirror.policy === "explicit") {
      rig.mirror.pairs.forEach((pair, i) => {
        if (!rig.directions.includes(pair.source) || !rig.directions.includes(pair.target)) {
          ctx.addIssue({ code: "custom", message: "Par de espelho fora das direções do rig", path: ["mirror", "pairs", i] });
        }
      });
    }
  });
export type RigPayload = z.infer<typeof RigPayload>;

// ---------------------------------------------------------------------------
// Clipe
// ---------------------------------------------------------------------------

/** Camada desenhada no frame; a ordem do array é a ordem de desenho (trás → frente). */
export const ClipLayer = z.strictObject({
  partId: Slug,
  fileId: Id,
  rect: Rect,
  /** Posição do canto superior esquerdo da região dentro da célula. */
  offset: Offset,
});

export const FrameSocket = z.strictObject({
  socketId: Id,
  at: PixelIndex,
  /** O encaixe pode ser marcado mesmo com a mão encoberta. */
  hidden: z.boolean(),
});

export const ClipFrame = z.strictObject({
  frameId: Id,
  durationMs: DurationMs,
  layers: z.array(ClipLayer).min(1),
  sockets: z.array(FrameSocket),
  /** Movimento intencional relativo à origem (passada, salto, recuo). */
  rootOffset: Offset,
});

export const ClipEvent = z.strictObject({
  eventId: Id,
  frameId: Id,
  kind: Slug,
  vfx: z
    .strictObject({
      revisionId: Id,
      socketId: Id.nullable(),
      offset: Offset,
    })
    .nullable(),
  audio: z
    .strictObject({
      revisionId: Id,
      offsetMs: NonNegInt,
    })
    .nullable(),
});

export const Playback = z.enum(["loop", "once", "ping_pong"]);

export const ClipPayload = z
  .strictObject({
    /** Objetos e VFX não exigem rig anatômico. */
    rigRevisionId: Id.nullable(),
    motionRevisionId: Id.nullable(),
    action: Slug,
    state: Slug.nullable(),
    stance: Slug.nullable(),
    direction: Direction,
    logicalSize: Size,
    pivot: GridPoint,
    /** Margens acrescentadas à célula do rig (ex.: lâmina que extrapola). */
    margins: Insets,
    playback: Playback,
    frames: z.array(ClipFrame).min(1).max(256),
    events: z.array(ClipEvent),
  })
  .superRefine((clip, ctx) => {
    checkUnique(ctx, clip.frames, (f) => f.frameId, "Frame", ["frames"]);
    checkUnique(ctx, clip.events, (e) => e.eventId, "Evento", ["events"]);
    if (!gridPointInside(clip.pivot, clip.logicalSize)) {
      ctx.addIssue({ code: "custom", message: "Pivô fora da célula", path: ["pivot"] });
    }
    clip.frames.forEach((frame, fi) => {
      frame.layers.forEach((layer, li) => {
        if (!rectFits(layer.rect, layer.offset, clip.logicalSize)) {
          ctx.addIssue({ code: "custom", message: "Camada não cabe na célula lógica", path: ["frames", fi, "layers", li] });
        }
      });
      checkUnique(ctx, frame.sockets, (s) => s.socketId, "Socket", ["frames", fi, "sockets"]);
      frame.sockets.forEach((socket, si) => {
        if (!pixelIndexInside(socket.at, clip.logicalSize)) {
          ctx.addIssue({ code: "custom", message: "Socket fora da célula", path: ["frames", fi, "sockets", si] });
        }
      });
    });
    const frameIds = new Set(clip.frames.map((f) => f.frameId));
    clip.events.forEach((event, i) => {
      if (!frameIds.has(event.frameId)) {
        ctx.addIssue({ code: "custom", message: `Evento aponta frame inexistente: ${event.frameId}`, path: ["events", i, "frameId"] });
      }
      if (!event.vfx && !event.audio) {
        ctx.addIssue({ code: "custom", message: "Evento sem efeito nem áudio", path: ["events", i] });
      }
    });
  });
export type ClipPayload = z.infer<typeof ClipPayload>;

// ---------------------------------------------------------------------------
// Peça de equipamento (overlay) e conjunto equipado (loadout)
// ---------------------------------------------------------------------------

export const CoverageCell = z.strictObject({
  clipRevisionId: Id,
  frameId: Id,
  /** `null` marca célula explicitamente vazia (pose encobre a peça). */
  layer: z
    .strictObject({
      fileId: Id,
      rect: Rect,
      offset: Offset,
    })
    .nullable(),
  /** Posição na ordem de desenho do frame (camadas da base usam seus índices). */
  drawIndex: Int,
});

export const OverlayPart = z
  .strictObject({
    partId: Slug,
    coverage: z.array(CoverageCell),
  })
  .superRefine((part, ctx) => {
    checkUnique(ctx, part.coverage, (c) => `${c.clipRevisionId}#${c.frameId}`, "Cobertura", ["coverage"]);
  });

export const RigidView = z.strictObject({
  viewId: Id,
  fileId: Id,
  rect: Rect,
  /** Pontos de empunhadura na imagem da peça (dupla empunhadura marca dois). */
  grips: z.array(z.strictObject({ socketId: Id, at: PixelIndex })).min(1),
});

export const OverlayPayload = z
  .strictObject({
    /** Item de inventário ligado à peça (ícone e arte equipada são variantes). */
    itemRevisionId: Id.nullable(),
    rigRevisionId: Id,
    slots: z.array(Slug).min(1),
    stances: z.array(Slug).min(1),
    parts: z.array(OverlayPart),
    rigidViews: z.array(RigidView),
  })
  .superRefine((overlay, ctx) => {
    checkUnique(ctx, overlay.parts, (p) => p.partId, "Parte", ["parts"]);
    checkUnique(ctx, overlay.rigidViews, (v) => v.viewId, "Vista rígida", ["rigidViews"]);
    if (overlay.parts.length === 0 && overlay.rigidViews.length === 0) {
      ctx.addIssue({ code: "custom", message: "Peça precisa de partes por frame ou vistas rígidas" });
    }
  });
export type OverlayPayload = z.infer<typeof OverlayPayload>;

export const LoadoutPayload = z
  .strictObject({
    rigRevisionId: Id,
    overlayRevisionIds: z.array(Id),
    stance: Slug,
    /** Resolução congelada de cada combinação exportada. */
    clips: z.array(
      z.strictObject({
        action: Slug,
        direction: Direction,
        clipRevisionId: Id,
      }),
    ),
  })
  .superRefine((loadout, ctx) => {
    checkUnique(ctx, loadout.overlayRevisionIds, (id) => id, "Peça", ["overlayRevisionIds"]);
    checkUnique(ctx, loadout.clips, (c) => `${c.action}/${c.direction}`, "Combinação ação/direção", ["clips"]);
  });
export type LoadoutPayload = z.infer<typeof LoadoutPayload>;
