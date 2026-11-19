import { createHash } from "node:crypto";

/**
 * JSON canônico para digests de planos e receitas (02 §jobs, 05 §repetição):
 * chaves de objeto ordenadas, ordem de arrays preservada (referências, frames e
 * camadas são significativas), sem espaços. Rejeita valores não representáveis.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Número não finito em JSON canônico");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (seen.has(value)) throw new TypeError("Referência circular em JSON canônico");
      seen.add(value);
      let out: string;
      if (Array.isArray(value)) {
        out = `[${value.map((v) => serialize(v === undefined ? null : v, seen)).join(",")}]`;
      } else {
        const keys = Object.keys(value)
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
          .sort();
        out = `{${keys.map((k) => `${JSON.stringify(k)}:${serialize((value as Record<string, unknown>)[k], seen)}`).join(",")}}`;
      }
      seen.delete(value);
      return out;
    }
    default:
      throw new TypeError(`Tipo não suportado em JSON canônico: ${typeof value}`);
  }
}

export function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
