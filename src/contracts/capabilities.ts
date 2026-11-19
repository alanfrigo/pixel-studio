import { z } from "zod";
import { Id, IsoDateTime, PosInt } from "./common";

/**
 * Matriz de capacidades por perfil/operação (03 §matriz). Capacidade declarada
 * não implica testada; `image_references` não implica `native_mask`,
 * `skeleton_keypoints` ou oito vistas coerentes. Falta de capacidade bloqueia
 * antes de cobrar.
 */

export const Capability = z.enum([
  "text_to_image",
  "image_references",
  "style_references",
  "image_edit",
  "native_mask",
  "alpha_output",
  "seed",
  "text_animation",
  "skeleton_keypoints",
  "custom_skeleton",
  "rotation_4",
  "rotation_8",
  "isometric_views",
  "character_state",
  "scene_image",
  "room_generation",
  "texture_material",
  "tileset_corner",
  "tileset_sidescroller",
  "ui_template",
  "ui_states",
  "vfx",
  "portrait",
  "visemes",
  "pixel_font",
  "music",
  "sfx",
]);
export type Capability = z.infer<typeof Capability>;

export const CapabilityStatus = z.enum(["declared", "tested", "unknown", "absent"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

export const ProviderTransport = z.enum(["openai_images", "openrouter_images", "openai_chat_multimodal", "pixellab_rest_v2"]);
export type ProviderTransport = z.infer<typeof ProviderTransport>;

export const CapabilityRecord = z.strictObject({
  providerProfileId: Id,
  /** Operação/rota (ex.: `/inpaint-v3`) ou ID de modelo + endpoint. */
  operation: z.string().min(1).max(200),
  capability: Capability,
  status: CapabilityStatus,
  limits: z.strictObject({
    maxReferences: PosInt.optional(),
    maxWidth: PosInt.optional(),
    maxHeight: PosInt.optional(),
    minWidth: PosInt.optional(),
    minHeight: PosInt.optional(),
    maxFrames: PosInt.optional(),
    minFrames: PosInt.optional(),
  }),
  /** Snapshot do contrato consultado (ex.: data do OpenAPI). */
  contractSnapshot: z.string().max(200).nullable(),
  verifiedAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
});
export type CapabilityRecord = z.infer<typeof CapabilityRecord>;
