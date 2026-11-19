import { z } from "zod";
import { DurationMs, Id, Playback, PosInt, Slug } from "@/contracts";
import { type LocalizedText, tx } from "@/i18n/locales";

/**
 * Presets de ação versionados (04 §um clique). Cada preset fixa ação, roteiro
 * do movimento, estratégia (texto ou sequência de esqueleto), quadros com ID
 * próprio, duração inteira por quadro e repetição. Mudar qualquer campo cria
 * uma versão nova com outro ID: planos antigos continuam apontando a versão
 * que congelaram.
 *
 * As contagens são intenção local, não parâmetros universais: `hurt` tem três
 * quadros de pose precisa e por isso é um preset de esqueleto, que exige
 * movimento aprovado para a base antes do clique.
 */

export const PoseRecipe = z.enum(["idle_breath", "walk_cycle", "run_cycle", "attack_swing", "attack_wide", "hurt_recoil"]);
export type PoseRecipe = z.infer<typeof PoseRecipe>;

export const ActionPreset = z
  .strictObject({
    key: Slug,
    version: PosInt,
    label: z.string().min(1).max(60),
    action: Slug,
    stance: Slug.nullable(),
    strategy: z.enum(["text", "skeleton"]),
    frameIds: z.array(Id).min(1).max(16),
    durationsMs: z.array(DurationMs).min(1).max(16),
    playback: Playback,
    /** Roteiro do movimento para o modo texto; cores por nome, nunca códigos hex. */
    motion: z.strictObject({ "pt-BR": z.string().min(1).max(500), en: z.string().min(1).max(500) }),
    /** O que o artista revisa (04 §tabela de presets). */
    intent: z.string().min(1).max(200),
    /** Gerador das poses-guia quando o preset é aberto no editor de esqueleto. */
    poseRecipe: PoseRecipe,
  })
  .superRefine((p, ctx) => {
    if (p.frameIds.length !== p.durationsMs.length) {
      ctx.addIssue({ code: "custom", message: "frameIds e durationsMs devem ter o mesmo tamanho" });
    }
    if (new Set(p.frameIds).size !== p.frameIds.length) ctx.addIssue({ code: "custom", message: "IDs de quadro repetidos" });
  });
export type ActionPreset = z.infer<typeof ActionPreset>;

const presets: ActionPreset[] = [
  {
    key: "idle",
    version: 1,
    label: "Respirar parado",
    action: "idle",
    stance: null,
    strategy: "text",
    frameIds: ["rest", "rise", "peak", "fall"],
    durationsMs: [180, 180, 180, 180],
    playback: "loop",
    motion: {
      "pt-BR": "respirando parado em repouso: o peito sobe e desce de leve, os pés continuam apoiados no chão, termina na pose inicial para formar um ciclo",
      en: "breathing idle at rest: the chest rises and falls slightly, both feet stay planted, ends in the starting pose so it loops",
    },
    intent: "Oscilação leve, pés em contato.",
    poseRecipe: "idle_breath",
  },
  {
    key: "walk",
    version: 1,
    label: "Caminhar",
    action: "walk",
    stance: null,
    strategy: "text",
    frameIds: ["contact-l", "down-l", "pass-l", "contact-r", "down-r", "pass-r"],
    durationsMs: [120, 120, 120, 120, 120, 120],
    playback: "loop",
    motion: {
      "pt-BR": "caminhando no lugar em ciclo: contato do pé esquerdo, apoio, passagem, contato do pé direito, apoio, passagem; braços balançam opostos às pernas",
      en: "walking in place as a cycle: left foot contact, down, passing, right foot contact, down, passing; arms swing opposite to the legs",
    },
    intent: "Marcar os contatos alternados.",
    poseRecipe: "walk_cycle",
  },
  {
    key: "run",
    version: 1,
    label: "Correr",
    action: "run",
    stance: null,
    strategy: "text",
    frameIds: ["contact-l", "push-l", "air-l", "contact-r", "push-r", "air-r"],
    durationsMs: [85, 85, 85, 85, 85, 85],
    playback: "loop",
    motion: {
      "pt-BR": "correndo no lugar em ciclo, passada longa com fase aérea em que nenhum pé toca o chão, tronco inclinado para a frente",
      en: "running in place as a cycle, long stride with an airborne phase where neither foot touches the ground, torso leaning forward",
    },
    intent: "Alongar a passada e preservar a fase aérea.",
    poseRecipe: "run_cycle",
  },
  {
    key: "attack-shield",
    version: 1,
    label: "Ataque curto com escudo",
    action: "attack",
    stance: "one_hand_shield",
    strategy: "text",
    frameIds: ["windup", "advance", "contact", "recover"],
    durationsMs: [140, 80, 60, 160],
    playback: "once",
    motion: {
      "pt-BR": "golpe curto de espada com uma mão: preparação, avanço, contato e recuperação, mantendo o outro braço junto ao corpo",
      en: "short one-handed sword strike: wind-up, advance, contact and recovery, keeping the other arm close to the body",
    },
    intent: "Separar preparação, contato e recuperação.",
    poseRecipe: "attack_swing",
  },
  {
    key: "attack-two-handed",
    version: 1,
    label: "Golpe amplo com duas mãos",
    action: "attack",
    stance: "two_handed",
    strategy: "text",
    frameIds: ["guard", "raise", "windup", "contact", "follow", "recover"],
    durationsMs: [120, 100, 90, 60, 110, 180],
    playback: "once",
    motion: {
      "pt-BR": "golpe amplo segurando a arma com as duas mãos: guarda, erguer, preparação, contato, continuação e recuperação",
      en: "wide two-handed swing: guard, raise, wind-up, contact, follow-through and recovery",
    },
    intent: "Guardas e poses corporais próprias do golpe amplo.",
    poseRecipe: "attack_wide",
  },
  {
    key: "hurt",
    version: 1,
    label: "Recuo ao ser atingido",
    action: "hurt",
    stance: null,
    strategy: "skeleton",
    frameIds: ["hit", "recoil", "return"],
    durationsMs: [100, 70, 140],
    playback: "once",
    motion: {
      "pt-BR": "recua ao ser atingido e volta à pose de transição",
      en: "recoils when hit and returns to the transition pose",
    },
    intent: "Recuo legível, retorno à pose de transição.",
    poseRecipe: "hurt_recoil",
  },
];

