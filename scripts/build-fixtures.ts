/**
 * Grava a fixture "clareira" em `fixtures/clareira/`:
 *   package/   pacote portátil v1 (manifest.json + mídia)
 *   project/   arquivos de trabalho, estilo, catálogo e planos de exemplo
 *
 * Determinístico: rodar duas vezes produz os mesmos bytes. O teste
 * `fixtures.test.ts` falha se o disco divergir do gerador.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildClareira } from "@/fixtures/clareira";
import { fixtureJsonFiles } from "@/fixtures/layout";

const root = path.resolve(import.meta.dirname, "..", "fixtures", "clareira");

async function write(relative: string, bytes: Uint8Array) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

const fixture = buildClareira();
await rm(root, { recursive: true, force: true });
for (const file of fixture.packageFiles) await write(path.join("package", file.path), file.bytes);
for (const file of fixture.projectFiles) await write(path.join("project", file.path), file.bytes);
for (const file of fixtureJsonFiles(fixture)) await write(file.path, file.bytes);

console.log(`Fixture gravada em ${path.relative(process.cwd(), root)}`);
