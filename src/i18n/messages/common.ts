import type { Direction } from "@/contracts";
import { defineMessages } from "../locales";

/** Textos compartilhados por várias telas. Cada área tem seu catálogo em `src/i18n/messages/<área>.ts`. */
export const commonMessages = defineMessages({
  "pt-BR": {
    appDescription: "Oficina de assets 2D para jogos",
    providers: "Provedores de geração",
    save: "Salvar",
    cancel: "Cancelar",
    close: "Fechar",
    loading: "Carregando…",
    language: "Idioma",
    backToProjects: "← Projetos",
    backToProject: "← Projeto",
    approve: "Aprovar",
    reject: "Reprovar",
    rejectReasonPrompt: "Motivo da reprovação",
    unavailable: "indisponível",
    unknownError: "erro desconhecido",
    none: "nenhuma",
    stage: (stage: string) => `etapa ${stage}`,
    /** Rótulos das oito direções de vista. */
    directions: { N: "norte", NE: "nordeste", E: "leste", SE: "sudeste", S: "sul", SW: "sudoeste", W: "oeste", NW: "noroeste" } satisfies Record<Direction, string>,
    /** Estado de um job na fila. */
    jobState: { queued: "na fila", running: "executando", succeeded: "concluído", failed: "falhou", cancelled: "cancelado", needs_attention: "precisa de decisão" },
    /** Situação de uma revisão de asset. */
    revisionStatus: { candidate: "candidata", approved: "aprovada", rejected: "reprovada", active: "ativa" },
    /** Situação de um arquivo importado. */
    uploadStatus: { pending: "processando", ready: "pronto", rejected: "recusado" },
    /** Situação de um pacote exportado. */
    exportState: { pending: "gerando", ready: "pronto", failed: "falhou" },
    upload: {
      failed: "Falha ao enviar a imagem",
      rejected: "A imagem não pôde ser importada",
      timeout: "A importação demorou demais",
      timeoutWorker: "A importação demorou demais (o worker está rodando?)",
    },
    cost: {
      generations: (n: string, count: number) => `${n} ${count === 1 ? "geração" : "gerações"}`,
      credits: (n: string, count: number) => `${n} ${count === 1 ? "crédito" : "créditos"}`,
      mixedRange: (min: string, max: string) => `${min} a ${max}`,
      unknown: (reason: string) => `desconhecida (${reason})`,
    },
  },
  en: {
    appDescription: "2D asset workshop for games",
    providers: "Generation providers",
    save: "Save",
    cancel: "Cancel",
    close: "Close",
    loading: "Loading…",
    language: "Language",
    backToProjects: "← Projects",
    backToProject: "← Project",
    approve: "Approve",
    reject: "Reject",
    rejectReasonPrompt: "Reason for rejecting",
    unavailable: "unavailable",
    unknownError: "unknown error",
    none: "none",
    stage: (stage: string) => `stage ${stage}`,
    directions: { N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest" },
    jobState: { queued: "queued", running: "running", succeeded: "done", failed: "failed", cancelled: "cancelled", needs_attention: "needs a decision" },
    revisionStatus: { candidate: "candidate", approved: "approved", rejected: "rejected", active: "active" },
    uploadStatus: { pending: "processing", ready: "ready", rejected: "rejected" },
    exportState: { pending: "building", ready: "ready", failed: "failed" },
    upload: {
      failed: "Could not upload the image",
      rejected: "The image could not be imported",
      timeout: "The import took too long",
      timeoutWorker: "The import took too long (is the worker running?)",
    },
    cost: {
      generations: (n: string, count: number) => `${n} ${count === 1 ? "generation" : "generations"}`,
      credits: (n: string, count: number) => `${n} ${count === 1 ? "credit" : "credits"}`,
      mixedRange: (min: string, max: string) => `${min} to ${max}`,
      unknown: (reason: string) => `unknown (${reason})`,
    },
  },
});

/** Rótulo de um mapa de situações (`jobState`, `revisionStatus`…); valor desconhecido passa como está. */
export function labelOf(labels: object, key: string): string {
  return (labels as Record<string, string | undefined>)[key] ?? key;
}
