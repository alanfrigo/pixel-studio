import type { GenerationPlan, Manifest, ManifestEntry, ManifestFile, StylePayload } from "@/contracts";
import { canonicalDigest } from "@/domain/canonical-json";
import { entryRefs } from "@/domain/manifest/refs";
import { sha256Hex } from "@/domain/manifest/verify-files";
import type { CatalogRevision, CatalogUpload } from "@/domain/plan/references";
import { createImage, encodePng, fillRect, setPixel, type RgbaImage } from "@/lib/media/png";
import {
  ATTACK_FRAMES,
  buttonAtlas,
  C,
  chainmailAtlas,
  FONT_CELL,
  FONT_GLYPHS,
  fontAtlas,
  grassWaterAtlas,
  HIT_SFX,
  hitSfx,
  MAIL,
  meterAtlas,
  potionSheet,
  sparkAtlas,
  warriorAttackStrip,
  warriorBase,
} from "./art";

/**
 * Fixture "clareira" (README · a cena que comprova o produto): pacote portátil
 * v1, catálogo do projeto e planos de geração de exemplo. Construída em memória
 * e gravada por `npm run fixtures:build`; os testes conferem que o disco bate.
 */

export const PROJECT_ID = "clareira";
export const OTHER_PROJECT_ID = "deserto";
export const STYLE_ID = "clareira-style-a";

export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
}

export interface ClareiraFixture {
  manifest: Manifest;
  /** Conteúdo do pacote, incluindo `manifest.json`. */
  packageFiles: FixtureFile[];
  /** Arquivos de trabalho do projeto (uploads, referências) fora do pacote. */
  projectFiles: FixtureFile[];
  style: StylePayload;
  catalog: { revisions: CatalogRevision[]; uploads: CatalogUpload[] };
  plans: Record<string, GenerationPlan>;
}

function rasterFile(fileId: string, path: string, img: RgbaImage) {
  const bytes = encodePng(img);
  const record: ManifestFile = {
    fileId,
    path,
    mime: "image/png",
    width: img.width,
    height: img.height,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
  };
  return { record, bytes };
}

const frameIds = ATTACK_FRAMES.map((f) => f.frameId);

