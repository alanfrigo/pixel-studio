import { cookies, headers } from "next/headers";
import { type Catalog, type Locale, LOCALE_COOKIE, negotiateLocale } from "./locales";

/** Idioma da requisição atual em componentes do servidor (layout, páginas, generateMetadata). */
export async function requestLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return negotiateLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}

/** Mensagens de um catálogo em componentes do servidor. */
export async function serverMessages<T>(catalog: Catalog<T>): Promise<T> {
  return catalog[await requestLocale()] as T;
}
