import { z } from "zod";
import { type AssetFamily, Id, PosInt, RelativePath, Sha256Hex, Slug } from "./common";
import { AudioPayload, ExpressionPayload, FontPayload, PortraitPayload, SpeechPayload } from "./dialogue-audio";
import { MotionPayload } from "./motion";
import { BasePayload, ClipPayload, LoadoutPayload, OverlayPayload, RigPayload } from "./sprites";
import { ButtonPayload, MenuItemPayload, MeterPayload, PanelPayload, ScreenPayload, SlotPayload } from "./ui";
import { ItemPayload, VfxPayload } from "./vfx-item";
import { CornerTilesetPayload, IsoTilesetPayload, MapObjectPayload, SideTilesetPayload, TexturePayload, TilemapPayload } from "./world";

/**
 * Formato portátil v1 (02a §formato portátil): ZIP com `manifest.json` na raiz.
 * `files[]` cataloga mídia por modalidade; dimensões só existem em raster.
 * `entries[]` descreve revisões com payload tipado por família/tipo.
 * Prompts, referências de trabalho, segredos e caminhos internos NÃO entram.
 */

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_FILE_NAME = "manifest.json";

const fileBase = {
  fileId: Id,
  path: RelativePath,
  bytes: PosInt,
  sha256: Sha256Hex,
};

export const RasterMime = z.enum(["image/png"]);
export const AudioMime = z.enum(["audio/wav", "audio/ogg", "audio/mpeg", "audio/flac"]);
export const FontMime = z.enum(["font/ttf", "font/otf"]);
export const DataMime = z.enum(["application/json"]);

export const RasterFile = z.strictObject({
  ...fileBase,
  mime: RasterMime,
  width: PosInt,
  height: PosInt,
});

export const AudioFile = z.strictObject({
  ...fileBase,
  mime: AudioMime,
  durationMs: PosInt,
  sampleRate: PosInt,
  channels: z.number().int().min(1).max(8),
  /** Frames de amostra; base dos pontos de loop. */
  frameCount: PosInt,
  codec: z.string().min(1).max(32),
});

export const FontFile = z.strictObject({
  ...fileBase,
  mime: FontMime,
  glyphCount: PosInt,
});

/** Arquivos de destino adicionais (ex.: TMJ/TSJ do Tiled). */
export const DataFile = z.strictObject({
  ...fileBase,
  mime: DataMime,
  purpose: Slug,
});

export const ManifestFile = z.discriminatedUnion("mime", [RasterFile, AudioFile, FontFile, DataFile]);
export type ManifestFile = z.infer<typeof ManifestFile>;

export type FileModality = "raster" | "audio" | "font" | "data";

export function fileModality(file: ManifestFile): FileModality {
  if (RasterMime.safeParse(file.mime).success) return "raster";
  if (AudioMime.safeParse(file.mime).success) return "audio";
  if (FontMime.safeParse(file.mime).success) return "font";
  return "data";
}

export const Dependency = z.strictObject({
  revisionId: Id,
  /** Papel da dependência runtime, ex.: `rig`, `clip`, `icon`, `vfx`. */
  role: Slug,
});
export type Dependency = z.infer<typeof Dependency>;

const entryBase = {
  assetId: Id,
  revisionId: Id,
  name: z.string().min(1).max(120).optional(),
  dependencies: z.array(Dependency),
};

function entry<F extends string, K extends z.ZodType<string>, P extends z.ZodType>(family: F, kind: K, payload: P) {
  return z.strictObject({ ...entryBase, family: z.literal(family), kind, payload });
}

export const VFX_KINDS = ["burst", "loop", "trail", "aura", "impact", "ambient"] as const;
export const ITEM_KINDS = ["consumable", "gear", "key_item", "material", "misc"] as const;

export const CharacterEntry = z.discriminatedUnion("kind", [
  entry("character", z.literal("base"), BasePayload),
  entry("character", z.literal("rig"), RigPayload),
  entry("character", z.literal("clip"), ClipPayload),
  entry("character", z.literal("motion"), MotionPayload),
]);

