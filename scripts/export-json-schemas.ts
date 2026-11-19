/**
 * Exporta os contratos v1 como JSON Schema (draft 2020-12) em `schemas/v1/`,
 * para o processador Python e consumidores externos validarem a mesma
 * fronteira. Regras com `superRefine` (unicidade, coerência) não são
 * representáveis em JSON Schema: o validador de domínio continua obrigatório.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsonSchemaFiles } from "@/contracts/json-schema";

const outDir = path.resolve(import.meta.dirname, "..", "schemas", "v1");
await mkdir(outDir, { recursive: true });
for (const file of jsonSchemaFiles()) {
  await writeFile(path.join(outDir, file.name), file.content);
}
console.log(`JSON Schemas gravados em ${path.relative(process.cwd(), outDir)}`);
