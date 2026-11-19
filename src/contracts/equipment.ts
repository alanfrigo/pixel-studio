import { z } from "zod";
import { HexColor, Id, NonNegInt, Offset, PixelIndex, PosInt, Rect, Sha256Hex, Size, Slug } from "./common";

/**
 * Roupas e equipamentos (cartão S2, 04 §criar uma roupa e §contratos): receitas
 * do processador local (`equipment.py`) e parâmetros do plano "Criar peça
 * para este personagem". Coordenadas em pixels inteiros da célula, X à
 * direita, Y para baixo; retângulos com fim exclusivo.
 */

// ---------------------------------------------------------------------------
// Receitas do processador Python
// ---------------------------------------------------------------------------

/** Camada já resolvida pelo domínio: entrada (`layer`), recorte na imagem e posição na célula. */
const ComposeLayer = z.strictObject({
  /** Chave estável da camada na pilha (ex.: `base:body`, `part:<rev>:torso`, `rigid:<rev>`). */
  key: z.string().min(1).max(200),
  inputOrdinal: NonNegInt,
  rect: Rect,
  offset: Offset,
  /** Espelho horizontal autorizado (índice de pixel `W − 1 − x`). */
  mirrored: z.boolean(),
  /** Empunhaduras na vista (antes do espelho) e o socket do frame que cada uma deve tocar. */
  grips: z.array(z.strictObject({ socketId: Id, at: PixelIndex, expected: PixelIndex })).max(4).optional(),
});

export const EQUIPMENT_PYTHON_RECIPES = {
  /**
   * Compositor (05 §composição): camadas trás → frente com offsets inteiros,
   * uma prévia por frame e a folha achatada (frames lado a lado, na ordem).
   * Também confere, nos pixels, se cada empunhadura caiu no socket esperado.
   */
  equipment_compose: z.strictObject({
    version: z.literal(1),
    cell: Size,
    frames: z
      .array(z.strictObject({ frameId: Id, layers: z.array(ComposeLayer).max(32) }))
      .min(1)
      .max(64),
    /** Desvio aceito entre empunhadura e socket (Chebyshev, px). */
    tolerancePx: NonNegInt.max(16),
  }),
  /**
   * Extração de cobertura (04 §criar uma roupa, item 4): diferença entre o
   * candidato vestido e a base limpa DENTRO da zona autorizada de cada parte,
   * fora das proteções (olhos, mãos). Registro por deslocamento inteiro antes
   * da diferença; bordas validadas.
   */
  equipment_extract: z.strictObject({
    version: z.literal(1),
    cell: Size,
    frames: z
      .array(
        z.strictObject({
          frameId: Id,
          /** Entrada `layer` com o frame limpo da base (composição das camadas da base). */
          baseOrdinal: NonNegInt,
          /** Entrada `candidate` e o retângulo do frame dentro dela (tira em grade ou imagem por frame). */
          candidateOrdinal: NonNegInt,
          candidateRect: Rect,
          parts: z.array(z.strictObject({ partId: Slug, zones: z.array(Rect).min(1).max(16) })).min(1).max(8),
          protect: z.array(Rect).max(32),
        }),
      )
      .min(1)
      .max(64),
    /** Diferença máxima por canal considerada "igual à base". */
    tolerance: z.number().int().min(0).max(128),
    alphaThreshold: z.number().int().min(1).max(255),
    /** Busca do deslocamento inteiro que melhor alinha o candidato à base (fora das zonas). */
    maxShift: z.number().int().min(0).max(8),
    /** Componentes soltos menores que isto (px) são descartados como ruído. */
    minComponentPx: z.number().int().min(0).max(64),
    /** Cores que nunca são peça (cor-chave e cor da guia residuais), com tolerância por canal. */
    forbidColors: z.array(HexColor).max(4).optional(),
    forbidTolerance: z.number().int().min(0).max(128).optional(),
  }),
  /**
   * Referências da geração de cobertura: frames da base em grade, ampliados por
   * fator inteiro, e a mesma grade com a zona autorizada pintada de cor chapada.
   */
  equipment_guide: z.strictObject({
    version: z.literal(1),
    cell: Size,
    /** Tela lógica (≥ grade); cada frame vai no seu canto `at`. */
    canvas: Size,
    frames: z
      .array(z.strictObject({ frameId: Id, baseOrdinal: NonNegInt, at: Offset, zones: z.array(Rect).max(64), protect: z.array(Rect).max(32) }))
      .min(1)
      .max(16),
    scale: PosInt.max(32),
    markColor: HexColor,
    /** Rota sem alfa: o fundo transparente vira esta cor-chave (removida localmente na volta). */
    flattenOnto: HexColor.nullable(),
  }),
  /** Hash RGBA canônico de regiões (digest de geometria por frame). */
  equipment_region_hashes: z.strictObject({
    version: z.literal(1),
    regions: z.array(z.strictObject({ key: z.string().min(1).max(200), inputOrdinal: NonNegInt, rect: Rect })).min(1).max(512),
  }),
} as const;

