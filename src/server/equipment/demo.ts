import type { BasePayload, ClipPayload, Direction, OverlayPayload, Rect, RigPayload, RigidPlacement } from "@/contracts";
import { buildClareira } from "@/fixtures/clareira";
import type { RgbaImage } from "@/lib/media/png";
import { readZip, writeZip } from "@/lib/zip";
import { type BlobRecord, createAsset, getAsset, publishRevision, type PublishFile, reviewRevision } from "../catalog/catalog";
import { importPortablePackage } from "../export/import";
import type { Studio } from "../studio";
import {
  baseLayers,
  baseView,
  contentBox,
  crop,
  geometry,
  type Kind,
  longSwordViews,
  mailSleeve,
  mailTorso,
  packRow,
  POSES,
  type RigidArt,
  shieldViews,
  shortSwordViews,
  weaponPlacementView,
} from "./demo-art";
import { publishLoadout } from "./loadouts";
import { expandCell } from "./overlays";
import { resolveConfig } from "./resolve";
import { marginsToFit } from "@/domain/equipment/attach";
import { isZeroInsets } from "@/domain/equipment/cell";
import { encodePngDeflate } from "./png";

/**
 * Demonstração do caso do guerreiro (04 §caso de ponta a ponta): base limpa
 * em quatro vistas, rig com slots/sockets/partes/posturas, ataque com escudo
 * (4 frames, 140/80/60/160 ms) e golpe de duas mãos (6 frames,
 * 120/100/90/60/110/180 ms) por vista, cota de malha com torso e manga
 * próxima para os dois clipes (4 × (4 + 6) = 40 poses), espada curta, escudo e
 * espada longa como vistas rígidas, e os dois conjuntos aprovados. A fixture
 * da clareira entra junto: a cota dela foi feita para OUTRA base (rig da
 * clareira), o que demonstra "peça de outra base".
 *
 * Toda a arte é sintética e local; nenhuma chamada a provedor.
 */

export const DEMO_NAMES = {
  base: "Guerreiro (base limpa)",
  rig: "Guerreiro · rig de equipamento",
  mail: "Cota de malha de ferro",
  shortSword: "Espada curta",
  shield: "Escudo de madeira",
  longSword: "Espada longa",
  loadoutA: "Conjunto A · espada curta + escudo + cota",
  loadoutB: "Conjunto B · espada longa + cota",
} as const;

const DIRS = ["N", "E", "S", "W"] as const satisfies readonly Direction[];
const KIND_LABEL: Record<Kind, string> = { osh: "ataque com escudo", th: "golpe de duas mãos" };
const STANCE: Record<Kind, string> = { osh: "one_hand_shield", th: "two_handed" };

export interface DemoSummary {
  created: boolean;
  baseRevisionId: string;
  rigRevisionId: string;
  clips: Record<string, string>;
  overlays: { mail: string; shortSword: string; shield: string; longSword: string; foreignMail: string | null };
  loadouts: { a: string; b: string };
}

async function blob(studio: Studio, img: RgbaImage): Promise<BlobRecord> {
  const stored = await studio.blobs.putBytes(encodePngDeflate(img));
  return { sha256: stored.sha256, bytes: stored.bytes, mime: "image/png", modality: "raster", metadata: { width: img.width, height: img.height } };
}

function approve(studio: Studio, projectId: string, revisionId: string) {
  const row = studio.db.get<{ asset_id: string }>("SELECT asset_id FROM asset_revisions WHERE id = :id", { id: revisionId })!;
  const asset = getAsset(studio.db, projectId, row.asset_id);
  reviewRevision(studio.db, studio.clock, { projectId, assetId: asset.id, revisionId, decision: "approve", reason: "Demonstração do caso do guerreiro (S2)", expectedActiveRevisionId: asset.approvedRevisionId });
}

function publishApproved(studio: Studio, projectId: string, family: "character" | "equipment", kind: string, name: string, payload: unknown, files: PublishFile[]): string {
  const asset = createAsset(studio.db, studio.clock, { projectId, family, kind, name });
  const revision = publishRevision(studio.db, studio.clock, { projectId, assetId: asset.id, payload, origin: "composition", styleRevisionId: null, files, technicalReport: { origin: "demo_seed_s2", providerCalls: 0 } });
  approve(studio, projectId, revision.id);
  return revision.id;
}