export const EquipmentEntry = z.discriminatedUnion("kind", [
  entry("equipment", z.literal("overlay"), OverlayPayload),
  entry("equipment", z.literal("loadout"), LoadoutPayload),
]);

export const UiEntry = z.discriminatedUnion("kind", [
  entry("ui", z.literal("button"), ButtonPayload),
  entry("ui", z.literal("panel"), PanelPayload),
  entry("ui", z.literal("slot"), SlotPayload),
  entry("ui", z.literal("meter"), MeterPayload),
  entry("ui", z.literal("menu_item"), MenuItemPayload),
  entry("ui", z.literal("screen"), ScreenPayload),
]);

export const PortraitEntry = z.discriminatedUnion("kind", [
  entry("portrait", z.literal("portrait"), PortraitPayload),
  entry("portrait", z.literal("expression"), ExpressionPayload),
  entry("portrait", z.literal("speech"), SpeechPayload),
]);

/** Tilesets (T1): cantos top-down, tabela lateral própria e peças isométricas. */
export const TilesetEntry = z.discriminatedUnion("kind", [
  entry("tileset", z.literal("corner"), CornerTilesetPayload),
  entry("tileset", z.literal("sidescroller"), SideTilesetPayload),
  entry("tileset", z.literal("isometric"), IsoTilesetPayload),
]);

/** Mapas editáveis e objetos de mapa (T1). */
export const MapEntry = z.discriminatedUnion("kind", [
  entry("map", z.literal("tilemap"), TilemapPayload),
  entry("map", z.literal("object"), MapObjectPayload),
]);

export const ManifestEntry = z.discriminatedUnion("family", [
  CharacterEntry,
  entry("item", z.enum(ITEM_KINDS), ItemPayload),
  EquipmentEntry,
  entry("vfx", z.enum(VFX_KINDS), VfxPayload),
  entry("texture", z.literal("material"), TexturePayload),
  TilesetEntry,
  UiEntry,
  PortraitEntry,
  entry("font", z.literal("bitmap"), FontPayload),
  entry("audio", z.enum(["music", "sfx"]), AudioPayload),
  MapEntry,
]);
export type ManifestEntry = z.infer<typeof ManifestEntry>;

/** Tipos aceitos por família (mesma lista da união `ManifestEntry`). */
export const ASSET_KINDS = {
  character: ["base", "rig", "clip", "motion"],
  item: ITEM_KINDS,
  equipment: ["overlay", "loadout"],
  vfx: VFX_KINDS,
  texture: ["material"],
  tileset: ["corner", "sidescroller", "isometric"],
  ui: ["button", "panel", "slot", "meter", "menu_item", "screen"],
  portrait: ["portrait", "expression", "speech"],
  font: ["bitmap"],
  audio: ["music", "sfx"],
  map: ["tilemap", "object"],
} as const satisfies Record<AssetFamily, readonly string[]>;

export function isKnownKind(family: AssetFamily, kind: string): boolean {
  return (ASSET_KINDS[family] as readonly string[]).includes(kind);
}

/**
 * Valida o payload de uma revisão pela mesma união do manifesto, devolvendo os
 * problemas com caminhos relativos ao payload.
 */
export function parseRevisionPayload(family: AssetFamily, kind: string, payload: unknown) {
  const result = ManifestEntry.safeParse({ assetId: "x", revisionId: "x", family, kind, dependencies: [], payload });
  if (result.success) return { success: true as const, entry: result.data };
  return {
    success: false as const,
    issues: result.error.issues.map((i) => ({ path: i.path.slice(i.path[0] === "payload" ? 1 : 0).map(String), message: i.message })),
  };
}

export const Attribution = z.strictObject({
  /** `fileId` ou `revisionId` a que o crédito se aplica. */
  subject: Id,
  text: z.string().min(1).max(1000),
  license: z.string().min(1).max(120).optional(),
});

export const Manifest = z.strictObject({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  projectId: Id,
  profile: z.enum(["portable-v1"]),
  generator: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(32) }).optional(),
  files: z.array(ManifestFile),
  entries: z.array(ManifestEntry),
  attributions: z.array(Attribution).optional(),
});
export type Manifest = z.infer<typeof Manifest>;
