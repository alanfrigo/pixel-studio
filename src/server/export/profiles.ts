import { type LocalizedText, tx } from "@/i18n/locales";
import { ASSET_KINDS, type AssetFamily } from "@/contracts";
import { z } from "zod";

export const ExportProfileId = z.enum(["portable-v1", "tiled-v1", "godot-v1", "unity-v1", "aseprite-v1", "gif-v1"]);
export type ExportProfileId = z.infer<typeof ExportProfileId>;

export interface ExportProfile {
  id: ExportProfileId;
  version: number;
  label: LocalizedText;
  families: AssetFamily[];
  /** Tipos que podem iniciar uma exportação. Dependências aprovadas não precisam ser selecionadas. */
  kinds: Partial<Record<AssetFamily, readonly string[]>>;
  supports: LocalizedText[];
  limitations: LocalizedText[];
}

function nativeProfile(
  id: Exclude<ExportProfileId, "portable-v1">,
  label: string,
  kinds: ExportProfile["kinds"],
  supports: LocalizedText[],
  limitations: LocalizedText[],
): ExportProfile {
  return { id, version: 1, label: tx(label, label), families: Object.keys(kinds) as AssetFamily[], kinds, supports, limitations };
}

const engineKinds = {
  character: ["base", "clip"],
  item: ASSET_KINDS.item,
  tileset: ["corner", "sidescroller"],
  map: ["tilemap", "object"],
};

export const EXPORT_PROFILES: Record<ExportProfile["id"], ExportProfile> = {
  "portable-v1": {
    id: "portable-v1",
    version: 1,
    label: tx("ZIP portátil v1", "Portable ZIP v1"),
    families: Object.keys(ASSET_KINDS) as AssetFamily[],
    kinds: ASSET_KINDS,
    supports: [
      tx("manifest.json na raiz com schemaVersion 1, revisões fixas, dependências runtime e payload tipado", "manifest.json at the root with schemaVersion 1, pinned revisions, runtime dependencies and a typed payload"),
      tx("PNG RGBA sem perdas; retângulos [x,y,w,h] com fim exclusivo, sourceOffset/offset e pivô na célula lógica", "Lossless RGBA PNG; [x,y,w,h] rectangles with exclusive end, sourceOffset/offset and pivot in the logical cell"),
      tx("durationMs inteiro por frame como autoridade temporal; eventos por (clipRevisionId, frameId)", "Integer durationMs per frame as the timing authority; events by (clipRevisionId, frameId)"),
      tx("áudio WAV com duração, taxa, canais e frames de loop; fontes bitmap com métricas e cobertura declarada", "WAV audio with duration, rate, channels and loop frames; bitmap fonts with metrics and declared coverage"),
      tx(
        "Retratos ligados ao personagem, expressões com visemes por ID na grade declarada e planos temporais de fala (visemeId, durationMs, textPosition) com fecho de dependências; fonte bitmap = atlas + métricas como autoridade (sem TTF)",
        "Portraits linked to the character, expressions with visemes by ID in the declared grid and speech timing plans (visemeId, durationMs, textPosition) with their dependency closure; bitmap font = atlas + metrics as the authority (no TTF)",
      ),
      tx("SHA-256 e tamanho de cada arquivo; caminhos relativos sem dependência do diretório do Studio", "SHA-256 and size of each file; relative paths with no dependency on the Studio directory"),
      tx(
        "UI (U3): componentes com estados por arquivo e origem de cada aparência, foco e seu modo, nine-slice, padding, barra (trilho/preenchimento/moldura, faixa e eixo), itens de menu, telas com âncoras, offsets, grupos, ordem de desenho e de foco, catálogo de textos por idioma e resoluções testadas",
        "UI (U3): components with per-file states and the origin of each look, focus and its mode, nine-slice, padding, meter (track/fill/frame, range and axis), menu items, screens with anchors, offsets, groups, draw and focus order, per-language text catalog and tested resolutions",
      ),
    ],
    limitations: [
      tx("Atlas sem rotação nem extrusão; um arquivo por revisão de origem (sem reempacotar em atlas único)", "Atlas without rotation or extrusion; one file per source revision (no repacking into a single atlas)"),
      tx("Não inclui arquivos nativos de um destino; selecione o perfil desejado para convertê-los.", "Does not include native destination files; select a target profile to convert them."),
      tx("Prompts, referências de trabalho, respostas brutas e segredos não entram no pacote", "Prompts, working references, raw responses and secrets are not included in the package"),
      tx(
        "UI: navegação por focusOrder, rasterização das legendas (chave + catálogo) e recorte do preenchimento da barra pedem código de adaptação na engine; o template de UI e o fundo de inspeção ficam fora do pacote",
        "UI: focusOrder navigation, caption rasterization (key + catalog) and meter fill cropping need adaptation code in the engine; the UI template and the inspection background stay out of the package",
      ),
    ],
  },
  "tiled-v1": nativeProfile("tiled-v1", "Tiled · TMX e TMJ", {
    tileset: ["corner", "sidescroller"],
    map: ["tilemap", "object"],
  }, [
    tx("Mapas editáveis TMX/TMJ e tilesets TSX/TSJ, com os PNGs no mesmo ZIP.", "Editable TMX/TMJ maps and TSX/TSJ tilesets, with PNGs in the same ZIP."),
  ], [
    tx("Não converte mapas ou tilesets isométricos.", "Does not convert isometric maps or tilesets."),
  ]),
  "godot-v1": nativeProfile("godot-v1", "Godot 4.3+", engineKinds, [
    tx("Projeto Godot com sprites, animações, tilesets e mapas editáveis.", "Godot project with editable sprites, animations, tilesets, and maps."),
  ], [
    tx("Não inclui lógica de jogo, UI ou mapas isométricos.", "Does not include game logic, UI, or isometric maps."),
  ]),
  "unity-v1": nativeProfile("unity-v1", "Unity 6", engineKinds, [
    tx("Importador do Editor para criar sprites, animações, tiles e mapas editáveis.", "Editor importer that creates editable sprites, animations, tiles, and maps."),
  ], [
    tx("Requer um projeto Unity 6 com Tilemap 2D. Não inclui lógica de jogo, UI ou mapas isométricos.", "Requires a Unity 6 project with 2D Tilemap. Does not include game logic, UI, or isometric maps."),
  ]),
  "aseprite-v1": nativeProfile("aseprite-v1", "Aseprite", {
    character: ["base", "clip"],
    item: ASSET_KINDS.item,
    vfx: ASSET_KINDS.vfx,
  }, [
    tx("Arquivos .aseprite RGBA editáveis, com cels, camadas e duração por quadro.", "Editable RGBA .aseprite files with cels, layers, and per-frame duration."),
  ], [
    tx("Eventos de jogo e vínculos do rig ficam no manifesto portátil.", "Game events and rig bindings stay in the portable manifest."),
  ]),
  "gif-v1": nativeProfile("gif-v1", "GIF", {
    character: ["clip"],
    vfx: ASSET_KINDS.vfx,
  }, [
    tx("Um GIF animado por clipe ou efeito, composto na célula lógica.", "One animated GIF per clip or effect, composited in its logical cell."),
  ], [
    tx("GIF limita a paleta a 256 entradas, não preserva alfa parcial e mede duração em passos de 10 ms.", "GIF has a 256-entry palette, loses partial alpha, and represents timing in 10 ms steps."),
    tx("Eventos, movimento na raiz, pivôs e modos de mesclagem de efeitos ficam apenas no manifesto portátil.", "Game events, root motion, pivots, and effect blend modes remain in the portable manifest only."),
  ]),
};