function existingDemo(studio: Studio, projectId: string): DemoSummary | null {
  const byName = (name: string, kind: string) =>
    studio.db.get<{ approved_revision_id: string | null }>("SELECT approved_revision_id FROM assets WHERE project_id = :p AND name = :n AND kind = :k AND archived_at IS NULL", { p: projectId, n: name, k: kind })?.approved_revision_id ?? null;
  const base = byName(DEMO_NAMES.base, "base");
  const rig = byName(DEMO_NAMES.rig, "rig");
  const a = byName(DEMO_NAMES.loadoutA, "loadout");
  const b = byName(DEMO_NAMES.loadoutB, "loadout");
  if (!base || !rig || !a || !b) return null;
  const clips: Record<string, string> = {};
  for (const kind of ["osh", "th"] as const) {
    for (const d of DIRS) {
      const id = byName(`Guerreiro · ${KIND_LABEL[kind]} · ${d}`, "clip");
      if (id) clips[`${kind}-${d.toLowerCase()}`] = id;
    }
  }
  return {
    created: false,
    baseRevisionId: base,
    rigRevisionId: rig,
    clips,
    overlays: {
      mail: byName(DEMO_NAMES.mail, "overlay")!,
      shortSword: byName(DEMO_NAMES.shortSword, "overlay")!,
      shield: byName(DEMO_NAMES.shield, "overlay")!,
      longSword: byName(DEMO_NAMES.longSword, "overlay")!,
      foreignMail: byName("Cota de malha", "overlay"),
    },
    loadouts: { a, b },
  };
}

async function rigidFiles(studio: Studio, views: RigidArt[]) {
  const { atlas, rects } = packRow(views.map((v) => v.image));
  return {
    files: [{ fileKey: "views", role: "rigid_views", idx: 0, blob: await blob(studio, atlas) }] satisfies PublishFile[],
    rigidViews: views.map((v, i) => ({ viewId: v.viewId, fileId: "views", rect: rects[i]!, grips: v.grips, ...(v.mirrorAllowed ? { mirrorAllowed: true } : {}) })),
  };
}