function buildEntries(): ManifestEntry[] {
  const rig = "warrior-rig-v1";
  const clip = "warrior-attack-osh-s-v1";
  const motion = "warrior-attack-motion-v1";

  const pose = (hand: readonly [number, number], lean: number) => ({
    hip: { x: 0.5, y: 0.66, visible: true, zIndex: 0 },
    chest: { x: (32 + lean) / 64, y: 0.45, visible: true, zIndex: 1 },
    head: { x: (32 + lean) / 64, y: 0.25, visible: true, zIndex: 2 },
    shoulder_r: { x: (41 + lean) / 64, y: 0.4, visible: true, zIndex: 3 },
    hand_r: { x: hand[0] / 64, y: hand[1] / 64, visible: true, zIndex: 4 },
    shoulder_l: { x: (22 + lean) / 64, y: 0.4, visible: true, zIndex: -1 },
    hand_l: { x: (20 + lean) / 64, y: 37 / 64, visible: false, zIndex: -2 },
  });

  return [
    {
      assetId: "warrior",
      revisionId: "warrior-base-v1",
      family: "character",
      kind: "base",
      name: "Guerreiro",
      dependencies: [],
      payload: {
        logicalSize: [64, 64],
        groundOrigin: [32, 60],
        state: "default",
        predecessorRevisionId: null,
        views: [{ direction: "S", fileId: "warrior-base-s", rect: [0, 0, 64, 64], sourceOffset: [0, 0] }],
      },
    },
    {
      assetId: "warrior",
      revisionId: rig,
      family: "character",
      kind: "rig",
      dependencies: [{ revisionId: "warrior-base-v1", role: "base" }],
      payload: {
        baseRevisionId: "warrior-base-v1",
        logicalCell: [64, 64],
        groundOrigin: [32, 60],
        directions: ["N", "E", "S", "W"],
        mirror: { policy: "none" },
        slots: [
          { slotId: "main_hand", label: "Mão principal" },
          { slotId: "off_hand", label: "Mão secundária" },
          { slotId: "torso", label: "Torso" },
        ],
        sockets: [
          { socketId: "hand_right", anatomicalSide: "right", purpose: "grip" },
          { socketId: "hand_left", anatomicalSide: "left", purpose: "grip" },
        ],
        parts: [
          { partId: "body", label: "Corpo" },
          { partId: "torso", label: "Torso" },
          { partId: "sleeve_near", label: "Manga próxima" },
        ],
        stances: ["one_hand_shield", "two_handed"],
        socketTolerancePx: 1,
      },
    },
    {
      assetId: "warrior-attack-motion",
      revisionId: motion,
      family: "character",
      kind: "motion",
      dependencies: [{ revisionId: rig, role: "rig" }],
      payload: {
        skeleton: {
          kind: "custom",
          joints: [
            { jointId: "hip", name: "Quadril", parent: null, anatomicalSide: "center" },
            { jointId: "chest", name: "Peito", parent: "hip", anatomicalSide: "center" },
            { jointId: "head", name: "Cabeça", parent: "chest", anatomicalSide: "center" },
            { jointId: "shoulder_r", name: "Ombro direito", parent: "chest", anatomicalSide: "right", cameraSide: "near" },
            { jointId: "hand_r", name: "Mão direita", parent: "shoulder_r", anatomicalSide: "right", cameraSide: "near" },
            { jointId: "shoulder_l", name: "Ombro esquerdo", parent: "chest", anatomicalSide: "left", cameraSide: "far" },
            { jointId: "hand_l", name: "Mão esquerda", parent: "shoulder_l", anatomicalSide: "left", cameraSide: "far" },
          ],
        },
        generationCell: [64, 64],
        direction: "S",
        projection: "top_down",
        action: "attack",
        referencePose: pose([43, 30], 0),
        poses: ATTACK_FRAMES.map((f) => ({ poseId: f.frameId, durationMs: f.durationMs, joints: pose(f.hand, f.lean) })),
        loop: false,
        jointSocketMap: [
          { jointId: "hand_r", rigRevisionId: rig, socketId: "hand_right" },
          { jointId: "hand_l", rigRevisionId: rig, socketId: "hand_left" },
        ],
      },
    },
    {
      assetId: "spark",
      revisionId: "spark-v1",
      family: "vfx",
      kind: "burst",
      dependencies: [],
      payload: {
        logicalSize: [8, 8],
        pivot: [3, 4],
        loop: false,
        blendMode: "normal",
        frames: [
          { frameId: "rise", fileId: "spark-texture", rect: [0, 0, 8, 8], sourceOffset: [0, 0], durationMs: 80 },
          { frameId: "fade", fileId: "spark-texture", rect: [8, 0, 8, 8], sourceOffset: [0, 0], durationMs: 120 },
        ],
      },
    },
    {
      assetId: "hit-sfx",
      revisionId: "hit-sfx-v1",
      family: "audio",
      kind: "sfx",
      dependencies: [],
      payload: { fileId: "hit-wav", loop: null, vocal: null, lyrics: null },
    },
    {
      assetId: "warrior-attack-osh-s",
      revisionId: clip,
      family: "character",
      kind: "clip",
      name: "Ataque com escudo (S)",
      dependencies: [
        { revisionId: rig, role: "rig" },
        { revisionId: motion, role: "motion" },
        { revisionId: "spark-v1", role: "vfx" },
        { revisionId: "hit-sfx-v1", role: "audio" },
      ],
      payload: {
        rigRevisionId: rig,
        motionRevisionId: motion,
        action: "attack",
        state: null,
        stance: "one_hand_shield",
        direction: "S",
        logicalSize: [64, 64],
        pivot: [32, 60],
        margins: { left: 0, right: 0, top: 0, bottom: 0 },
        playback: "once",
        frames: ATTACK_FRAMES.map((f, i) => ({
          frameId: f.frameId,
          durationMs: f.durationMs,
          layers: [{ partId: "body", fileId: "warrior-attack-s", rect: [i * 64, 0, 64, 64], offset: [0, 0] }],
          sockets: [
            { socketId: "hand_right", at: [f.hand[0], f.hand[1]], hidden: false },
            { socketId: "hand_left", at: [20 + f.lean, 37], hidden: true },
          ],
          rootOffset: [0, 0],
        })),
        events: [
          {
            eventId: "impact",
            frameId: "contact",
            kind: "impact",
            vfx: { revisionId: "spark-v1", socketId: "hand_right", offset: [18, 0] },
            audio: { revisionId: "hit-sfx-v1", offsetMs: 0 },
          },
        ],
      },
    },
    {
      assetId: "chainmail",
      revisionId: "chainmail-v1",
      family: "equipment",
      kind: "overlay",
      name: "Cota de malha",
      dependencies: [
        { revisionId: rig, role: "rig" },
        { revisionId: clip, role: "clip" },
      ],
      payload: {
        itemRevisionId: null,
        rigRevisionId: rig,
        slots: ["torso"],
        stances: ["one_hand_shield", "two_handed"],
        parts: [
          {
            partId: "torso",
            coverage: ATTACK_FRAMES.map((f, i) => ({
              clipRevisionId: clip,
              frameId: f.frameId,
              layer: {
                fileId: "chainmail-atlas",
                rect: [i * MAIL.torso.size[0], 0, MAIL.torso.size[0], MAIL.torso.size[1]],
                offset: [MAIL.torso.offset[0] + f.lean, MAIL.torso.offset[1]],
              },
              drawIndex: 1,
            })),
          },
          {
            partId: "sleeve_near",
            coverage: ATTACK_FRAMES.map((f) => {
              const si = (MAIL.sleeve.frames as readonly string[]).indexOf(f.frameId);
              return {
                clipRevisionId: clip,
                frameId: f.frameId,
                // No contato a manga fica totalmente encoberta: célula vazia explícita.
                layer:
                  si < 0
                    ? null
                    : {
                        fileId: "chainmail-atlas",
                        rect: [si * MAIL.sleeve.size[0], 16, MAIL.sleeve.size[0], MAIL.sleeve.size[1]],
                        offset: [MAIL.sleeve.offset[0] + f.lean, MAIL.sleeve.offset[1]],
                      },
                drawIndex: 2,
              };
            }),
          },
        ],
        rigidViews: [],
      },
    },
    {
      assetId: "warrior-loadout-osh",
      revisionId: "warrior-loadout-osh-v1",
      family: "equipment",
      kind: "loadout",
      dependencies: [
        { revisionId: rig, role: "rig" },
        { revisionId: "chainmail-v1", role: "overlay" },
        { revisionId: clip, role: "clip" },
      ],
      payload: {
        rigRevisionId: rig,
        overlayRevisionIds: ["chainmail-v1"],
        stance: "one_hand_shield",
        clips: [{ action: "attack", direction: "S", clipRevisionId: clip }],
      },
    },
    {
      assetId: "potion",
      revisionId: "potion-v1",
      family: "item",
      kind: "consumable",
      name: "Poção verde",
      dependencies: [],
      payload: {
        itemKey: "potion_green",
        representations: [
          { role: "icon", state: "default", fileId: "potion-sheet", rect: [0, 0, 16, 16], sourceOffset: [0, 0], logicalSize: [16, 16], pivot: [8, 8] },
          { role: "world", state: "default", fileId: "potion-sheet", rect: [16, 0, 16, 16], sourceOffset: [0, 0], logicalSize: [16, 16], pivot: [8, 15] },
        ],
      },
    },
    {
      assetId: "grass-water",
      revisionId: "grass-water-v1",
      family: "tileset",
      kind: "corner",
      name: "Grama ↔ água",
      dependencies: [],
      payload: {
        projection: "top_down",
        cellSize: [32, 32],
        atlas: { fileId: "grass-water-atlas", margin: 0, spacing: 0 },
        terrains: [
          { terrainId: "grass", name: "Grama", color: "#469632" },
          { terrainId: "water", name: "Água", color: "#3264c8" },
        ],
        diagonals: { mask5: "separate", mask10: "separate" },
        tiles: Array.from({ length: 16 }, (_, m) => ({
          tileKey: `grass-water-${m}`,
          mask: m,
          variant: 0,
          weight: 1,
          rect: [(m % 4) * 32, Math.floor(m / 4) * 32, 32, 32] as [number, number, number, number],
          frames: [],
        })),
        complete: true,
      },
    },
    {
      assetId: "mini-font",
      revisionId: "mini-font-v1",
      family: "font",
      kind: "bitmap",
      dependencies: [],
      payload: {
        nativeGlyphPx: 7,
        metrics: { ascent: 8, descent: 2, lineHeight: 10, spaceAdvance: 4 },
        glyphs: FONT_GLYPHS.map((g, i) => ({
          codepoint: g.char.codePointAt(0)!,
          fileId: "font-atlas",
          rect: [i * FONT_CELL[0], 0, FONT_CELL[0], FONT_CELL[1]] as [number, number, number, number],
          bearingX: 0,
          bearingY: -8,
          advanceX: FONT_CELL[0],
          origin: g.char === "ç" || g.char === "ã" ? ("extended" as const) : ("generated" as const),
        })),
        kerning: [],
        declaredCoverage: FONT_GLYPHS.map((g) => g.char.codePointAt(0)!),
        missingGlyph: { policy: "fallback", fallbackCodepoint: "?".codePointAt(0)! },
        ttf: null,
        license: { name: "CC0-1.0", provenance: "Fixture sintética do Pixel Studio" },
      },
    },
    {
      assetId: "button-metal",
      revisionId: "button-metal-v1",
      family: "ui",
      kind: "button",
      name: "Botão de metal",
      dependencies: [{ revisionId: "mini-font-v1", role: "font" }],
      payload: {
        logicalSize: [32, 16],
        states: (["normal", "hover", "pressed", "disabled"] as const).map((state, i) => ({
          state,
          fileId: "button-atlas",
          rect: [i * 32, 0, 32, 16] as [number, number, number, number],
        })),
        requiredStates: ["normal", "hover", "pressed", "disabled"],
        focus: { mode: "overlay", fileId: "button-atlas", rect: [128, 0, 32, 16] },
        nineSlice: { left: 4, right: 4, top: 4, bottom: 4 },
        contentPadding: { left: 7, right: 7, top: 5, bottom: 5 },
        stretch: { center: "stretch", edges: "stretch" },
        interactiveRect: null,
        text: {
          key: "inventory.use",
          sample: "Usar",
          align: "center",
          verticalAlign: "middle",
          wrap: "none",
          overflow: "grow",
          fontRevisionId: "mini-font-v1",
        },
        accessibleName: null,
        complete: true,
      },
    },
    {
      assetId: "health-bar",
      revisionId: "health-bar-v1",
      family: "ui",
      kind: "meter",
      name: "Barra de vida",
      dependencies: [],
      payload: {
        logicalSize: [68, 10],
        track: { fileId: "meter-atlas", rect: [0, 0, 68, 10] },
        fill: { fileId: "meter-atlas", rect: [0, 20, 64, 6], offset: [2, 2] },
        frame: { fileId: "meter-atlas", rect: [0, 10, 68, 10] },
        usefulRect: [2, 2, 64, 6],
        axis: "horizontal",
        direction: "forward",
        range: { min: 0, max: 100 },
        rounding: "floor",
        nineSlice: null,
      },
    },
    {
      assetId: "hud",
      revisionId: "hud-v1",
      family: "ui",
      kind: "screen",
      name: "HUD da clareira",
      dependencies: [
        { revisionId: "health-bar-v1", role: "component" },
        { revisionId: "button-metal-v1", role: "component" },
        { revisionId: "potion-v1", role: "icon" },
      ],
      payload: {
        referenceResolution: [320, 180],
        background: null,
        instances: [
          {
            instanceId: "root",
            parentId: null,
            componentRevisionId: null,
            anchors: { left: 0, top: 0, right: 1, bottom: 1 },
            offsets: { left: 0, top: 0, right: 0, bottom: 0 },
            order: 0,
            hidden: false,
            overrides: {},
          },
          {
            instanceId: "health",
            parentId: "root",
            componentRevisionId: "health-bar-v1",
            anchors: { left: 0, top: 0, right: 0, bottom: 0 },
            offsets: { left: 8, top: 8, right: 76, bottom: 18 },
            order: 1,
            hidden: false,
            overrides: { value: 25 },
          },
          {
            instanceId: "use-button",
            parentId: "root",
            componentRevisionId: "button-metal-v1",
            anchors: { left: 1, top: 1, right: 1, bottom: 1 },
            offsets: { left: -40, top: -24, right: -8, bottom: -8 },
            order: 2,
            hidden: false,
            overrides: { textKey: "inventory.use" },
          },
          {
            instanceId: "potion-icon",
            parentId: "root",
            componentRevisionId: "potion-v1",
            anchors: { left: 1, top: 1, right: 1, bottom: 1 },
            offsets: { left: -64, top: -24, right: -48, bottom: -8 },
            order: 3,
            hidden: false,
            overrides: {},
          },
        ],
        focusOrder: ["use-button"],
      },
    },
  ] satisfies ManifestEntry[];
}

