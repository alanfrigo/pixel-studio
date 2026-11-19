import { SpeechPayload, VISEME_IDS, VISEME_SET_ID } from "@/contracts";
import { FONT_TEST_STRINGS, glyphGeometry } from "@/domain/dialogue/font";
import { DEFAULT_TIMING, SPEECH_RULE } from "@/domain/dialogue/visemes";
import { listAssets, listRevisions, type RevisionView } from "../catalog/catalog";
import type { Studio } from "../studio";
import { DIALOGUE_ROUTE_LABELS } from "./core";
import { verifySpeech } from "./speech";

/**
 * Catálogo da página `/dialogue` (cartão D1) numa só leitura: personagens
 * (bases), retratos, expressões, falas (com a conferência de reprodução) e
 * fontes, mais as constantes que a interface mostra (conjunto de visemes,
 * regra da fala, textos de teste).
 */
export function dialogueCatalog(studio: Studio, projectId: string) {
  const of = (family: "character" | "portrait" | "font", kind: string) =>
    listAssets(studio.db, projectId, { family })
      .filter((a) => a.kind === kind)
      .map((asset) => ({ asset, revisions: listRevisions(studio.db, projectId, asset.id) }));
  const speeches = of("portrait", "speech").map(({ asset, revisions }) => ({
    asset,
    revisions: revisions.map((r: RevisionView) => {
      const parsed = SpeechPayload.safeParse(r.payload);
      return { ...r, verify: parsed.success ? verifySpeech(parsed.data) : null };
    }),
  }));
  return {
    characters: of("character", "base"),
    portraits: of("portrait", "portrait"),
    expressions: of("portrait", "expression"),
    speeches,
    fonts: of("font", "bitmap"),
    visemes: { ids: [...VISEME_IDS], set: VISEME_SET_ID },
    speechRule: { rule: SPEECH_RULE, defaults: DEFAULT_TIMING, label: DIALOGUE_ROUTE_LABELS.speech },
    fontTestStrings: [...FONT_TEST_STRINGS],
    glyphGeometry: [6, 8, 10, 12].map(glyphGeometry),
  };
}
