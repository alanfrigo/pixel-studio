import { z } from "zod";
import { checkOrdinals, GridPoint, HexColor, Id, NonNegInt, Offset, PosInt, RelativePath, Sha256Hex, Size } from "./common";
import { DurationMs } from "./common";
import { WORLD_PYTHON_RECIPES } from "./world";

/**
 * Fronteira Node ↔ Python (05 §entrada e saída). Um subprocesso por tarefa,
 * JSON por stdin/stdout, arquivos só dentro da pasta da tentativa. Node é dono
 * do SQLite, dos blobs e da publicação. Versão desconhecida = falha legível.
 */

export const PYTHON_PROTOCOL_VERSION = 1 as const;

export const PythonInputRole = z.enum(["source", "candidate", "poseGuide", "editMask", "keepMask", "removeMask", "palette", "layer"]);

export const PythonInput = z.strictObject({
  ordinal: NonNegInt,
  role: PythonInputRole,
  sha256: Sha256Hex,
  relPath: RelativePath,
});

const Limits = z.strictObject({
  maxBytes: PosInt,
  maxWidth: PosInt,
  maxHeight: PosInt,
  maxPixels: PosInt,
  maxFrames: PosInt,
});

const recipes = {
  ingest_inspect: z.strictObject({ version: z.literal(1), limits: Limits }),
  slice_grid: z
    .strictObject({
      version: z.literal(1),
      grid: z.strictObject({
        rows: PosInt,
        columns: PosInt,
        cell: Size,
        margin: z.tuple([NonNegInt, NonNegInt]),
        spacing: z.tuple([NonNegInt, NonNegInt]),
        traversal: z.enum(["row_major", "column_major"]),
      }),
      frameIds: z.array(Id).min(1),
      durationMs: z.array(DurationMs).min(1),
      pivot: GridPoint,
      /** Índices de células explicitamente vazias (na ordem de percurso). */
      emptyCells: z.array(NonNegInt),
    })
    .superRefine((r, ctx) => {
      if (r.frameIds.length !== r.durationMs.length) {
        ctx.addIssue({ code: "custom", message: "frameIds e durationMs devem ter o mesmo tamanho" });
      }
      if (r.frameIds.length > r.grid.rows * r.grid.columns) {
        ctx.addIssue({ code: "custom", message: "Mais frames que células na grade" });
      }
    }),
  /** Restauração exata: candidato onde editMask=255, fonte onde editMask=0. */
  composite_protected: z.strictObject({
    version: z.literal(1),
    maskConvention: z.literal("white_edits_black_preserves"),
  }),
  /** Valida a máscara de edição na grade da fonte e conta a região editável (sem enviar nada). */
  inspect_mask: z.strictObject({
    version: z.literal(1),
    maskConvention: z.literal("white_edits_black_preserves"),
  }),
  /**
   * Modo candidata + composição: amplia a fonte por fator inteiro (contexto) e
   * gera a guia com a região editável pintada numa cor de marcação chapada.
   */
  inpaint_guide: z.strictObject({
    version: z.literal(1),
    scale: PosInt.max(64),
    markColor: HexColor,
    /** Achata a transparência da fonte (rota sem alfa). */
    flattenOnto: HexColor.optional(),
  }),
  apply_palette: z.strictObject({
    version: z.literal(1),
    metric: z.literal("srgb8_squared"),
    tieBreak: z.literal("lowest_index"),
    dither: z.literal(false),
    colors: z.array(HexColor).min(1).max(256),
  }),
  compose_layers: z.strictObject({
    version: z.literal(1),
    canvas: Size,
    /** Ordem de desenho trás → frente. */
    layers: z.array(z.strictObject({ inputOrdinal: NonNegInt, offset: Offset })).min(1),
  }),
  /**
   * Fundo uniforme: remove (alfa 0) os pixels dentro da tolerância da cor fixa
   * amostrada, conectados pelas 4 vizinhanças às sementes. Só muda alfa.
   * Entradas opcionais `keepMask`/`removeMask` (255 = marcado) vêm do pincel.
   */
  remove_background_flood: z
    .strictObject({
      version: z.literal(1),
      color: HexColor,
      /** Diferença máxima por canal em relação à cor fixa amostrada. */
      tolerance: z.number().int().min(0).max(255),
      seeds: z.strictObject({
        /** Semeia todos os pixels da borda da imagem. */
        borders: z.boolean(),
        /** Sementes internas explícitas (ex.: vão do braço). */
        points: z.array(z.tuple([NonNegInt, NonNegInt])),
      }),
      connectivity: z.literal(4),
      /**
       * `rgb`: diferença por canal até a tolerância (padrão). `hue`: mesma
       * família de cor da chave em qualquer brilho (remove a sombra da cor-chave),
       * sem tocar cinzas e contornos escuros.
       */
      match: z
        .discriminatedUnion("mode", [
          z.strictObject({ mode: z.literal("rgb") }),
          z.strictObject({
            mode: z.literal("hue"),
            hueTolerance: z.number().min(1).max(90),
            minSaturation: z.number().int().min(0).max(255),
            /** Brilho mínimo para contar como fundo: contornos escuros tingidos ficam. */
            minValue: z.number().int().min(0).max(255).optional(),
            /** `border`: mede a matiz real do fundo na borda (modelos raramente obedecem a cor pedida). */
            keyFrom: z.enum(["color", "border"]).optional(),
            /** Remove franja tingida colada ao fundo e salpicos isolados (padrão: sim). */
            cleanup: z.boolean().optional(),
          }),
        ])
        .optional(),
    })
    .refine((r) => r.seeds.borders || r.seeds.points.length > 0, { message: "Informe sementes de borda ou pontos internos" }),
  /** Recorte justo pelo canal alfa com padding uniforme; relata o retângulo e o deslocamento. */
  crop_to_content: z.strictObject({
    version: z.literal(1),
    padding: NonNegInt,
    /** Pixels com alfa acima deste valor contam como conteúdo. */
    alphaThreshold: z.number().int().min(0).max(254),
  }),
  /**
   * Leva uma imagem à escala lógica: fator inteiro exato amostra o centro de
   * cada bloco (sem detalhe novo); fator não inteiro reduz por média e pede revisão.
   * Proporção diferente encaixa centralizado sobre transparente.
   */
  fit_logical: z.strictObject({
    version: z.literal(1),
    targetSize: Size,
    /** Recorta ao conteúdo visível antes de ajustar (ícone isolado), com margem em px de origem. */
    cropToContent: z.strictObject({ padding: NonNegInt }).optional(),
    /**
     * Binariza o alfa antes de recortar: abaixo do limiar vira transparente,
     * acima vira opaco. Pixel art não tem meia-transparência nas bordas.
     */
    alphaThreshold: z.number().int().min(1).max(255).optional(),
    /**
     * Candidato de edição: proporção tem de bater com o alvo (tolerância de 1%);
     * diferente disso falha em vez de centralizar ou esticar.
     */
    exactAspect: z.boolean().optional(),
  }),
  /**
   * Detecta a grade aparente da arte (célula possivelmente fracionária) e
   * devolve a imagem na resolução dessa grade, amostrando o centro de cada célula.
   */
  unzoom: z.strictObject({
    version: z.literal(1),
    /** Fração mínima dos pixels que a grade precisa reproduzir para ser aceita. */
    minAgreement: z.number().min(0).max(1),
    /** Mede a concordância só no objeto, ignorando a família de cor-chave da borda (degradês do fundo). */
    ignoreKeyHue: z
      .strictObject({ hueTolerance: z.number().min(1).max(90), minSaturation: z.number().int().min(0).max(255), minValue: z.number().int().min(0).max(255).optional() })
      .optional(),
    /**
     * Rejeita grades grossas demais: o objeto precisa ocupar ao menos esse
     * número de células no lado maior (ex.: metade do tamanho lógico).
     */
    minContentCells: z.number().int().min(1).max(4096).optional(),
  }),
  /**
   * Converte a máscara local (255 edita, 0 preserva) para a codificação de um
   * provedor: `alpha_zero_edits` (OpenAI: alfa = 255 − E) ou a própria convenção.
   */
  encode_mask: z.strictObject({
    version: z.literal(1),
    encoding: z.enum(["alpha_zero_edits", "white_edits_black_preserves"]),
  }),
  /** Miniatura com vizinho mais próximo e fator inteiro (amplia arte pequena, reduz arte grande). */
  make_thumbnail: z.strictObject({
    version: z.literal(1),
    maxSize: PosInt.max(1024),
    /** Achata a transparência sobre uma cor sólida (ex.: referência enviada a rota sem alfa). */
    flattenOnto: HexColor.optional(),
  }),
  /**
   * Animação (S1, `animation.py`): folha de quadros de uma rota genérica
   * (`candidate`) → quadros na célula lógica da base (`source`). Divide em
   * colunas × linhas, mede o conteúdo de cada região, aplica UM fator de escala
   * comum (altura mediana × altura da base) e assenta cada quadro pelo apoio no
   * chão da base, sem recentralizar pela caixa do conteúdo.
   */
  animation_sheet: z
    .strictObject({
      version: z.literal(1),
      columns: z.number().int().min(1).max(8),
      rows: z.number().int().min(1).max(8),
      frameIds: z.array(Id).min(1).max(64),
      cell: Size,
      alphaThreshold: z.number().int().min(1).max(255),
      /** Desvio relativo de escala abaixo do qual os quadros não são reamostrados. */
      scaleTolerance: z.number().min(0).max(0.5),
      /**
       * Deslocamento horizontal desenhado entre quadros (recuo, avanço). Ciclos no
       * lugar (andar, correr, respirar) ancoram o pé no pivô: o deslocamento ali é
       * ruído de posicionamento do modelo. A altura (salto) é sempre preservada.
       */
      keepHorizontalOffsets: z.boolean(),
    })
    .refine((r) => r.frameIds.length <= r.columns * r.rows, { message: "Mais quadros que células na folha" }),
  /** Animação: quadros (`layer`, na ordem) lado a lado em zoom inteiro, para revisão e relatório. */
  animation_contact_sheet: z.strictObject({
    version: z.literal(1),
    cell: Size,
    zoom: z.number().int().min(1).max(16),
    /** `null` = quadriculado; senão fundo chapado. */
    background: HexColor.nullable(),
    columns: z.number().int().min(1).max(64),
    gap: z.number().int().min(0).max(64),
  }),
  /** Mundo (T1): emendas, gabaritos de tileset e losangos isométricos (`world.ts`). */
  ...WORLD_PYTHON_RECIPES,
} as const;

