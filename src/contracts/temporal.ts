import { z } from "zod";
import { DurationMs, GridPoint, HexColor, Id, NonNegInt, Offset, PosInt, Rect, Size, Slug } from "./common";
import { InpaintMaskConvention } from "./mask";
import { Direction } from "./projection";
import { Playback } from "./sprites";

/**
 * Estados e edição temporal (cartão S3, 04 §interpolar, editar e corrigir sem
 * refazer tudo): parâmetros das operações do plano e receitas do processador
 * local (`temporal.py`).
 *
 * Os parâmetros são formas (`shape`) montadas em `generation-plan.ts`, que
 * acrescenta a folha de referência (`sheet`) das rotas genéricas. Frames são
 * sempre endereçados por `(clipRevisionId, frameId)`; vistas por
 * `(baseRevisionId, direction)`.
 */

/** Sujeito de uma base: personagem (rig humanoide opcional) ou objeto (baú, tocha), sem rig anatômico. */
export const BaseSubject = z.enum(["character", "object"]);
export type BaseSubject = z.infer<typeof BaseSubject>;

/** Keyframe raster aprovado: quadro de clipe ou vista de uma base/estado. */
export const KeyframeRef = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("clip_frame"), clipRevisionId: Id, frameId: Id }),
  z.strictObject({ kind: z.literal("view"), baseRevisionId: Id, direction: Direction }),
]);
export type KeyframeRef = z.infer<typeof KeyframeRef>;

/**
 * Composição congelada de um quadro de entrada, trás → frente: cada camada cita
 * uma fonte do plano pelo ordinal, o retângulo no arquivo e a posição na célula.
 * O processamento local recompõe exatamente estes pixels sem consultar o catálogo.
 */
export const FrameLayout = z.strictObject({
  frameId: Id,
  layers: z.array(z.strictObject({ source: NonNegInt, rect: Rect, offset: Offset })).min(1).max(16),
});
export type FrameLayout = z.infer<typeof FrameLayout>;

const Description = z.string().min(1).max(2000);

export const TEMPORAL_PLAN_PARAMS = {
  /** Campos acrescentados a `create_state` (S3). */
  create_state: {
    subject: BaseSubject,
    logicalSize: Size,
    /** Estado já aprovado cujas vistas ficam (lacuna preenchida): a candidata acrescenta só as direções pedidas. */
    existingStateRevisionId: Id.nullable(),
  },
  animate_object: {
    /** Revisão aprovada do objeto (base ou estado), sem rig humanoide. */
    objectRevisionId: Id,
    action: Slug,
    /** Estado do objeto em que a ação começa (ex.: `closed`). */
    state: Slug,
    description: z.string().min(1).max(1000),
    direction: Direction,
    /** Durações dos quadros GERADOS (sem o quadro de referência). */
    durationsMs: z.array(DurationMs).min(1).max(40),
    playback: Playback,
    /**
     * Verdadeiro = a vista aprovada entra como quadro 0 (pixels exatos, copiados
     * localmente) e o clipe tem um quadro a mais que os gerados; falso = só os gerados.
     */
    keepFirstFrame: z.boolean(),
    firstFrameMs: DurationMs.nullable(),
    /** Pose final opcional: vista-alvo aprovada (ex.: outro estado), mesma direção e célula. */
    endFrame: z.strictObject({ revisionId: Id, direction: Direction }).nullable(),
    logicalSize: Size,
  },
  interpolate_frames: {
    start: KeyframeRef,
    end: KeyframeRef,
    /** Descrição da transição (ex.: "a tampa abre"). */
    action: z.string().min(1).max(500),
    target: z.discriminatedUnion("kind", [
      /** Inserir entre dois quadros vizinhos do mesmo clipe (os extremos ficam como estão). */
      z.strictObject({ kind: z.literal("insert"), clipRevisionId: Id, afterFrameId: Id, beforeFrameId: Id }),
      /** Novo clipe de transição entre duas vistas (estados): extremos entram uma única vez. */
      z.strictObject({
        kind: z.literal("new_clip"),
        action: Slug,
        state: Slug.nullable(),
        direction: Direction,
        startMs: DurationMs,
        endMs: DurationMs,
        playback: Playback,
      }),
    ]),
    /** Intermediários pedidos (rota genérica); `null` = a rota nativa decide quantos devolve. */
    count: z.number().int().min(1).max(14).nullable(),
    /** Duração total dos intermediários, distribuída explicitamente em ms inteiros. */
    transitionMs: DurationMs,
    logicalSize: Size,
    pivot: GridPoint,
    /** Composição dos dois keyframes (início, fim). */
    frames: z.array(FrameLayout).length(2),
  },
  edit_animation: {
    clipRevisionId: Id,
    /** Trecho selecionado, na ordem do clipe; os demais quadros ficam pelo hash. */
    frameIds: z.array(Id).min(1).max(16),
    description: Description,
    logicalSize: Size,
    frames: z.array(FrameLayout).min(1).max(16),
  },
  transfer_outfit: {
    clipRevisionId: Id,
    frameIds: z.array(Id).min(1).max(16),
    /** Referência da roupa (revisão aprovada e arquivo de imagem). */
    outfit: z.strictObject({ revisionId: Id, fileId: Id }),
    /** Estado do clipe candidato vestido; nunca substitui a base limpa nem vira overlay modular. */
    stateKey: Slug.regex(/^outfit_/, "O estado do clipe vestido começa por outfit_"),
    instructions: z.string().max(2000).nullable(),
    logicalSize: Size,
    frames: z.array(FrameLayout).min(1).max(16),
  },
  correct_frame: {
    clipRevisionId: Id,
    frameId: Id,
    /** Camada corrigida do quadro (as demais ficam como estão). */
    partId: Slug,
    /** Vizinhos enviados como contexto; nunca publicados. */
    contextFrameIds: z.array(Id).max(2),
    /** Máscara opcional (upload do projeto, 255 edita / 0 protege); `null` = o quadro inteiro pode mudar. */
    editMaskFileId: Id.nullable(),
    maskConvention: InpaintMaskConvention,
    mode: z.enum(["native-mask", "candidate-composite"]),
    instruction: z.string().min(1).max(1000),
    logicalSize: Size,
    /** Alvo primeiro, depois os vizinhos de contexto. */
    frames: z.array(FrameLayout).min(1).max(3),
  },
} as const;