export async function seedEquipmentDemo(studio: Studio, projectId: string, opts: { withFixture?: boolean } = {}): Promise<DemoSummary> {
  const existing = existingDemo(studio, projectId);
  if (existing) return existing;

  // Fixture da clareira: a cota dela é de outra base (demonstra revisão incompatível).
  let foreignMail: string | null = null;
  if (opts.withFixture ?? true) {
    const already = studio.db.get<{ approved_revision_id: string | null }>("SELECT approved_revision_id FROM assets WHERE project_id = :p AND name = 'Cota de malha' AND kind = 'overlay'", { p: projectId });
    if (already) foreignMail = already.approved_revision_id;
    else {
      const fixture = buildClareira();
      const zip = writeZip(fixture.packageFiles.map((f) => ({ path: f.path, bytes: f.bytes, compress: false })));
      const { revisionMap } = await importPortablePackage(studio, projectId, readZip(zip), { approve: true });
      foreignMail = revisionMap["chainmail-v1"] ?? null;
    }
  }

  // ---- base limpa (quatro vistas) e rig ----
  const views = await Promise.all(DIRS.map(async (d) => ({ d, blob: await blob(studio, baseView(d)) })));
  const basePayload: BasePayload = {
    logicalSize: [64, 64],
    groundOrigin: [32, 60],
    state: "default",
    predecessorRevisionId: null,
    views: views.map((v) => ({ direction: v.d, fileId: `view-${v.d.toLowerCase()}`, rect: [0, 0, 64, 64], sourceOffset: [0, 0] })),
  };
  const baseRevisionId = publishApproved(
    studio,
    projectId,
    "character",
    "base",
    DEMO_NAMES.base,
    basePayload,
    views.map((v, i) => ({ fileKey: `view-${v.d.toLowerCase()}`, role: "view", idx: i, blob: v.blob })),
  );
  const rigPayload: RigPayload = {
    baseRevisionId,
    logicalCell: [64, 64],
    groundOrigin: [32, 60],
    directions: [...DIRS],
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
      { partId: "body", label: "Corpo (com o braço distante)" },
      { partId: "arm_near", label: "Braço próximo" },
      { partId: "torso", label: "Torso" },
      { partId: "sleeve_near", label: "Manga próxima" },
    ],
    stances: ["one_hand_shield", "two_handed"],
    socketTolerancePx: 1,
  };
  const rigRevisionId = publishApproved(studio, projectId, "character", "rig", DEMO_NAMES.rig, rigPayload, []);

  // ---- clipes: 2 ataques × 4 vistas ----
  const clips: Record<string, string> = {};
  const mailParts: { torso: OverlayPayload["parts"][number]["coverage"]; sleeve: OverlayPayload["parts"][number]["coverage"] } = { torso: [], sleeve: [] };
  const mailFiles: PublishFile[] = [];
  const placements: Record<"sword" | "shield" | "long", RigidPlacement[]> = { sword: [], shield: [], long: [] };
  for (const kind of ["osh", "th"] as const) {
    for (const dir of DIRS) {
      const poses = POSES[kind][dir];
      const key = `${kind}-${dir.toLowerCase()}`;
      const layers = poses.map((p) => baseLayers(dir, p));
      const bodyStrip = packRow(layers.map((l) => l.body));
      const armStrip = packRow(layers.map((l) => l.arm));
      const clip: ClipPayload = {
        rigRevisionId,
        motionRevisionId: null,
        action: "attack",
        state: null,
        stance: STANCE[kind],
        direction: dir,
        logicalSize: [64, 64],
        pivot: [32, 60],
        margins: { left: 0, right: 0, top: 0, bottom: 0 },
        playback: "once",
        frames: poses.map((p, i) => {
          const g = geometry(dir, p);
          const inside = (r: Rect, h: [number, number]) => h[0] >= r[0] && h[0] < r[0] + r[2] && h[1] >= r[1] && h[1] < r[1] + r[3];
          const farHand = g.near === "right" ? p.left : p.right;
          // Mão encoberta: atrás do tronco ou da cabeça (o encaixe continua marcado, só oculto).
          const behind = (hand: [number, number]) => (hand === farHand || p.nearArmBehind === true) && (inside(g.torso, hand) || inside(g.head, hand));
          return {
            frameId: p.frameId,
            durationMs: p.durationMs,
            layers: [
              { partId: "body", fileId: `body-${key}`, rect: bodyStrip.rects[i]!, offset: [0, 0] },
              { partId: "arm_near", fileId: `arm-${key}`, rect: armStrip.rects[i]!, offset: [0, 0] },
            ],
            sockets: [
              { socketId: "hand_right", at: p.right, hidden: behind(p.right) },
              { socketId: "hand_left", at: p.left, hidden: behind(p.left) },
            ],
            rootOffset: [0, 0],
          };
        }),
        events: [],
      };
      clips[key] = publishApproved(studio, projectId, "character", "clip", `Guerreiro · ${KIND_LABEL[kind]} · ${dir}`, clip, [
        { fileKey: `body-${key}`, role: "frame_layer", idx: 0, blob: await blob(studio, bodyStrip.atlas) },
        { fileKey: `arm-${key}`, role: "frame_layer", idx: 1, blob: await blob(studio, armStrip.atlas) },
      ]);

      // Cota: torso e manga próxima recortados por frame, um atlas por clipe.
      const torsoCuts = poses.map((p) => cut(mailTorso(dir, p)));
      const sleeveCuts = poses.map((p) => {
        const img = mailSleeve(dir, p);
        return img ? cut(img) : null;
      });
      const torsoAtlas = packRow(torsoCuts.map((c) => c.image));
      const sleeveAtlas = packRow(sleeveCuts.filter((c): c is NonNullable<typeof c> => c !== null).map((c) => c.image));
      mailFiles.push({ fileKey: `torso-${key}`, role: "coverage", idx: mailFiles.length, blob: await blob(studio, torsoAtlas.atlas) });
      mailFiles.push({ fileKey: `sleeve-${key}`, role: "coverage", idx: mailFiles.length, blob: await blob(studio, sleeveAtlas.atlas) });
      let si = 0;
      poses.forEach((p, i) => {
        mailParts.torso.push({ clipRevisionId: clips[key]!, frameId: p.frameId, layer: { fileId: `torso-${key}`, rect: torsoAtlas.rects[i]!, offset: torsoCuts[i]!.offset }, drawIndex: 0 });
        const s = sleeveCuts[i];
        // Manga encoberta pela pose: célula vazia explícita (não é lacuna).
        mailParts.sleeve.push({ clipRevisionId: clips[key]!, frameId: p.frameId, layer: s ? { fileId: `sleeve-${key}`, rect: sleeveAtlas.rects[si++]!, offset: s.offset } : null, drawIndex: 1 });
        const weapon = weaponPlacementView(p.weapon);
        const target = kind === "osh" ? placements.sword : placements.long;
        target.push({ clipRevisionId: clips[key]!, frameId: p.frameId, viewId: weapon.viewId, anchorSocketId: "hand_right", drawIndex: p.weaponDraw, ...(weapon.mirrored ? { mirrored: true } : {}) });
        if (kind === "osh" && p.shield) placements.shield.push({ clipRevisionId: clips[key]!, frameId: p.frameId, viewId: p.shield.view, anchorSocketId: "hand_left", drawIndex: p.shield.draw });
      });
    }
  }

  // ---- peças ----
  const piece = (slots: string[], stances: string[], extra: Partial<OverlayPayload>): OverlayPayload => ({ itemRevisionId: null, rigRevisionId, slots, stances, parts: [], rigidViews: [], ...extra });
  const mail = publishApproved(
    studio,
    projectId,
    "equipment",
    "overlay",
    DEMO_NAMES.mail,
    piece(["torso"], ["one_hand_shield", "two_handed"], {
      parts: [
        { partId: "torso", coverage: mailParts.torso },
        { partId: "sleeve_near", coverage: mailParts.sleeve },
      ],
    }),
    mailFiles,
  );
  const sword = await rigidFiles(studio, shortSwordViews());
  const shortSword = publishApproved(studio, projectId, "equipment", "overlay", DEMO_NAMES.shortSword, piece(["main_hand"], ["one_hand_shield"], { rigidViews: sword.rigidViews, rigidPlacements: placements.sword }), sword.files);
  const sh = await rigidFiles(studio, shieldViews());
  const shield = publishApproved(studio, projectId, "equipment", "overlay", DEMO_NAMES.shield, piece(["off_hand"], ["one_hand_shield"], { rigidViews: sh.rigidViews, rigidPlacements: placements.shield }), sh.files);
  const long = await rigidFiles(studio, longSwordViews());
  const longSword = publishApproved(
    studio,
    projectId,
    "equipment",
    "overlay",
    DEMO_NAMES.longSword,
    piece(["main_hand", "off_hand"], ["two_handed"], { rigidViews: long.rigidViews, rigidPlacements: placements.long }),
    long.files,
  );

  // ---- a lâmina longa não cabe na célula de 64: ampliar a célula da família do golpe amplo ----
  // (04 §referências: reservar espaço por família de poses; camadas, sockets, pivô e coberturas andam juntos.)
  const draftB = resolveConfig(studio, projectId, { rigRevisionId, overlayRevisionIds: [mail, longSword] });
  const overflow = marginsToFit(draftB.resolution.combos.flatMap((c) => c.frames.flatMap((f) => f.issues.filter((i) => i.kind === "clipped_outline").map((i) => i.overflow!))));
  let mailFinal = mail;
  let longFinal = longSword;
  if (!isZeroInsets(overflow)) {
    const side = Math.max(overflow.left, overflow.right) + 1;
    const margins = { left: side, right: side, top: overflow.top ? overflow.top + 2 : 0, bottom: overflow.bottom ? overflow.bottom + 1 : 0 };
    const thKeys = DIRS.map((d) => `th-${d.toLowerCase()}`);
    const expanded = expandCell(studio, projectId, { clips: thKeys.map((k) => ({ clipRevisionId: clips[k]!, margins })), overlayRevisionIds: [mail, longSword] });
    expanded.clips.forEach((c, i) => {
      approve(studio, projectId, c.revision.id);
      clips[thKeys[i]!] = c.revision.id;
    });
    for (const o of expanded.overlays) {
      approve(studio, projectId, o.revision.id);
      if (o.overlayRevisionId === mail) mailFinal = o.revision.id;
      if (o.overlayRevisionId === longSword) longFinal = o.revision.id;
    }
  }

  // ---- conjuntos A e B (com folha achatada), aprovados: a MESMA revisão da cota nos dois ----
  const a = await publishLoadout(studio, projectId, { name: DEMO_NAMES.loadoutA, config: { rigRevisionId, overlayRevisionIds: [mailFinal, shortSword, shield] }, flatten: true });
  approve(studio, projectId, a.revision.id);
  const b = await publishLoadout(studio, projectId, { name: DEMO_NAMES.loadoutB, config: { rigRevisionId, overlayRevisionIds: [mailFinal, longFinal] }, flatten: true });
  approve(studio, projectId, b.revision.id);

  return {
    created: true,
    baseRevisionId,
    rigRevisionId,
    clips,
    overlays: { mail: mailFinal, shortSword, shield, longSword: longFinal, foreignMail },
    loadouts: { a: a.revision.id, b: b.revision.id },
  };
}

function cut(img: RgbaImage): { image: RgbaImage; offset: [number, number] } {
  const box: Rect = contentBox(img) ?? [0, 0, 1, 1];
  return { image: crop(img, box), offset: [box[0], box[1]] };
}