export type PythonOperation = keyof typeof recipes;

const requestBase = {
  protocolVersion: z.literal(PYTHON_PROTOCOL_VERSION),
  jobId: Id,
  attemptId: Id,
  inputs: z.array(PythonInput),
};

function request<O extends PythonOperation>(operation: O) {
  return z.strictObject({ ...requestBase, operation: z.literal(operation), recipe: recipes[operation] });
}

export const PythonRequest = z
  .discriminatedUnion("operation", [
    request("ingest_inspect"),
    request("slice_grid"),
    request("composite_protected"),
    request("apply_palette"),
    request("compose_layers"),
    request("remove_background_flood"),
    request("crop_to_content"),
    request("make_thumbnail"),
    request("fit_logical"),
    request("encode_mask"),
    request("inspect_mask"),
    request("inpaint_guide"),
    request("unzoom"),
    request("animation_sheet"),
    request("animation_contact_sheet"),
    request("texture_seams"),
    request("corner_guides"),
    request("side_guides"),
    request("tileset_seams"),
    request("tile_edit_mask"),
    request("iso_pieces"),
    request("iso_check"),
  ])
  .superRefine((r, ctx) => checkOrdinals(ctx, r.inputs, ["inputs"]));
export type PythonRequest = z.infer<typeof PythonRequest>;

