import { type LocalizedText, tx } from "@/i18n/locales";
import { AssetFamily } from "@/contracts";

/**
 * Perfis de exportação e o que cada um transporta (08 · X1: "Registrar o que
 * o perfil suporta"). Perfis de destino (Tiled, Godot, Aseprite) entram com X2.
 */
export interface ExportProfile {
  id: "portable-v1";
  version: number;
  label: LocalizedText;
  families: AssetFamily[];
  supports: LocalizedText[];
  limitations: LocalizedText[];
}

export const EXPORT_PROFILES: Record<ExportProfile["id"], ExportProfile> = {
  "portable-v1": {
    id: "portable-v1",
    version: 1,
    label: tx("ZIP portátil v1", "Portable ZIP v1"),
    families: [...AssetFamily.options],
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
      tx("Sem arquivos de destino (TMJ/TSJ do Tiled, recursos Godot, Aseprite, GIF): perfis do cartão X2", "No destination files (Tiled TMJ/TSJ, Godot resources, Aseprite, GIF): X2 card profiles"),
      tx("Prompts, referências de trabalho, respostas brutas e segredos não entram no pacote", "Prompts, working references, raw responses and secrets are not included in the package"),
      tx(
        "UI: navegação por focusOrder, rasterização das legendas (chave + catálogo) e recorte do preenchimento da barra pedem código de adaptação na engine; o template de UI e o fundo de inspeção ficam fora do pacote",
        "UI: focusOrder navigation, caption rasterization (key + catalog) and meter fill cropping need adaptation code in the engine; the UI template and the inspection background stay out of the package",
      ),
    ],
  },
};