/** Operações do plano acrescentadas pelo S3 (além de `create_state`, já declarada). */
export const TEMPORAL_OPERATIONS = ["animate_object", "interpolate_frames", "edit_animation", "transfer_outfit", "correct_frame"] as const;

// ---------------------------------------------------------------------------
// Receitas do processador Python (`temporal.py`)
// ---------------------------------------------------------------------------

const ComposeFrame = z.strictObject({
  key: Id,
  layers: z.array(z.strictObject({ input: NonNegInt, rect: Rect, offset: Offset })).min(1).max(16),
});

export const TEMPORAL_PYTHON_RECIPES = {
  /**
   * Recompõe quadros a partir das camadas congeladas (entradas `layer` por
   * ordinal) e, opcionalmente, monta a folha de referência ampliada por fator
   * inteiro (vizinho mais próximo), achatada numa cor-chave quando a rota não tem alfa.
   */
  compose_frames: z.strictObject({
    version: z.literal(1),
    cell: Size,
    frames: z.array(ComposeFrame).min(1).max(64),
    sheet: z
      .strictObject({
        columns: z.number().int().min(1).max(8),
        rows: z.number().int().min(1).max(8),
        scale: PosInt.max(32),
        flattenOnto: HexColor.nullable(),
      })
      .nullable(),
    /** Devolve cada quadro composto como saída (`frame`, chave = ID). */
    emitFrames: z.boolean(),
  }),
  /**
   * Folha de uma rota genérica com a MESMA disposição da referência (edição de
   * trecho, roupa, estado): cada célula é casada com o quadro original
   * (entradas `layer` 1..n) por escala comum e pelo apoio (base e x do pé), sem
   * recentralizar. Entrada `candidate` = folha já normalizada.
   */
  sheet_match: z
    .strictObject({
      version: z.literal(1),
      columns: z.number().int().min(1).max(8),
      rows: z.number().int().min(1).max(8),
      frameIds: z.array(Id).min(1).max(64),
      cell: Size,
      alphaThreshold: z.number().int().min(1).max(255),
      scaleTolerance: z.number().min(0).max(0.5),
      /**
       * `sheet` (padrão): escala pela grade da folha. `width`: pela largura mediana do
       * sujeito contra os originais (modelos que não mantêm o enquadramento da referência).
       */
      scaleBy: z.enum(["sheet", "width"]).optional(),
    })
    .refine((r) => r.frameIds.length <= r.columns * r.rows, { message: "Mais quadros que células na folha" }),
  /**
   * Espelho horizontal explícito (entradas `layer`); a entrada opcional `source`
   * é a vista frontal usada para medir a assimetria do sujeito.
   */
  mirror_frames: z.strictObject({
    version: z.literal(1),
    /** Fração de pixels opacos que divergem do próprio espelho acima da qual o sujeito é assimétrico. */
    asymmetryThreshold: z.number().min(0).max(1),
  }),
  /**
   * Canvas sem gerar pixels: coloca a imagem (`source`) numa tela nova com o
   * deslocamento dado. Recortar pixels visíveis falha.
   */
  canvas_fit: z.strictObject({
    version: z.literal(1),
    size: Size,
    offset: Offset,
  }),
} as const;
