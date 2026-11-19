import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonSchemaFiles } from "./json-schema";

const dir = path.resolve(import.meta.dirname, "..", "..", "schemas", "v1");

describe("JSON Schemas exportados", () => {
  it.each(jsonSchemaFiles().map((f) => [f.name, f.content]))("%s está atualizado (rode npm run schemas:export)", async (name, content) => {
    expect(await readFile(path.join(dir, name), "utf8")).toBe(content);
  });
});