function lakeMask(): RgbaImage {
  // Máscara binária 128×128 sobre o atlas: região editável com um buraco protegido dentro.
  const img = createImage(128, 128);
  fillRect(img, 0, 0, 128, 128, [0, 0, 0, 255]);
  fillRect(img, 40, 40, 48, 48, [255, 255, 255, 255]);
  fillRect(img, 56, 56, 8, 8, [0, 0, 0, 255]);
  return img;
}

function metalReference(): RgbaImage {
  const img = createImage(16, 16);
  fillRect(img, 0, 0, 16, 16, C.mail);
  for (let y = 0; y < 16; y += 2) for (let x = y % 4 === 0 ? 0 : 1; x < 16; x += 2) setPixel(img, x, y, C.mailDark);
  return img;
}

function duneReference(): RgbaImage {
  const img = createImage(16, 16);
  fillRect(img, 0, 0, 16, 16, [220, 190, 120, 255]);
  return img;
}

export function buildStyle(): StylePayload {
  const colors = [C.outline, C.skin, C.tunic, C.boots, C.steel, C.wood, C.mail, C.spark, C.potion, C.grass, C.water, C.metal, C.copper, C.fill];
  const hex = (c: readonly number[]) => `#${c.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return {
    camera: {
      projection: { kind: "top_down", cellSize: [32, 32], tiltDeg: 30 },
      directions: ["N", "E", "S", "W"],
      scroll: "free",
    },
    scale: {
      logicalResolution: [320, 180],
      characterHeightPx: 50,
      uiScale: 1,
      familySizes: { character: [64, 64], item: [16, 16], tileset: [32, 32], vfx: [8, 8] },
    },
    palette: { name: "clareira", policy: "guided", colors: colors.map((c, index) => ({ index, hex: hex(c) })) },
    lighting: { lightFrom: "NW", shadow: "drop", notes: "Sol da tarde vindo do noroeste" },
    outline: { widthPx: 1, policy: "dark" },
    detailDensity: "medium",
    transparency: "binary",
    exceptions: [
      { family: "vfx", rule: "partial_alpha", notes: "Brilhos e faíscas podem usar alfa parcial" },
      { family: "ui", rule: "reserved_focus_color", notes: "Amarelo #ffd600 reservado ao foco" },
    ],
    references: [{ ordinal: 0, revisionId: "warrior-base-v1", role: "identity", instruction: "Seguir proporções e silhueta do guerreiro" }],
    approvedExampleRevisionIds: ["warrior-base-v1", "potion-v1"],
    briefLanguage: "pt-BR",
  };
}

const PT_CODEPOINTS = [..."áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ"].map((c) => c.codePointAt(0)!);

function buildPlans(files: Map<string, { sha256: string }>, motionDigest: string, maskSha: string): Record<string, GenerationPlan> {
  const sha = (fileId: string) => files.get(fileId)!.sha256;
  const common = {
    planVersion: 1 as const,
    projectId: PROJECT_ID,
    styleRevisionId: STYLE_ID,
  };
  const unknownCost = { kind: "unknown" as const, reason: "Tarifa da rota ainda não qualificada" };
  return {
    "potion-text": {
      ...common,
      operation: "generate_asset",
      recipeRevisionId: "recipe-item-icon-v1",
      providerProfileId: "openrouter-images",
      prompt: {
        brief: "poção verde em frasco de vidro, ícone de inventário",
        compiled: "Ícone de inventário 16×16 em pixel art: poção verde em frasco de vidro. Fundo transparente, contorno escuro de 1 px, luz do noroeste.",
        language: "pt-BR",
      },
      sources: [],
      requiredCapabilities: ["text_to_image", "alpha_output"],
      parts: [
        { partKey: "image:potion-a", unit: "image", label: "Variante A" },
        { partKey: "image:potion-b", unit: "image", label: "Variante B" },
      ],
      limits: { maxSubmissions: 2, costCeiling: { amount: 0.5, unit: "USD" }, estimate: unknownCost },
      params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 2 },
    },
    "chainmail-two-refs": {
      ...common,
      operation: "generate_asset",
      recipeRevisionId: "recipe-equipment-v1",
      providerProfileId: "openrouter-images",
      prompt: {
        brief: "cota de malha sobre o guerreiro",
        compiled: "Vista a cota de malha com o material da fonte 2 sobre o torso da fonte 1. Preserve pose, câmera e enquadramento.",
        language: "pt-BR",
      },
      sources: [
        { ordinal: 0, revisionId: "warrior-base-v1", fileId: "warrior-base-s", sha256: sha("warrior-base-s"), role: "identity" },
        { ordinal: 1, revisionId: "metal-ref-v1", fileId: "metal-ref", sha256: sha("metal-ref"), role: "material" },
      ],
      requiredCapabilities: ["image_references", "alpha_output"],
      parts: [{ partKey: "image:chainmail", unit: "image", label: "Cota sobre a base" }],
      limits: {
        maxSubmissions: 1,
        costCeiling: { amount: 0.5, unit: "USD" },
        estimate: { kind: "known", amount: { amount: 0.08, unit: "USD" }, basis: "1 imagem com 2 referências (tarifa ilustrativa da fixture)" },
      },
      params: { family: "equipment", kind: "overlay", logicalSize: [64, 64], transparent: true, variants: 1 },
    },
    "inpaint-lake": {
      ...common,
      operation: "inpaint",
      recipeRevisionId: "recipe-inpaint-v1",
      providerProfileId: "pixellab-rest",
      prompt: {
        brief: "reconstruir a margem do lago com juncos",
        compiled: "Reconstruir a margem do lago com juncos na região marcada, mantendo grama, água e luz do restante.",
        language: "pt-BR",
      },
      sources: [
        { ordinal: 0, revisionId: "grass-water-v1", fileId: "grass-water-atlas", sha256: sha("grass-water-atlas"), role: "source" },
        { ordinal: 1, revisionId: "grass-water-v1", fileId: "lake-mask", sha256: maskSha, role: "edit_mask" },
      ],
      requiredCapabilities: ["native_mask"],
      parts: [{ partKey: "image:lake-edge", unit: "image", label: "Margem do lago" }],
      limits: { maxSubmissions: 1, costCeiling: { amount: 5, unit: "generations" }, estimate: { kind: "known", amount: { amount: 1, unit: "generations" }, basis: "1 chamada /inpaint-v3" } },
      params: {
        sourceRevisionId: "grass-water-v1",
        sourceFileId: "grass-water-atlas",
        editMaskFileId: "lake-mask",
        maskConvention: "white_edits_black_preserves",
        logicalSize: [128, 128],
        mode: "native-mask",
        instruction: "reconstruir a margem do lago com juncos",
      },
    },
    "attack-skeleton": {
      ...common,
      operation: "animate_skeleton",
      recipeRevisionId: "recipe-animate-skeleton-v1",
      providerProfileId: "pixellab-rest",
      prompt: {
        brief: "golpe curto com escudo junto ao corpo",
        compiled: "Guerreiro de túnica azul com escudo de madeira; golpe curto de espada mantendo o escudo junto ao corpo.",
        language: "pt-BR",
      },
      sources: [
        { ordinal: 0, revisionId: "warrior-base-v1", fileId: "warrior-base-s", sha256: sha("warrior-base-s"), role: "base" },
        { ordinal: 1, revisionId: "warrior-attack-motion-v1", fileId: null, sha256: motionDigest, role: "motion" },
      ],
      requiredCapabilities: ["skeleton_keypoints"],
      parts: frameIds.map((id) => ({ partKey: `segment:${id}`, unit: "segment" as const, label: `Pose ${id}` })),
      limits: { maxSubmissions: 1, costCeiling: null, estimate: unknownCost },
      params: {
        baseRevisionId: "warrior-base-v1",
        motionRevisionId: "warrior-attack-motion-v1",
        actionText: "golpe curto com escudo",
        direction: "S",
        playback: "once",
      },
    },
    "rotate-views": {
      ...common,
      operation: "rotate_views",
      recipeRevisionId: "recipe-rotate-v1",
      providerProfileId: "pixellab-rest",
      prompt: { brief: "", compiled: "Guerreiro de túnica azul com escudo no braço esquerdo e espada na mão direita.", language: "pt-BR" },
      sources: [{ ordinal: 0, revisionId: "warrior-base-v1", fileId: "warrior-base-s", sha256: sha("warrior-base-s"), role: "identity" }],
      requiredCapabilities: ["rotation_4", "image_references"],
      parts: (["N", "E", "W"] as const).map((d) => ({ partKey: `view:${d}`, unit: "view" as const, label: `Vista ${d}` })),
      limits: { maxSubmissions: 3, costCeiling: null, estimate: unknownCost },
      params: {
        identityRevisionId: "warrior-base-v1",
        requestedViews: ["N", "E", "W"],
        approvedViews: ["S"],
        asymmetries: ["escudo no braço esquerdo", "espada na mão direita"],
        projection: "top_down",
        worldToView: null,
      },
    },
    "font-pt": {
      ...common,
      operation: "generate_pixel_font",
      recipeRevisionId: "recipe-font-v1",
      providerProfileId: "pixellab-rest",
      prompt: { brief: "fonte pixel de metal forjado", compiled: "Fonte pixel regular, glyph de 8 px, traço de metal forjado.", language: "pt-BR" },
      sources: [],
      requiredCapabilities: ["pixel_font"],
      parts: [{ partKey: "glyph_set:base", unit: "glyph_set", label: "Conjunto base" }],
      limits: { maxSubmissions: 1, costCeiling: null, estimate: unknownCost },
      params: { weight: "regular", glyphSize: 8, requiredCodepoints: PT_CODEPOINTS },
    },
  };
}

export function buildClareira(): ClareiraFixture {
  const rasters = [
    rasterFile("warrior-base-s", "sprites/warrior-base-s.png", warriorBase()),
    rasterFile("warrior-attack-s", "sprites/warrior-attack-s.png", warriorAttackStrip()),
    rasterFile("chainmail-atlas", "sprites/chainmail-attack-s.png", chainmailAtlas()),
    rasterFile("spark-texture", "textures/spark.png", sparkAtlas()),
    rasterFile("potion-sheet", "items/potion.png", potionSheet()),
    rasterFile("grass-water-atlas", "tiles/grass-water.png", grassWaterAtlas()),
    rasterFile("button-atlas", "ui/button.png", buttonAtlas()),
    rasterFile("meter-atlas", "ui/health-bar.png", meterAtlas()),
    rasterFile("font-atlas", "fonts/mini.png", fontAtlas()),
  ];
  const wav = hitSfx();
  const audio: ManifestFile = {
    fileId: "hit-wav",
    path: "audio/hit.wav",
    mime: "audio/wav",
    durationMs: Math.round((HIT_SFX.frameCount / HIT_SFX.sampleRate) * 1000),
    sampleRate: HIT_SFX.sampleRate,
    channels: HIT_SFX.channels,
    frameCount: HIT_SFX.frameCount,
    codec: "pcm_s16le",
    bytes: wav.length,
    sha256: sha256Hex(wav),
  };

  const entries = buildEntries();
  const manifest: Manifest = {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    profile: "portable-v1",
    generator: { name: "pixel-studio-fixtures", version: "1" },
    files: [...rasters.map((r) => r.record), audio],
    entries,
    attributions: [{ subject: "spark-texture", text: "Arte sintética de teste do Pixel Studio", license: "CC0-1.0" }],
  };
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

  const packageFiles: FixtureFile[] = [
    ...rasters.map((r) => ({ path: r.record.path, bytes: r.bytes })),
    { path: audio.path, bytes: wav },
    { path: "manifest.json", bytes: manifestBytes },
  ];

  // Arquivos de trabalho do projeto (nunca entram no pacote).
  const mask = encodePng(lakeMask());
  const metal = encodePng(metalReference());
  const dune = encodePng(duneReference());
  const projectFiles: FixtureFile[] = [
    { path: "uploads/lake-mask.png", bytes: mask },
    { path: "references/metal.png", bytes: metal },
    { path: "references/dune.png", bytes: dune },
  ];

  const fileInfo = new Map<string, { sha256: string; width?: number; height?: number }>();
  for (const f of manifest.files) fileInfo.set(f.fileId, { sha256: f.sha256, ...("width" in f ? { width: f.width, height: f.height } : {}) });
  fileInfo.set("metal-ref", { sha256: sha256Hex(metal), width: 16, height: 16 });

  const filesOf = (entry: ManifestEntry): Record<string, { sha256: string; width?: number; height?: number }> => {
    const ids = new Set(entryRefs(entry).files.map((f) => f.fileId));
    return Object.fromEntries([...fileInfo].filter(([id]) => ids.has(id)));
  };
  const motionEntry = entries.find((e) => e.revisionId === "warrior-attack-motion-v1")!;
  const motionDigest = canonicalDigest(motionEntry.payload);

  const revisions: CatalogRevision[] = [
    { revisionId: STYLE_ID, projectId: PROJECT_ID, family: "style", kind: "style", status: "approved", files: {}, payloadDigest: canonicalDigest(buildStyle()) },
    ...entries.map((e) => ({
      revisionId: e.revisionId,
      projectId: PROJECT_ID,
      family: e.family,
      kind: e.kind,
      status: "approved" as const,
      files: filesOf(e),
      payloadDigest: canonicalDigest(e.payload),
    })),
    {
      revisionId: "metal-ref-v1",
      projectId: PROJECT_ID,
      family: "texture",
      kind: "material",
      status: "approved",
      files: { "metal-ref": fileInfo.get("metal-ref")! },
    },
    {
      revisionId: "potion-v2-candidate",
      projectId: PROJECT_ID,
      family: "item",
      kind: "consumable",
      status: "candidate",
      files: { "potion-sheet": fileInfo.get("potion-sheet")! },
    },
    {
      revisionId: "deserto-dune-v1",
      projectId: OTHER_PROJECT_ID,
      family: "texture",
      kind: "material",
      status: "approved",
      files: { "dune-ref": { sha256: sha256Hex(dune), width: 16, height: 16 } },
    },
  ];
  const uploads: CatalogUpload[] = [{ fileId: "lake-mask", projectId: PROJECT_ID, sha256: sha256Hex(mask), width: 128, height: 128 }];

  return {
    manifest,
    packageFiles,
    projectFiles,
    style: buildStyle(),
    catalog: { revisions, uploads },
    plans: buildPlans(fileInfo, motionDigest, sha256Hex(mask)),
  };
}
