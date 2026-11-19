import type { AssetFamily, FileModality, ManifestEntry, Rect } from "@/contracts";
import { mapObjectExtraRefs, sceneEntryRefs } from "../scenes/refs";

/**
 * Referências que um payload faz a outras revisões e a arquivos do pacote.
 *
 * `runtime: true` = dependência exigida para usar o asset (deve estar declarada
 * em `dependencies[]` e presente no pacote). `runtime: false` = vínculo
 * editorial (origem/proveniência), opcional no pacote.
 */

export type Path = (string | number)[];

export interface RevisionRef {
  revisionId: string;
  path: Path;
  /** Papel da dependência (ex.: `rig`, `clip`, `vfx`), usado em `dependencies[].role`. */
  role: string;
  runtime: boolean;
  /** Famílias/tipos aceitos no alvo; `undefined` em `kinds` = qualquer tipo da família. */
  expect: { family: AssetFamily; kinds?: string[] }[];
}

export interface FileRef {
  fileId: string;
  path: Path;
  modality: FileModality;
  rect?: Rect;
}

export interface EntryRefs {
  revisions: RevisionRef[];
  files: FileRef[];
}

const P = "payload";

export function entryRefs(entry: ManifestEntry): EntryRefs {
  const revisions: RevisionRef[] = [];
  const files: FileRef[] = [];
  const rev = (revisionId: string | null | undefined, path: Path, runtime: boolean, expect: RevisionRef["expect"], role?: string) => {
    if (revisionId) revisions.push({ revisionId, path, runtime, expect, role: role ?? roleFromPath(path) });
  };
  const raster = (fileId: string | null, rect: Rect | null, path: Path) => {
    if (fileId) files.push({ fileId, path, modality: "raster", ...(rect ? { rect } : {}) });
  };
  const mergeRefs = (extra: EntryRefs) => {
    revisions.push(...extra.revisions);
    files.push(...extra.files);
  };

  switch (entry.family) {
    case "character":
      switch (entry.kind) {
        case "base":
          rev(entry.payload.predecessorRevisionId, [P, "predecessorRevisionId"], false, [{ family: "character", kinds: ["base"] }]);
          entry.payload.views.forEach((v, i) => raster(v.fileId, v.rect, [P, "views", i]));
          break;
        case "rig":
          rev(entry.payload.baseRevisionId, [P, "baseRevisionId"], false, [{ family: "character", kinds: ["base"] }]);
          break;
        case "clip":
          rev(entry.payload.rigRevisionId, [P, "rigRevisionId"], true, [{ family: "character", kinds: ["rig"] }]);
          rev(entry.payload.motionRevisionId, [P, "motionRevisionId"], false, [{ family: "character", kinds: ["motion"] }]);
          entry.payload.frames.forEach((f, fi) =>
            f.layers.forEach((l, li) => raster(l.fileId, l.rect, [P, "frames", fi, "layers", li])),
          );
          entry.payload.events.forEach((e, i) => {
            rev(e.vfx?.revisionId, [P, "events", i, "vfx", "revisionId"], true, [{ family: "vfx" }], "vfx");
            rev(e.audio?.revisionId, [P, "events", i, "audio", "revisionId"], true, [{ family: "audio" }], "audio");
          });
          break;
        case "motion":
          entry.payload.jointSocketMap.forEach((l, i) =>
            rev(l.rigRevisionId, [P, "jointSocketMap", i, "rigRevisionId"], false, [{ family: "character", kinds: ["rig"] }]),
          );
          break;
      }
      break;

    case "item":
      entry.payload.representations.forEach((r, i) => raster(r.fileId, r.rect, [P, "representations", i]));
      break;

    case "equipment":
      switch (entry.kind) {
        case "overlay":
          rev(entry.payload.itemRevisionId, [P, "itemRevisionId"], true, [{ family: "item" }]);
          rev(entry.payload.rigRevisionId, [P, "rigRevisionId"], true, [{ family: "character", kinds: ["rig"] }]);
          entry.payload.parts.forEach((part, pi) =>
            part.coverage.forEach((c, ci) => {
              const path: Path = [P, "parts", pi, "coverage", ci];
              rev(c.clipRevisionId, [...path, "clipRevisionId"], true, [{ family: "character", kinds: ["clip"] }]);
              if (c.layer) raster(c.layer.fileId, c.layer.rect, [...path, "layer"]);
            }),
          );
          entry.payload.rigidViews.forEach((v, i) => raster(v.fileId, v.rect, [P, "rigidViews", i]));
          // S2: frames em que cada vista rígida é usada.
          (entry.payload.rigidPlacements ?? []).forEach((p, i) =>
            rev(p.clipRevisionId, [P, "rigidPlacements", i, "clipRevisionId"], true, [{ family: "character", kinds: ["clip"] }]),
          );
          break;
        case "loadout":
          rev(entry.payload.rigRevisionId, [P, "rigRevisionId"], true, [{ family: "character", kinds: ["rig"] }]);
          entry.payload.overlayRevisionIds.forEach((id, i) =>
            rev(id, [P, "overlayRevisionIds", i], true, [{ family: "equipment", kinds: ["overlay"] }], "overlay"),
          );
          entry.payload.clips.forEach((c, i) =>
            rev(c.clipRevisionId, [P, "clips", i, "clipRevisionId"], true, [{ family: "character", kinds: ["clip"] }]),
          );
          // S2: override de ordem por frame e folha achatada sob demanda.
          (entry.payload.drawOrder ?? []).forEach((o, i) => {
            rev(o.clipRevisionId, [P, "drawOrder", i, "clipRevisionId"], true, [{ family: "character", kinds: ["clip"] }]);
            o.layers.forEach((l, li) => {
              if (l.kind !== "base") rev(l.overlayRevisionId, [P, "drawOrder", i, "layers", li, "overlayRevisionId"], true, [{ family: "equipment", kinds: ["overlay"] }], "overlay");
            });
          });
          (entry.payload.sheets ?? []).forEach((s, i) => {
            rev(s.clipRevisionId, [P, "sheets", i, "clipRevisionId"], true, [{ family: "character", kinds: ["clip"] }]);
            s.frames.forEach((f, fi) => raster(s.fileId, f.rect, [P, "sheets", i, "frames", fi]));
          });
          break;
      }
      break;

    case "vfx":
      entry.payload.frames.forEach((f, i) => raster(f.fileId, f.rect, [P, "frames", i]));
      break;

    case "texture":
      raster(entry.payload.fileId, entry.payload.rect, [P]);
      break;

    case "tileset":
      if (entry.kind === "isometric") {
        entry.payload.pieces.forEach((p, i) => raster(entry.payload.atlas.fileId, p.rect, [P, "pieces", i, "rect"]));
        break;
      }
      entry.payload.tiles.forEach((t, i) => {
        raster(entry.payload.atlas.fileId, t.rect, [P, "tiles", i, "rect"]);
        t.frames.forEach((f, fi) => raster(entry.payload.atlas.fileId, f.rect, [P, "tiles", i, "frames", fi]));
      });
      break;

    case "map":
      if (entry.kind === "object") {
        raster(entry.payload.fileId, entry.payload.rect, [P]);
        // T2: sombra separada e sala de origem (proveniência).
        mergeRefs(mapObjectExtraRefs(entry));
        break;
      }
      if (entry.kind === "scene" || entry.kind === "scene_layer" || entry.kind === "room") {
        // T2: cena (planos runtime), plano de paralaxe e sala (móveis/sala vizinha runtime; origem, estilo e inpainting = proveniência).
        mergeRefs(sceneEntryRefs(entry));
        break;
      }
      // Mapa (T1): o tileset do terreno e cada objeto colocado são dependências runtime.
      rev(entry.payload.terrain.tilesetRevisionId, [P, "terrain", "tilesetRevisionId"], true, [
        { family: "tileset", kinds: [entry.payload.terrain.mode === "corner" ? "corner" : entry.payload.terrain.mode === "side" ? "sidescroller" : "isometric"] },
      ]);
      entry.payload.objects.forEach((o, i) =>
        rev(o.objectRevisionId, [P, "objects", i, "objectRevisionId"], true, [{ family: "map", kinds: ["object"] }]),
      );
      break;

    case "ui":
      switch (entry.kind) {
        case "button":
          entry.payload.states.forEach((s, i) => raster(s.fileId, s.rect, [P, "states", i]));
          if (entry.payload.focus) raster(entry.payload.focus.fileId, entry.payload.focus.rect, [P, "focus"]);
          rev(entry.payload.text?.fontRevisionId, [P, "text", "fontRevisionId"], true, [{ family: "font" }]);
          break;
        case "panel":
          raster(entry.payload.image.fileId, entry.payload.image.rect, [P, "image"]);
          break;
        case "slot":
          entry.payload.states.forEach((s, i) => raster(s.fileId, s.rect, [P, "states", i]));
          break;
        case "meter":
          raster(entry.payload.track.fileId, entry.payload.track.rect, [P, "track"]);
          raster(entry.payload.fill.fileId, entry.payload.fill.rect, [P, "fill"]);
          raster(entry.payload.frame.fileId, entry.payload.frame.rect, [P, "frame"]);
          break;
        case "menu_item":
          rev(entry.payload.buttonRevisionId, [P, "buttonRevisionId"], true, [{ family: "ui", kinds: ["button"] }]);
          rev(entry.payload.iconRevisionId, [P, "iconRevisionId"], true, [{ family: "item" }]);
          rev(entry.payload.text.fontRevisionId, [P, "text", "fontRevisionId"], true, [{ family: "font" }]);
          break;
        case "screen":
          if (entry.payload.background) {
            rev(entry.payload.background.revisionId, [P, "background", "revisionId"], entry.payload.background.exported, [
              { family: "texture" },
              { family: "tileset" },
            ], "background");
          }
          entry.payload.instances.forEach((inst, i) => {
            rev(inst.componentRevisionId, [P, "instances", i, "componentRevisionId"], true, [
              { family: "ui" },
              { family: "portrait", kinds: ["portrait"] },
              { family: "item" },
            ]);
            rev(inst.overrides.iconRevisionId, [P, "instances", i, "overrides", "iconRevisionId"], true, [{ family: "item" }], "icon");
          });
          break;
      }
      break;

    case "portrait":
      switch (entry.kind) {
        case "portrait":
          rev(entry.payload.characterRevisionId, [P, "characterRevisionId"], false, [{ family: "character", kinds: ["base"] }]);
          raster(entry.payload.fileId, entry.payload.rect, [P]);
          break;
        case "expression":
          rev(entry.payload.portraitRevisionId, [P, "portraitRevisionId"], true, [{ family: "portrait", kinds: ["portrait"] }]);
          entry.payload.visemes.forEach((v, i) => raster(v.fileId, v.rect, [P, "visemes", i]));
          break;
        case "speech":
          rev(entry.payload.expressionRevisionId, [P, "expressionRevisionId"], true, [{ family: "portrait", kinds: ["expression"] }]);
          break;
      }
      break;

    case "font":
      entry.payload.glyphs.forEach((g, i) => raster(g.fileId, g.rect, [P, "glyphs", i]));
      if (entry.payload.ttf) files.push({ fileId: entry.payload.ttf.fileId, path: [P, "ttf"], modality: "font" });
      break;

    case "audio":
      files.push({ fileId: entry.payload.fileId, path: [P, "fileId"], modality: "audio" });
      break;
  }

  return { revisions, files };
}

/** `rigRevisionId` → `rig`, `componentRevisionId` → `component`, `predecessorRevisionId` → `predecessor`. */
function roleFromPath(path: Path): string {
  const key = String(path[path.length - 1] ?? "");
  const m = /^(.+?)RevisionIds?$/.exec(key);
  return m ? m[1]!.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) : "reference";
}
