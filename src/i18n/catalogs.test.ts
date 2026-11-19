import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES } from "./locales";

/**
 * Todo catálogo em `messages/` precisa ter as mesmas chaves nos dois idiomas
 * (em qualquer profundidade), funções com a mesma aridade e nenhum texto vazio.
 */

const dir = fileURLToPath(new URL("./messages/", import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

function isCatalog(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && "en" in value && "pt-BR" in value;
}

/** Chama a função com argumentos de exemplo (número, depois texto); `undefined` se nenhum servir. */
function sample(fn: (...args: unknown[]) => unknown): unknown {
  for (const arg of [2, "x"]) {
    try {
      return fn(...Array.from({ length: fn.length }, () => arg));
    } catch {
      // tenta o próximo tipo de argumento
    }
  }
  return undefined;
}

function compare(pt: unknown, en: unknown, path: string, problems: string[]): void {
  if (typeof pt === "string") {
    if (typeof en !== "string") return void problems.push(`${path}: en is ${typeof en}, pt-BR is string`);
    if (!pt.trim()) problems.push(`${path}: empty pt-BR text`);
    if (!en.trim()) problems.push(`${path}: empty en text`);
    return;
  }
  if (typeof pt === "function") {
    if (typeof en !== "function") return void problems.push(`${path}: en is ${typeof en}, pt-BR is function`);
    if (pt.length !== en.length) return void problems.push(`${path}: arity ${pt.length} (pt-BR) vs ${en.length} (en)`);
    const [a, b] = [sample(pt as (...args: unknown[]) => unknown), sample(en as (...args: unknown[]) => unknown)];
    if (typeof a === "string" && !a.trim()) problems.push(`${path}(): empty pt-BR text`);
    if (typeof b === "string" && !b.trim()) problems.push(`${path}(): empty en text`);
    return;
  }
  if (typeof pt === "object" && pt !== null) {
    if (typeof en !== "object" || en === null || Array.isArray(pt) !== Array.isArray(en)) return void problems.push(`${path}: shapes differ`);
    const [kp, ke] = [Object.keys(pt).sort(), Object.keys(en).sort()];
    for (const k of kp.filter((k) => !ke.includes(k))) problems.push(`${path}.${k}: missing in en`);
    for (const k of ke.filter((k) => !kp.includes(k))) problems.push(`${path}.${k}: missing in pt-BR`);
    for (const k of kp.filter((k) => ke.includes(k))) compare((pt as Record<string, unknown>)[k], (en as Record<string, unknown>)[k], `${path}.${k}`, problems);
    return;
  }
  if (typeof pt !== typeof en) problems.push(`${path}: ${typeof pt} (pt-BR) vs ${typeof en} (en)`);
}

describe("catálogos de mensagens", () => {
  it("existem catálogos para verificar", () => {
    expect(files).toContain("common.ts");
  });

  it.each(files)("%s: mesmas chaves e aridades nos dois idiomas, sem textos vazios", async (file) => {
    const mod = (await import(join(dir, file))) as Record<string, unknown>;
    const catalogs = Object.entries(mod).filter(([, v]) => isCatalog(v)) as [string, Record<string, unknown>][];
    expect(catalogs.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const [name, catalog] of catalogs) {
      expect(Object.keys(catalog).sort()).toEqual([...LOCALES].sort());
      compare(catalog["pt-BR"], catalog.en, name, problems);
    }
    expect(problems).toEqual([]);
  });

  it("a verificação acusa chave faltando, aridade diferente e texto vazio", () => {
    const problems: string[] = [];
    compare({ a: "x", b: (n: number) => `${n}`, c: { d: "y" }, e: "z" }, { a: "", b: () => "1", c: {}, f: "w" }, "t", problems);
    expect(problems).toEqual(["t.e: missing in en", "t.f: missing in pt-BR", "t.a: empty en text", "t.b: arity 1 (pt-BR) vs 0 (en)", "t.c.d: missing in en"]);
  });
});