// ---------------------------------------------------------------------------
// Plano "Criar peça para este personagem" (operação `generate_overlay_coverage`)
// ---------------------------------------------------------------------------

/**
 * Uma tira gerada: frames de um clipe numa grade colunas × linhas (1 × 1 = um
 * frame por imagem), centrada numa tela de proporção padrão. As camadas da base
 * de cada frame ficam congeladas pelo hash (a base limpa é recomposta igual).
 */
export const CoverageStrip = z.strictObject({
  stripKey: Id,
  clipRevisionId: Id,
  cell: Size,
  /** Tela lógica enviada (≥ grade), com a proporção pedida à rota. */
  canvas: Size,
  columns: z.number().int().min(1).max(4),
  rows: z.number().int().min(1).max(4),
  frames: z
    .array(
      z.strictObject({
        frameId: Id,
        /** Canto da célula do frame dentro da tela. */
        at: Offset,
        /** Partes a publicar deste frame (as lacunas); ausente = todas as partes do plano. */
        parts: z.array(Slug).min(1).max(8).optional(),
        layers: z.array(z.strictObject({ sha256: Sha256Hex, rect: Rect, offset: Offset })).min(1).max(16),
      }),
    )
    .min(1)
    .max(16),
});
export type CoverageStrip = z.infer<typeof CoverageStrip>;

/** Zona autorizada (editável) de uma parte num frame: união de retângulos. */
export const CoverageZone = z.strictObject({ clipRevisionId: Id, frameId: Id, partId: Slug, rects: z.array(Rect).min(1).max(16) });
export type CoverageZone = z.infer<typeof CoverageZone>;

/** Regiões da base protegidas dentro da zona (olhos, mãos): nunca viram peça. */
export const ProtectZone = z.strictObject({ clipRevisionId: Id, frameId: Id, rects: z.array(Rect).max(32) });
export type ProtectZone = z.infer<typeof ProtectZone>;

/** Célula que NÃO será gerada: reaproveita desenho existente ou de pose equivalente (mesmo digest). */
export const ReusedCell = z.strictObject({
  clipRevisionId: Id,
  frameId: Id,
  partId: Slug,
  from: z.strictObject({ clipRevisionId: Id, frameId: Id }),
  reason: z.enum(["existing", "equivalent_pose"]),
});
export type ReusedCell = z.infer<typeof ReusedCell>;

const pieceCommon = {
  rigRevisionId: Id,
  /** Revisão aprovada da peça que recebe o resultado (`null` = peça nova). */
  overlayRevisionId: Id.nullable(),
  slots: z.array(Slug).min(1),
  stances: z.array(Slug).min(1),
  itemDescription: z.string().min(1).max(500),
  /** Rota sem alfa: fundo de cor-chave pedido no prompt e removido localmente. */
  backgroundKey: HexColor.nullable(),
};

export const OverlayCoverageParams = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("coverage"),
    ...pieceCommon,
    parts: z.array(Slug).min(1).max(8),
    strips: z.array(CoverageStrip).min(1).max(24),
    zones: z.array(CoverageZone).min(1).max(512),
    protect: z.array(ProtectZone).max(512),
    reused: z.array(ReusedCell).max(512),
    /** Começar por uma pose de prova: só um frame é gerado; o resto espera a aprovação. */
    proofPose: z.boolean(),
    /**
     * Rota genérica: candidato vestido por imagem + referências, com a peça
     * recuperada localmente por máscara explícita. Nunca é máscara nativa.
     */
    strategy: z.literal("dressed_candidate"),
    markColor: HexColor,
  }),
  z.strictObject({
    mode: z.literal("rigid_view"),
    ...pieceCommon,
    viewId: Id,
    size: Size,
    /** Empunhaduras na arte da vista; dupla empunhadura marca duas. */
    grips: z.array(z.strictObject({ socketId: Id, at: PixelIndex })).min(1).max(2),
    mirrorAllowed: z.boolean(),
    orientation: z.enum(["vertical_up", "vertical_down", "horizontal_right", "horizontal_left", "diagonal_up", "diagonal_down"]),
  }),
]);
export type OverlayCoverageParams = z.infer<typeof OverlayCoverageParams>;
