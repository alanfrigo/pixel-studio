import { type TextValue, tx } from "@/i18n/locales";

const MINI = "openai/gpt-image-1-mini";
const FLARE = "openai/gpt-image-2.6-flare";
const GEMINI = "google/gemini-3.1-flash-image";

export type CreationProfile = {
  id: string;
  name: string;
  model: string | null;
  transport: string;
  simulated: boolean;
  capabilities: Record<string, string[]>;
  maxReferences?: number;
  unavailable: TextValue | null;
};

const modelLabels: Record<string, string> = {
  [FLARE]: "GPT Image 2.6 Flare",
  [MINI]: "GPT Image 1 Mini",
  [GEMINI]: "Gemini 3.1 Flash Image",
  "microsoft/mai-image-2.7-flash": "MAI Image 2.7 Flash",
  "black-forest-labs/flux-3-image-klein": "FLUX 3 Klein",
  "bytedance-seed/seedream-4.5": "Seedream 4.5",
  "bytedance-seed/seedream-5-0-flash": "Seedream 5.0 Flash",
  "bytedance-seed/seedream-5-5": "Seedream 5.5",
  "qwen/qwen-image-2.1-turbo": "Qwen Image 2.1 Turbo",
};

export function creationModelLabel(profile: CreationProfile) {
  if (profile.transport === "codex_cli") return "Codex";
  return (profile.model && (modelLabels[profile.model] ?? profile.model)) || profile.name;
}

export function creationReferenceLimit(profile: CreationProfile) {
  return profile.capabilities.generate_asset?.includes("image_references") ? Math.min(16, profile.maxReferences ?? 16) : 0;
}

export function recommendCreation(profiles: readonly CreationProfile[], family: "character" | "item", referenceCount: number) {
  const available = profiles.filter((p) => !p.unavailable && p.capabilities.generate_asset?.includes("text_to_image") && creationReferenceLimit(p) >= referenceCount);
  const orderedModels = referenceCount > 0 ? [GEMINI, FLARE] : family === "character" ? [FLARE] : [MINI, FLARE];
  const score = (p: CreationProfile) => {
    if (p.simulated) return 100;
    if (p.transport === "openrouter_images") {
      const index = orderedModels.indexOf(p.model ?? "");
      if (index >= 0) return index;
    }
    return p.transport === "codex_cli" ? 10 : 20;
  };
  available.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  return { recommended: available[0], available };
}

export function creationModelReason(profile: CreationProfile, referenceCount: number) {
  if (profile.simulated) return tx("Teste offline. Não interpreta sua descrição nem as imagens.", "Offline test. It does not interpret your brief or images.");
  if (profile.transport === "codex_cli") return tx("Usa o plano ChatGPT. Seguiu a referência de estilo no ensaio.", "Uses your ChatGPT plan. It followed the style reference in testing.");
  if (profile.model === FLARE) return referenceCount
    ? tx("Gerou transparência e teve menor custo no ensaio. Com duas referências, repetiu o objeto.", "Generated transparency and cost less in the trial. With two references, it duplicated the object.")
    : tx("Produziu silhuetas legíveis e detalhes consistentes nos testes de sprites.", "Produced readable silhouettes and consistent detail in sprite tests.");
  if (profile.model === MINI) return tx("Econômico para ícones por texto; pode alterar o contorno da referência.", "Low-cost for text-only icons; may change reference outlines.");
  if (profile.model === GEMINI) return tx("Nos testes com referências, preservou melhor o contorno e entregou um único ícone. O Studio remove o fundo.", "In reference trials, it kept the outline better and returned one icon. Studio removes the background.");
  return tx("Compatível com este pedido, sem recomendação comparativa para esta tarefa.", "Compatible with this request, with no benchmark recommendation for this task.");
}

// MODELS.md §§1–9, 11: these are starting points from single-run trials, not capability claims.
export const modelGuidance = [
  {
    id: "character",
    task: tx("Personagens e imagens", "Characters and images"),
    model: `Codex CLI / ${FLARE}`,
    evidence: tx("O cavaleiro de 64×64 do Codex ficou legível em 1×. O Flare produziu personagens e objetos utilizáveis na galeria; revise o resultado após a redução à grade.", "Codex made a readable 64×64 knight at 1×. Flare produced usable characters and props in the gallery; review the result after pixel-grid reduction."),
  },
  {
    id: "icon",
    task: tx("Ícones por texto", "Text-only icons"),
    model: `${MINI} / ${FLARE}`,
    evidence: tx("Comece com o Mini para texto puro ou lotes: recuperou a grade exata em 6 de 6 casos, mas às vezes ignorou o contorno da referência.", "Start with Mini for text-only icons or batches: it recovered the exact grid in 6 of 6 cases but sometimes ignored reference outlines."),
  },
  {
    id: "reference",
    task: tx("Criação com referência", "Reference-guided creation"),
    model: `${GEMINI} / ${FLARE}`,
    evidence: tx("Em dois pedidos de ícones de 32 px, o Gemini preservou melhor o contorno e produziu um único objeto. O Flare custou menos, mas repetiu o frasco no pedido com duas imagens. Para personagens, a escolha ainda é provisória.", "Across two 32 px icon briefs, Gemini preserved the outline better and returned one object. Flare cost less, but repeated the flask on the two-image brief. The choice is still provisional for characters."),
  },
  {
    id: "animation",
    task: tx("Animação e equipamento", "Animation and equipment"),
    model: FLARE,
    evidence: tx("Manteve melhor a identidade na caminhada, nas vistas e nas tiras de roupa que o Mini. O modelo desenha uma folha de sprites ou um candidato vestido; o Studio recorta as peças localmente. Não é animação esquelética nativa.", "It kept identity more consistent in walks, new views and outfit strips than Mini. The model draws a sprite sheet or a dressed candidate; Studio slices or extracts it locally. This is not native skeletal animation."),
  },
  {
    id: "mask",
    task: tx("Edição com máscara", "Masked edits"),
    model: FLARE,
    evidence: tx("Reconstruiu a margem do lago e a parede de pedra. A composição local preservou todos os pixels fora da máscara, não o modelo. Máscaras nativas da OpenAI Images não tiveram teste real.", "It rebuilt the lakeshore and stone wall. The local composite preserved every pixel outside the mask, not the model. OpenAI Images native masks were not tested live."),
  },
  {
    id: "world",
    task: tx("Texturas, mundos e cenas", "Textures, worlds and scenes"),
    model: `${MINI} / ${FLARE}`,
    evidence: tx("O Mini passou no teste de repetição para grama, água e pedra no ensaio. Use o Flare como ponto de partida para tilesets guiados, cenas e cômodos. Valide emendas: alguns tiles ganharam bordas e nem todo plano de parallax repetiu. Uma cena plana não cria objetos nem colisões.", "Mini passed the wrap test for grass, water and stone in the trial. Start with Flare for guided tilesets, scenes and rooms. Check seams: some tiles gained borders and not every parallax layer looped. A flat scene does not generate objects or collisions."),
  },
  {
    id: "unbenchmarked",
    task: tx("Interface, retratos e fontes", "UI kits, portraits and fonts"),
    model: `Codex CLI / ${FLARE}`,
    evidence: tx("Kits de interface, retratos, folhas de bocas e páginas de glifos só foram testados com o simulado. Codex e Flare são pontos de partida a experimentar, não recomendações validadas.", "UI kits, portraits, mouth sheets and glyph pages were tested only with the simulated provider. Codex and Flare are starting points to try, not validated recommendations."),
  },
];
