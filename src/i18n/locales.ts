import { z } from "zod";

/**
 * Idiomas da interface. Sem prefixo de rota: o Studio é local e o idioma vem
 * do cookie escolhido no seletor ou, na primeira visita, do Accept-Language
 * do navegador (pt* → pt-BR; qualquer outro → en).
 */

export const LOCALES = ["en", "pt-BR"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "ps-locale";

export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "pt-BR": "Português (Brasil)" };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** Texto nos dois idiomas; usado por mensagens do servidor e rótulos devolvidos pela API. */
export const LocalizedText = z.strictObject({ en: z.string().min(1), "pt-BR": z.string().min(1) });
export type LocalizedText = z.infer<typeof LocalizedText>;

/** Atalho para mensagens bilíngues no código do servidor: `tx("Perfil não encontrado", "Profile not found")`. */
export function tx(ptBR: string, en: string): LocalizedText {
  return { "pt-BR": ptBR, en };
}

export function isLocalized(value: unknown): value is LocalizedText {
  return typeof value === "object" && value !== null && typeof (value as LocalizedText).en === "string" && typeof (value as LocalizedText)["pt-BR"] === "string";
}

/** Texto no idioma pedido; string simples (ex.: dado antigo gravado num idioma só) passa como está. */
export function pick(text: string | LocalizedText | null | undefined, locale: Locale): string {
  if (text === null || text === undefined) return "";
  return typeof text === "string" ? text : text[locale];
}

/**
 * Catálogo tipado de mensagens da interface: o inglês precisa ter exatamente
 * as chaves (e as assinaturas de função) do português. Valores podem ser
 * texto ou funções para plural e interpolação.
 */
export type Catalog<T> = { "pt-BR": T; en: NoInfer<T> };
export function defineMessages<T>(catalog: Catalog<T>): Catalog<T> {
  return catalog;
}

/** Idioma pela ordem: cookie válido → Accept-Language (com q) → padrão. */
export function negotiateLocale(cookieValue: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(params.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? "1");
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.tag && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of ranked) {
    if (tag === "pt" || tag.startsWith("pt-")) return "pt-BR";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return DEFAULT_LOCALE;
}

/** Valor de um cookie num cabeçalho `Cookie` cru (rotas da API e testes). */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Idioma de uma requisição da API (sem depender de `next/headers`). */
export function localeOf(req: Pick<Request, "headers">): Locale {
  return negotiateLocale(cookieValue(req.headers.get("cookie"), LOCALE_COOKIE), req.headers.get("accept-language"));
}

/** Aviso ou rótulo gravado: texto simples (legado, um idioma) ou bilíngue. */
export type TextValue = string | LocalizedText;