/**
 * Rótulo e intenção de cada preset nos dois idiomas da interface. Ficam fora
 * do preset de propósito: o digest da versão (fonte congelada nos planos) não
 * muda; `label`/`intent` do preset continuam em português.
 */
const PRESET_TEXT: Record<string, { label: LocalizedText; intent: LocalizedText }> = {
  idle: { label: tx("Respirar parado", "Idle breathing"), intent: tx("Oscilação leve, pés em contato.", "Slight sway, feet stay planted.") },
  walk: { label: tx("Caminhar", "Walk"), intent: tx("Marcar os contatos alternados.", "Mark the alternating foot contacts.") },
  run: { label: tx("Correr", "Run"), intent: tx("Alongar a passada e preservar a fase aérea.", "Lengthen the stride and keep the airborne phase.") },
  "attack-shield": { label: tx("Ataque curto com escudo", "Short attack with shield"), intent: tx("Separar preparação, contato e recuperação.", "Separate wind-up, contact and recovery.") },
  "attack-two-handed": { label: tx("Golpe amplo com duas mãos", "Wide two-handed swing"), intent: tx("Guardas e poses corporais próprias do golpe amplo.", "Guards and body poses specific to the wide swing.") },
  hurt: { label: tx("Recuo ao ser atingido", "Recoil when hit"), intent: tx("Recuo legível, retorno à pose de transição.", "Readable recoil, back to the transition pose.") },
};

/** Rótulo e intenção bilíngues do preset (preset sem tradução repete o texto original nos dois idiomas). */
export function presetText(preset: Pick<ActionPreset, "key" | "label" | "intent">): { label: LocalizedText; intent: LocalizedText } {
  return PRESET_TEXT[preset.key] ?? { label: tx(preset.label, preset.label), intent: tx(preset.intent, preset.intent) };
}

/** Presets embutidos, validados ao carregar o módulo. */
export const BUILTIN_PRESETS: readonly ActionPreset[] = presets.map((p) => ActionPreset.parse(p));

export function findPreset(key: string, version?: number): ActionPreset | undefined {
  const matches = BUILTIN_PRESETS.filter((p) => p.key === key && (version === undefined || p.version === version));
  return matches.sort((a, b) => b.version - a.version)[0];
}

/**
 * ID da revisão do preset dentro do projeto: `<projeto>:preset:<chave>:v<versão>`.
 * O projeto no ID mantém a regra de que um plano só cita revisões do próprio projeto.
 */
export function presetRevisionId(projectId: string, preset: Pick<ActionPreset, "key" | "version">): string {
  return `${projectId}:preset:${preset.key}:v${preset.version}`;
}

export function parsePresetRevisionId(revisionId: string): { projectId: string; preset: ActionPreset } | null {
  const m = /^(.+):preset:([a-z0-9][a-z0-9_.-]*):v(\d+)$/.exec(revisionId);
  if (!m) return null;
  const preset = findPreset(m[2]!, Number(m[3]));
  return preset ? { projectId: m[1]!, preset } : null;
}
