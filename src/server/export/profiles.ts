import { AssetFamily } from "@/contracts";

/**
 * Perfis de exportação e o que cada um transporta (08 · X1: "Registrar o que
 * o perfil suporta"). Perfis de destino (Tiled, Godot, Aseprite) entram com X2.
 */
export interface ExportProfile {
  id: "portable-v1";
  version: number;
  label: string;
  families: AssetFamily[];
  supports: string[];
  limitations: string[];
}

export const EXPORT_PROFILES: Record<ExportProfile["id"], ExportProfile> = {
  "portable-v1": {
    id: "portable-v1",
    version: 1,
    label: "ZIP portátil v1",
    families: [...AssetFamily.options],
    supports: [
      "manifest.json na raiz com schemaVersion 1, revisões fixas, dependências runtime e payload tipado",
      "PNG RGBA sem perdas; retângulos [x,y,w,h] com fim exclusivo, sourceOffset/offset e pivô na célula lógica",
      "durationMs inteiro por frame como autoridade temporal; eventos por (clipRevisionId, frameId)",
      "áudio WAV com duração, taxa, canais e frames de loop; fontes bitmap com métricas e cobertura declarada",
      "SHA-256 e tamanho de cada arquivo; caminhos relativos sem dependência do diretório do Studio",
    ],
    limitations: [
      "Atlas sem rotação nem extrusão; um arquivo por revisão de origem (sem reempacotar em atlas único)",
      "Sem arquivos de destino (TMJ/TSJ do Tiled, recursos Godot, Aseprite, GIF): perfis do cartão X2",
      "Prompts, referências de trabalho, respostas brutas e segredos não entram no pacote",
    ],
  },
};
