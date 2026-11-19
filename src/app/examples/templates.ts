import { type LocalizedText, tx } from "@/i18n/locales";

export const studioTemplates: readonly {
  id: string;
  family: "character" | "item";
  name: LocalizedText;
  brief: LocalizedText;
  size: number;
  image: string;
}[] = [
  {
    id: "ranger",
    family: "character",
    name: tx("Arqueira da floresta", "Forest ranger"),
    brief: tx(
      "Sprite de corpo inteiro de uma arqueira com capa verde de capuz e arco, em pé, vista de frente.",
      "Full body game character sprite of a female ranger in a green hooded cloak holding a bow, standing, front view",
    ),
    size: 64,
    image: "/examples/ranger.png",
  },
  {
    id: "wizard",
    family: "character",
    name: tx("Mago errante", "Wandering wizard"),
    brief: tx(
      "Sprite de corpo inteiro de um velho mago com túnica azul, chapéu pontudo e cajado de madeira, em pé, visto de frente.",
      "Full body game character sprite of an old wizard in a blue robe and pointed hat holding a wooden staff, standing, front view",
    ),
    size: 64,
    image: "/examples/wizard.png",
  },
  {
    id: "slime",
    family: "character",
    name: tx("Slime verde", "Green slime"),
    brief: tx(
      "Sprite de um inimigo gelatinoso verde, fofo, com olhos grandes, visto de frente.",
      "Cute green slime monster with big eyes, game enemy sprite, front view",
    ),
    size: 64,
    image: "/examples/slime.png",
  },
  {
    id: "knight",
    family: "character",
    name: tx("Cavaleiro de prata", "Silver knight"),
    brief: tx(
      "Sprite de corpo inteiro de um cavaleiro com armadura prateada, capa vermelha e espada, em pé, visto de frente.",
      "Full body game character sprite of a knight in silver armor with a red cape and a sword, standing, front view facing the viewer",
    ),
    size: 64,
    image: "/examples/knight.png",
  },
  {
    id: "potion",
    family: "item",
    name: tx("Poção de cura", "Health potion"),
    brief: tx(
      "Poção de cura vermelha em um frasco de vidro redondo, com rolha de cortiça e um pequeno reflexo.",
      "Red health potion in a round glass flask with a cork stopper and a small highlight",
    ),
    size: 32,
    image: "/examples/potion.png",
  },
];
