import type { ManifestEntry, Rect } from "@/contracts";
import type { EntryRefs, FileRef, Path, RevisionRef } from "../manifest/refs";

/**
 * Referências das saídas do cartão T2 (cena, plano, sala). Runtime = exigido
 * para usar o asset no destino (planos da cena, móveis colocados, sala vizinha
 * ligada por porta). Proveniência = de onde veio (sala de origem, sala de
 * estilo, imagem plana de que um plano foi derivado, inpainting que
 * reconstruiu uma área): opcional no pacote.
 */

type SceneEntry = Extract<ManifestEntry, { family: "map"; kind: "scene" | "scene_layer" | "room" }>;

const P = "payload";

export function sceneEntryRefs(entry: SceneEntry): EntryRefs {
  const revisions: RevisionRef[] = [];
  const files: FileRef[] = [];
  const rev = (revisionId: string | null | undefined, path: Path, runtime: boolean, expect: RevisionRef["expect"], role: string) => {
    if (revisionId) revisions.push({ revisionId, path, runtime, expect, role });
  };
  const raster = (img: { fileId: string; rect: Rect } | null | undefined, path: Path) => {
    if (img) files.push({ fileId: img.fileId, path, modality: "raster", rect: img.rect });
  };

  switch (entry.kind) {
    case "scene": {
      const p = entry.payload;
      raster(p.image, [P, "image"]);
      p.layers.forEach((l, i) => rev(l.layerRevisionId, [P, "layers", i, "layerRevisionId"], true, [{ family: "map", kinds: ["scene_layer"] }], "layer"));
      rev(p.characterScale?.characterRevisionId, [P, "characterScale", "characterRevisionId"], false, [{ family: "character", kinds: ["base"] }], "scale_character");
      break;
    }
    case "scene_layer": {
      const p = entry.payload;
      raster({ fileId: p.fileId, rect: p.rect }, [P]);
      if (p.derivation) {
        raster(p.derivation.mask, [P, "derivation", "mask"]);
        rev(p.derivation.sourceRevisionId, [P, "derivation", "sourceRevisionId"], false, [{ family: "map", kinds: ["scene"] }], "source");
        rev(p.derivation.inpaintRevisionId, [P, "derivation", "inpaintRevisionId"], false, [{ family: "map", kinds: ["scene", "scene_layer"] }], "inpaint");
      }
      break;
    }
    case "room": {
      const p = entry.payload;
      raster(p.picture, [P, "picture"]);
      raster(p.background, [P, "background"]);
      raster(p.overlay, [P, "overlay"]);
      p.furniture.forEach((f, i) => rev(f.objectRevisionId, [P, "furniture", i, "objectRevisionId"], true, [{ family: "map", kinds: ["object"] }], "furniture"));
      p.connections.forEach((c, i) => rev(c.toRoomRevisionId, [P, "connections", i, "toRoomRevisionId"], true, [{ family: "map", kinds: ["room"] }], "connected_room"));
      rev(p.styleRoomRevisionId, [P, "styleRoomRevisionId"], false, [{ family: "map", kinds: ["room"] }], "style_room");
      rev(p.sourceRoomRevisionId, [P, "sourceRoomRevisionId"], false, [{ family: "map", kinds: ["room"] }], "source_room");
      p.exposedAreas.forEach((a, i) => {
        raster(a.mask, [P, "exposedAreas", i, "mask"]);
        rev(a.inpaintRevisionId, [P, "exposedAreas", i, "inpaintRevisionId"], false, [{ family: "map", kinds: ["room"] }], "inpaint");
      });
      break;
    }
  }
  return { revisions, files };
}

/** Objeto de mapa (T1) com os campos do T2: sombra separada e sala de origem (proveniência). */
export function mapObjectExtraRefs(entry: Extract<ManifestEntry, { family: "map"; kind: "object" }>): EntryRefs {
  const p = entry.payload;
  const revisions: RevisionRef[] = [];
  const files: FileRef[] = [];
  if (p.shadow) files.push({ fileId: p.shadow.fileId, path: [P, "shadow"], modality: "raster", rect: p.shadow.rect });
  if (p.sourceRoom) {
    revisions.push({ revisionId: p.sourceRoom.roomRevisionId, path: [P, "sourceRoom", "roomRevisionId"], runtime: false, expect: [{ family: "map", kinds: ["room"] }], role: "source_room" });
  }
  return { revisions, files };
}
