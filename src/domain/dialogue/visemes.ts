import { type SpeechTiming, VISEME_IDS, type VisemeId } from "@/contracts";

/**
 * Regra letra → viseme `letters-v1` do cartão D1 (plano temporal de fala).
 *
 * Determinística e local: texto (NFC) → sequência `(visemeId, durationMs,
 * textPosition)`. É uma aproximação por LETRAS, não reconhecimento fonético:
 * não sintetiza voz, não ouve áudio e não sincroniza com áudio gravado.
 *
 * Conjunto `pixel-studio-v1` (ordem da grade 4 × 2):
 *
 * | viseme | boca                                   | letras (pt-BR e en)                         |
 * | ------ | -------------------------------------- | ------------------------------------------- |
 * | rest   | fechada, relaxada                      | pausas, pontuação e fim da fala             |
 * | ai     | aberta larga                           | a á à â ã                                   |
 * | e      | meio aberta, lábios esticados          | e é ê i í y                                 |
 * | o      | aberta arredondada                     | o ó ô õ                                     |
 * | u      | arredondada pequena (bico)             | u ú ü w; en `oo`, `wh`                      |
 * | mbp    | lábios apertados                       | m b p                                       |
 * | fv     | lábio inferior sob os dentes           | f v; en `ph`                                |
 * | cons   | dentes quase fechados                  | demais consoantes, dígitos                  |
 *
 * Detalhes:
 * - Dígrafos de uma só boca: pt-BR `ch lh nh rr ss`, `qu`/`gu` antes de e/i
 *   (u mudo); en `th sh ch ck ng`, `ph` → fv, `wh` → u, `oo` → u, `ee` → e.
 * - `h` isolado é mudo (não gera passo).
 * - `, ; : — –` → `rest` de pausa; `. ! ? …` → `rest` de parada.
 * - Espaços não fecham a boca; aspas, parênteses e hífens colados são ignorados.
 * - Dígitos viram `cons` (o plano por letras não lê números por extenso).
 * - Símbolos sem regra (emoji, outras escritas) ficam em `unresolved` e não geram passo.
 * - Passos vizinhos com o mesmo viseme são somados (mantém a posição do primeiro).
 * - A fala termina com `rest` (`endRestMs`) na posição do fim do texto.
 * - `textPosition` = índice em code points do texto em NFC.
 */

export const SPEECH_RULE = "letters-v1" as const;

export const DEFAULT_TIMING: SpeechTiming = { rule: SPEECH_RULE, vowelMs: 110, consonantMs: 70, pauseMs: 220, stopMs: 380, endRestMs: 240 };

/** Ritmo relativo (0,5 = metade da velocidade) aplicado aos parâmetros padrão. */
export function timingAtRate(rate: number): SpeechTiming {
  const r = Math.min(2, Math.max(0.5, rate));
  const at = (ms: number) => Math.max(1, Math.round(ms / r));
  return { rule: SPEECH_RULE, vowelMs: at(DEFAULT_TIMING.vowelMs), consonantMs: at(DEFAULT_TIMING.consonantMs), pauseMs: at(DEFAULT_TIMING.pauseMs), stopMs: at(DEFAULT_TIMING.stopMs), endRestMs: at(DEFAULT_TIMING.endRestMs) };
}

export interface SpeechStep {
  visemeId: VisemeId;
  durationMs: number;
  textPosition: number;
}

export interface SpeechPlan {
  /** Texto normalizado em NFC (o que fica gravado na revisão). */
  text: string;
  timeline: SpeechStep[];
  totalMs: number;
  /** Caracteres sem regra (não geram passo), com a posição no texto NFC. */
  unresolved: { char: string; textPosition: number }[];
}

type Kind = "vowel" | "consonant" | "pause" | "stop";

const VOWELS: Record<string, VisemeId> = { a: "ai", e: "e", i: "e", y: "e", o: "o", u: "u" };
const PAUSES = new Set([",", ";", ":", "—", "–"]);
const STOPS = new Set([".", "!", "?", "…", "¡", "¿"]);
const IGNORED = new Set(['"', "'", "“", "”", "‘", "’", "«", "»", "(", ")", "[", "]", "{", "}", "-", "_", "*", "/"]);