export const PythonOutput = z.strictObject({
  role: z.string().min(1).max(64),
  /** Identifica a saída quando a operação produz várias (ex.: frame fatiado). */
  key: z.string().min(1).max(128).optional(),
  relPath: RelativePath,
  mime: z.enum(["image/png", "application/json"]),
  width: PosInt.optional(),
  height: PosInt.optional(),
  sha256: Sha256Hex,
  /** Hash dos pixels RGBA canônicos (RGB zerado onde alfa = 0). */
  rgbaSha256: Sha256Hex.optional(),
});

export const PythonResponse = z.discriminatedUnion("status", [
  z.strictObject({
    protocolVersion: z.literal(PYTHON_PROTOCOL_VERSION),
    status: z.literal("ok"),
    outputs: z.array(PythonOutput),
    report: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    protocolVersion: z.literal(PYTHON_PROTOCOL_VERSION),
    status: z.literal("needs_review"),
    outputs: z.array(PythonOutput),
    report: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()).min(1),
  }),
  z.strictObject({
    protocolVersion: z.literal(PYTHON_PROTOCOL_VERSION),
    status: z.literal("error"),
    error: z.strictObject({
      code: z.enum(["unsupported_protocol", "invalid_request", "unsupported_input", "decode_failed", "limit_exceeded", "geometry_mismatch", "internal"]),
      message: z.string().min(1),
    }),
  }),
]);
export type PythonResponse = z.infer<typeof PythonResponse>;
