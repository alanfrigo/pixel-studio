"use client";

import { useRouter } from "next/navigation";
import { createContext, type ReactNode, useCallback, useContext } from "react";
import { type Catalog, DEFAULT_LOCALE, type Locale, LOCALE_COOKIE, LOCALE_NAMES, LOCALES, type LocalizedText, pick } from "./locales";

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** Mensagens de um catálogo no idioma atual: `const m = useMessages(navMessages); m.animation`. */
export function useMessages<T>(catalog: Catalog<T>): T {
  return catalog[useLocale()] as T;
}

/** Escolhe o idioma de textos vindos da API (`{en, pt-BR}`) ou passa strings simples adiante. */
export function useText(): (text: string | LocalizedText | null | undefined) => string {
  const locale = useLocale();
  return useCallback((text) => pick(text, locale), [locale]);
}

/** Seletor de idioma: grava o cookie e recarrega os componentes do servidor. */
export function LocaleSwitch({ className }: { className?: string }) {
  const locale = useLocale();
  const router = useRouter();
  return (
    <select
      className={className}
      aria-label="Language / Idioma"
      value={locale}
      onChange={(e) => {
        document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(e.target.value)}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