/** Letra-base sem diacrítico, minúscula (`Ã` → `a`, `ç` → `c`). */
function baseLetter(ch: string): string {
  return ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function isLatinLetter(base: string): boolean {
  return /^[a-z]$/.test(base);
}

interface Digraph {
  match: string;
  viseme: VisemeId;
  kind: Kind;
  /** Só antes destas letras (ex.: `qu` antes de e/i). */
  before?: string;
}

const DIGRAPHS: Record<"pt" | "en", Digraph[]> = {
  pt: [
    { match: "ch", viseme: "cons", kind: "consonant" },
    { match: "lh", viseme: "cons", kind: "consonant" },
    { match: "nh", viseme: "cons", kind: "consonant" },
    { match: "rr", viseme: "cons", kind: "consonant" },
    { match: "ss", viseme: "cons", kind: "consonant" },
    { match: "qu", viseme: "cons", kind: "consonant", before: "ei" },
    { match: "gu", viseme: "cons", kind: "consonant", before: "ei" },
  ],
  en: [
    { match: "th", viseme: "cons", kind: "consonant" },
    { match: "sh", viseme: "cons", kind: "consonant" },
    { match: "ch", viseme: "cons", kind: "consonant" },
    { match: "ck", viseme: "cons", kind: "consonant" },
    { match: "ng", viseme: "cons", kind: "consonant" },
    { match: "ph", viseme: "fv", kind: "consonant" },
    { match: "wh", viseme: "u", kind: "vowel" },
    { match: "oo", viseme: "u", kind: "vowel" },
    { match: "ee", viseme: "e", kind: "vowel" },
  ],
};

function letterViseme(base: string): { viseme: VisemeId; kind: Kind } | null {
  if (VOWELS[base]) return { viseme: VOWELS[base]!, kind: "vowel" };
  if (base === "m" || base === "b" || base === "p") return { viseme: "mbp", kind: "consonant" };
  if (base === "f" || base === "v") return { viseme: "fv", kind: "consonant" };
  if (base === "w") return { viseme: "u", kind: "consonant" };
  if (isLatinLetter(base)) return { viseme: "cons", kind: "consonant" };
  return null;
}

/** Idioma da regra: pt-BR (e variantes pt) ou inglês; outros usam a tabela inglesa. */
export function ruleLanguage(language: string): "pt" | "en" {
  return language.toLowerCase().startsWith("pt") ? "pt" : "en";
}

/**
 * Texto → plano temporal pela regra `letters-v1`. Mesmo texto, idioma e
 * parâmetros = mesma sequência (reabrir reproduz a fala sem nova geração).
 */
export function planSpeech(rawText: string, language: string, timing: SpeechTiming = DEFAULT_TIMING): SpeechPlan {
  const text = rawText.normalize("NFC");
  const chars = [...text];
  const bases = chars.map(baseLetter);
  const digraphs = DIGRAPHS[ruleLanguage(language)];
  const steps: { visemeId: VisemeId; kind: Kind; textPosition: number }[] = [];
  const unresolved: SpeechPlan["unresolved"] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const base = bases[i]!;
    const pair = base + (bases[i + 1] ?? "");
    const digraph = digraphs.find((d) => d.match === pair && (!d.before || d.before.includes(bases[i + 2] ?? "#")));
    if (digraph) {
      steps.push({ visemeId: digraph.viseme, kind: digraph.kind, textPosition: i });
      i += 1;
      continue;
    }
    if (/\s/u.test(ch) || IGNORED.has(ch)) continue;
    if (PAUSES.has(ch)) {
      steps.push({ visemeId: "rest", kind: "pause", textPosition: i });
      continue;
    }
    if (STOPS.has(ch)) {
      steps.push({ visemeId: "rest", kind: "stop", textPosition: i });
      continue;
    }
    if (base === "h") continue; // h isolado é mudo
    if (/^[0-9]$/.test(ch)) {
      steps.push({ visemeId: "cons", kind: "consonant", textPosition: i });
      continue;
    }
    const letter = letterViseme(base);
    if (letter) steps.push({ visemeId: letter.viseme, kind: letter.kind, textPosition: i });
    else unresolved.push({ char: ch, textPosition: i });
  }
  const duration = (kind: Kind) => (kind === "vowel" ? timing.vowelMs : kind === "consonant" ? timing.consonantMs : kind === "pause" ? timing.pauseMs : timing.stopMs);
  const timeline: SpeechStep[] = [];
  for (const step of steps) {
    const last = timeline.at(-1);
    if (last && last.visemeId === step.visemeId) last.durationMs += duration(step.kind);
    else timeline.push({ visemeId: step.visemeId, durationMs: duration(step.kind), textPosition: step.textPosition });
  }
  const last = timeline.at(-1);
  if (last?.visemeId === "rest") last.durationMs = Math.max(last.durationMs, timing.endRestMs);
  else timeline.push({ visemeId: "rest", durationMs: timing.endRestMs, textPosition: chars.length });
  return { text, timeline, totalMs: timeline.reduce((n, s) => n + s.durationMs, 0), unresolved };
}

/**
 * Compatibilidade entre conjuntos de visemes: a fala usa IDs; outra expressão
 * serve se tiver os mesmos IDs na mesma ordem (o quadro escolhido é o de mesmo
 * ID na nova expressão). Devolve o que falta ou diverge.
 */
export function visemeCompatibility(from: readonly string[], to: readonly string[], used: readonly string[] = from) {
  const missing = [...new Set(used)].filter((id) => !to.includes(id));
  const sameOrder = from.length === to.length && from.every((id, i) => to[i] === id);
  return { compatible: missing.length === 0 && sameOrder, missing, sameOrder };
}

/** Ordem canônica: os IDs pedidos seguem `VISEME_IDS`. */
export function isCanonicalVisemeSet(ids: readonly string[]): boolean {
  return ids.length === VISEME_IDS.length && ids.every((id, i) => id === VISEME_IDS[i]);
}

/** Quadro de cada passo: tempo de início, para prévia e para o consumidor reproduzir a fala. */
export function speechFrames<T extends { visemeId: string; durationMs: number }>(timeline: readonly T[]) {
  let at = 0;
  return timeline.map((step) => {
    const frame = { ...step, startMs: at };
    at += step.durationMs;
    return frame;
  });
}
