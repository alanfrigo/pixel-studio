import { z } from "zod";

/**
 * Tipos básicos compartilhados por todos os contratos.
 *
 * Convenções (02a, 04): raster com origem no canto superior esquerdo, X para a
 * direita, Y para baixo; retângulos `[x, y, w, h]` com fim exclusivo; índices de
 * pixel (sockets) são inteiros em `[0, W-1]`; pivôs/pontos de grade ficam nas
 * bordas da grade e podem valer `W` ou `H`.
 */

/** ID estável de biblioteca: letras, dígitos e `._:-`, sem espaços nem barras. */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "ID deve usar letras, dígitos e ._:- (sem espaços ou barras)");
export type Id = z.infer<typeof Id>;

/** Chave semântica (ação, slot, postura, estado, papel). Minúsculas. */
export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_.-]*$/, "Chave deve usar minúsculas, dígitos e _.-");
export type Slug = z.infer<typeof Slug>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "SHA-256 deve ter 64 dígitos hexadecimais minúsculos");

export const Int = z.number().int();
export const NonNegInt = z.number().int().nonnegative();
export const PosInt = z.number().int().positive();

/** Duração de um frame/passo; `durationMs` inteiro positivo é a autoridade temporal. */
export const DurationMs = PosInt.max(60_000);

/** Tamanho `[w, h]` em pixels lógicos. */
export const Size = z.tuple([PosInt, PosInt]);
export type Size = z.infer<typeof Size>;

/** Deslocamento inteiro `[dx, dy]` (pode ser negativo). */
export const Offset = z.tuple([Int, Int]);
export type Offset = z.infer<typeof Offset>;

/** Índice de pixel `[x, y]` (socket/encaixe anatômico). */
export const PixelIndex = z.tuple([NonNegInt, NonNegInt]);
export type PixelIndex = z.infer<typeof PixelIndex>;

/** Ponto da grade lógica `[x, y]` (pivô de cena), pode estar na borda da célula. */
export const GridPoint = z.tuple([NonNegInt, NonNegInt]);
export type GridPoint = z.infer<typeof GridPoint>;

/** Retângulo `[x, y, w, h]` em pixels do arquivo, fim exclusivo. */
export const Rect = z.tuple([NonNegInt, NonNegInt, PosInt, PosInt]);
export type Rect = z.infer<typeof Rect>;

export const Insets = z.strictObject({
  left: NonNegInt,
  right: NonNegInt,
  top: NonNegInt,
  bottom: NonNegInt,
});
export type Insets = z.infer<typeof Insets>;

/** Coordenada contínua normalizada na célula de geração (poses de esqueleto). */
export const NormalizedCoord = z.number().min(0).max(1);

export const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor deve ser #RRGGBB");

export const IsoDateTime = z.iso.datetime({ offset: true });

/** Tag de idioma BCP 47 simplificada (ex.: `pt-BR`, `en`). */
export const LanguageTag = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2}|-[A-Za-z]{4})?$/, "Idioma deve ser BCP 47 (ex.: pt-BR)");

/**
 * Caminho relativo seguro dentro de um pacote/pasta de trabalho.
 * Rejeita absolutos, `..`, `.`, barras invertidas, letras de unidade e controle.
 */
export const RelativePath = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, ctx) => {
    const problem = relativePathProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: problem });
  });

export function relativePathProblem(value: string): string | null {
  if (/[\u0000-\u001f\u007f]/.test(value)) return "Caminho contém caractere de controle";
  if (value.includes("\\")) return "Caminho deve usar /";
  if (value.startsWith("/")) return "Caminho deve ser relativo";
  if (/^[A-Za-z]:/.test(value)) return "Caminho não pode ter letra de unidade";
  const segments = value.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    return "Caminho não pode ter segmentos vazios, . ou ..";
  }
  return null;
}

/** Unidade de custo: moeda ISO 4217 ou unidade do provedor. Sem conversão implícita. */
export const CostUnit = z.union([z.enum(["credits", "generations"]), z.string().regex(/^[A-Z]{3}$/)]);
export const CostAmount = z.strictObject({
  amount: z.number().nonnegative(),
  unit: CostUnit,
});
export type CostAmount = z.infer<typeof CostAmount>;

/** Famílias de assets (01-produto-e-fluxos). */
export const AssetFamily = z.enum([
  "character",
  "item",
  "equipment",
  "vfx",
  "texture",
  "tileset",
  "ui",
  "portrait",
  "font",
  "audio",
  /** Mapas editáveis e objetos de mapa (T1). */
  "map",
]);
export type AssetFamily = z.infer<typeof AssetFamily>;

/** Papel de uma referência visual enviada à geração (03 §2). */
export const ReferenceRole = z.enum([
  "identity",
  "style",
  "pose",
  "material",
  "palette",
  "equipment",
  "silhouette",
  "composition",
]);
export type ReferenceRole = z.infer<typeof ReferenceRole>;

// ---------------------------------------------------------------------------
// Ajudantes de validação usados nos superRefine dos contratos.
// ---------------------------------------------------------------------------

type Ctx = z.RefinementCtx;

export function checkUnique<T>(ctx: Ctx, items: readonly T[], key: (item: T) => string, label: string, path: (string | number)[]) {
  const seen = new Map<string, number>();
  items.forEach((item, index) => {
    const k = key(item);
    const first = seen.get(k);
    if (first !== undefined) {
      ctx.addIssue({ code: "custom", message: `${label} duplicado: ${k}`, path: [...path, index] });
    } else {
      seen.set(k, index);
    }
  });
}

/** Retângulo posicionado em `offset` cabe em `size`? */
export function rectFits(rect: Rect, offset: Offset, size: Size): boolean {
  const [, , w, h] = rect;
  return offset[0] >= 0 && offset[1] >= 0 && offset[0] + w <= size[0] && offset[1] + h <= size[1];
}

export function gridPointInside(point: GridPoint, size: Size): boolean {
  return point[0] <= size[0] && point[1] <= size[1];
}

export function pixelIndexInside(point: PixelIndex, size: Size): boolean {
  return point[0] < size[0] && point[1] < size[1];
}

/** Ordinais devem ser exatamente 0..n-1 na ordem do array (a ordem é significativa). */
export function checkOrdinals(ctx: Ctx, items: readonly { ordinal: number }[], path: (string | number)[]) {
  items.forEach((item, index) => {
    if (item.ordinal !== index) {
      ctx.addIssue({ code: "custom", message: `Ordinal deve ser ${index}, recebido ${item.ordinal}`, path: [...path, index, "ordinal"] });
    }
  });
}
