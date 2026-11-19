import { type LocalizedText, tx } from "@/i18n/locales";

type Sample = { image: string; route: string; model: LocalizedText };
type Comparison = {
  id: string;
  title: LocalizedText;
  brief: LocalizedText;
  size: number;
  source: LocalizedText;
  samples: readonly Sample[];
};

const flare = tx("openai/gpt-image-2.6-flare", "openai/gpt-image-2.6-flare");
const gemini = tx("google/gemini-3.1-flash-image", "google/gemini-3.1-flash-image");
const referenceTrial = tx("Teste com referências · 19 nov 2026", "Reference trial · 19 Nov 2026");
const codex = tx("Modelo de imagem não informado", "Image model not reported");

export const comparisons: readonly Comparison[] = [
  {
    id: "knight",
    title: tx("Cavaleiro de prata", "Silver knight"),
    brief: tx(
      "Sprite de corpo inteiro de um cavaleiro com armadura prateada, capa vermelha e espada, em pé, visto de frente.",
      "Full body game character sprite of a knight in silver armor with a red cape and a sword, standing, front view facing the viewer",
    ),
    size: 64,
    source: tx("Vitrine e teste do Codex · 19 nov 2026", "Showcase and Codex trial · 19 Nov 2026"),
    samples: [
      { image: "/examples/knight.png", route: "OpenRouter", model: flare },
      { image: "/examples/knight-codex.png", route: "Codex CLI 0.169.0 · imagegen", model: codex },
    ],
  },
  {
    id: "red-potion",
    title: tx("Poção de cura", "Health potion"),
    brief: tx(
      "Poção de cura vermelha em um frasco de vidro redondo, com rolha de cortiça e um pequeno reflexo.",
      "Red health potion in a round glass flask with a cork stopper and a small highlight",
    ),
    size: 32,
    source: tx("Vitrine e teste do Codex · 19 nov 2026", "Showcase and Codex trial · 19 Nov 2026"),
    samples: [
      { image: "/examples/potion.png", route: "OpenRouter", model: flare },
      { image: "/examples/potion-codex.png", route: "Codex CLI 0.169.0 · imagegen", model: codex },
    ],
  },
  {
    id: "green-potion",
    title: tx("Poção verde", "Green potion"),
    brief: tx(
      "Poção verde em frasco de vidro arredondado com rolha de cortiça",
      "Green potion in a round glass flask with a cork stopper",
    ),
    size: 32,
    source: tx("Avaliação de ícones · 18 nov 2026", "Icon benchmark · 18 Nov 2026"),
    samples: [
      {
        image: "/examples/green-potion-mini.png",
        route: "OpenRouter",
        model: tx("openai/gpt-image-1-mini", "openai/gpt-image-1-mini"),
      },
      { image: "/examples/green-potion-flare.png", route: "OpenRouter", model: flare },
      { image: "/examples/green-potion-gemini.png", route: "OpenRouter", model: gemini },
    ],
  },
  {
    id: "reference-one",
    title: tx("Poção com uma referência", "Potion from one reference"),
    brief: tx("Manter o formato do frasco verde original e trocar o líquido por azul. A imagem de entrada continha o frasco em duas escalas.", "Keep the original green flask's shape and turn the liquid blue. The input image showed the flask at two scales."),
    size: 32,
    source: referenceTrial,
    samples: [
      { image: "/examples/reference-one-gemini.png", route: "OpenRouter · Vertex", model: gemini },
      { image: "/examples/reference-one-flare.png", route: "OpenRouter · OpenAI", model: flare },
    ],
  },
  {
    id: "reference-two",
    title: tx("Poção com duas referências", "Potion from two references"),
    brief: tx("Manter o frasco da primeira imagem e usar a cor da túnica da segunda no líquido. O Gemini devolveu um frasco; o Flare devolveu dois.", "Keep the flask from the first image and use the second image's tunic color in the liquid. Gemini returned one flask; Flare returned two."),
    size: 32,
    source: referenceTrial,
    samples: [
      { image: "/examples/reference-two-gemini.png", route: "OpenRouter · Vertex", model: gemini },
      { image: "/examples/reference-two-flare.png", route: "OpenRouter · OpenAI", model: flare },
    ],
  },
];
