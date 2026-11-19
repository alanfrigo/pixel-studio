import type { FocusOrigin, ManifestEntry, Rect, StateOrigin } from "@/contracts";
import type { EntryRefs, FileRef, Path, RevisionRef } from "./manifest/refs";

/**
 * Referências da família `ui` (cartões U2/U3). Runtime = exigido para montar
 * a peça ou a tela no destino (estados e partes por arquivo, botão do item de
 * menu, fonte, componentes e ícones das instâncias, fundo exportado).
 * Proveniência = de onde veio cada aparência (template recortado, componente
 * usado como referência, revisão transformada localmente): opcional no pacote.
 */

type UiEntry = Extract<ManifestEntry, { family: "ui" }>;

const P = "payload";

export function uiEntryRefs(entry: UiEntry): EntryRefs {
  const revisions: RevisionRef[] = [];
  const files: FileRef[] = [];
  const rev = (revisionId: string | null | undefined, path: Path, runtime: boolean, expect: RevisionRef["expect"], role: string) => {
    if (revisionId) revisions.push({ revisionId, path, runtime, expect, role });
  };
  const raster = (img: { fileId: string; rect: Rect } | null | undefined, path: Path) => {
    if (img) files.push({ fileId: img.fileId, path, modality: "raster", rect: img.rect });
  };
  const stateOrigin = (origin: StateOrigin | undefined, path: Path) => {
    if (!origin) return;
    if (origin.kind === "template_split") rev(origin.templateRevisionId, [...path, "templateRevisionId"], false, [{ family: "ui", kinds: ["template"] }], "template");
    if (origin.kind === "generated_reference") rev(origin.referenceRevisionId, [...path, "referenceRevisionId"], false, [{ family: "ui" }], "reference");
    if (origin.kind === "local_transform") rev(origin.sourceRevisionId, [...path, "sourceRevisionId"], false, [{ family: "ui" }], "source");
  };
  const focusOrigin = (origin: FocusOrigin | undefined, path: Path) => {
    if (origin?.kind === "local_overlay") rev(origin.sourceRevisionId, [...path, "sourceRevisionId"], false, [{ family: "ui" }], "source");
  };

  switch (entry.kind) {
    case "button": {
      const p = entry.payload;
      p.states.forEach((s, i) => {
        raster(s, [P, "states", i]);
        stateOrigin(s.origin, [P, "states", i, "origin"]);
      });
      if (p.focus) {
        raster(p.focus, [P, "focus"]);
        focusOrigin(p.focus.origin, [P, "focus", "origin"]);
      }
      rev(p.text?.fontRevisionId, [P, "text", "fontRevisionId"], true, [{ family: "font" }], "font");
      break;
    }
    case "panel":
      raster(entry.payload.image, [P, "image"]);
      break;
    case "slot":
      entry.payload.states.forEach((s, i) => {
        raster(s, [P, "states", i]);
        stateOrigin(s.origin, [P, "states", i, "origin"]);
      });
      break;
    case "meter":
      raster(entry.payload.track, [P, "track"]);
      raster(entry.payload.fill, [P, "fill"]);
      raster(entry.payload.frame, [P, "frame"]);
      break;
    case "menu_item":
      rev(entry.payload.buttonRevisionId, [P, "buttonRevisionId"], true, [{ family: "ui", kinds: ["button"] }], "button");
      rev(entry.payload.iconRevisionId, [P, "iconRevisionId"], true, [{ family: "item" }], "icon");
      rev(entry.payload.text.fontRevisionId, [P, "text", "fontRevisionId"], true, [{ family: "font" }], "font");
      break;
    case "template":
      raster(entry.payload.image, [P, "image"]);
      break;
    case "screen": {
      const p = entry.payload;
      if (p.background) {
        // Fundo de inspeção = proveniência; fundo exportado = parte da tela.
        rev(p.background.revisionId, [P, "background", "revisionId"], p.background.exported, [
          { family: "texture" },
          { family: "tileset" },
          { family: "map", kinds: ["scene", "scene_layer", "room"] },
        ], "background");
      }
      p.instances.forEach((inst, i) => {
        // Retrato: qualquer revisão de imagem aprovada (retrato do D1, personagem, ícone).
        rev(inst.componentRevisionId, [P, "instances", i, "componentRevisionId"], true, [
          { family: "ui", kinds: ["button", "panel", "slot", "meter", "menu_item"] },
          { family: "portrait" },
          { family: "item" },
          { family: "character", kinds: ["base"] },
        ], "component");
        rev(inst.overrides.iconRevisionId, [P, "instances", i, "overrides", "iconRevisionId"], true, [{ family: "item" }], "icon");
        rev(inst.text?.fontRevisionId, [P, "instances", i, "text", "fontRevisionId"], true, [{ family: "font" }], "font");
      });
      break;
    }
  }
  return { revisions, files };
}
