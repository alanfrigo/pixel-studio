import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PythonResponse } from "@/contracts";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { DomainFailure } from "../errors";
import { runPython } from "./bridge";

const PYTHON = path.join(process.cwd(), "python", ".venv", "bin", "python");

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function workWith(bytes: Uint8Array): Promise<{ workDir: string; sha256: string }> {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-bridge-"));
  dirs.push(workDir);
  await mkdir(path.join(workDir, "in"));
  await writeFile(path.join(workDir, "in", "source.png"), bytes);
  return { workDir, sha256: createHash("sha256").update(bytes).digest("hex") };
}

describe.skipIf(!existsSync(PYTHON))("textos bilíngues do processador Python", () => {
  it("aviso de needs_review chega com português e inglês", async () => {
    // 100×50 opaco num alvo 16×16: proporção diferente → centralizado, com aviso para revisar.
    const img = createImage(100, 50);
    fillRect(img, 0, 0, 100, 50, [9, 9, 9, 255]);
    const { workDir, sha256 } = await workWith(encodePng(img));
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: "job_1",
        attemptId: "att_1",
        operation: "fit_logical",
        inputs: [{ ordinal: 0, role: "source", sha256, relPath: "in/source.png" }],
        recipe: { version: 1, targetSize: [16, 16] },
      },
      { python: PYTHON, workDir },
    );
    expect(result.status).toBe("needs_review");
    if (result.status === "error") return;
    const aspect = result.warnings.find((w) => typeof w !== "string" && w["pt-BR"].startsWith("Proporção diferente"));
    expect(aspect).toEqual({
      "pt-BR": "Proporção diferente do tamanho lógico: 16×8 centralizado em 16×16",
      en: "Aspect ratio differs from the logical size: 16×8 centered in 16×16",
    });
  });

  it("erro do processador chega bilíngue e vira DomainFailure com os dois idiomas", async () => {
    const img = createImage(64, 48);
    fillRect(img, 0, 0, 64, 48, [1, 1, 1, 255]);
    const { workDir, sha256 } = await workWith(encodePng(img));
    const result = await runPython(
      {
        protocolVersion: 1,
        jobId: "job_1",
        attemptId: "att_1",
        operation: "fit_logical",
        inputs: [{ ordinal: 0, role: "source", sha256, relPath: "in/source.png" }],
        recipe: { version: 1, targetSize: [16, 16], exactAspect: true },
      },
      { python: PYTHON, workDir },
    );
    expect(result).toMatchObject({ status: "error", code: "geometry_mismatch" });
    if (result.status !== "error") return;
    expect(result.message).toEqual({
      "pt-BR": "Resposta fora da grade: candidato 64×48 não tem a proporção da fonte 16×16",
      en: "Response off the grid: candidate 64×48 does not have the source's 16×16 aspect ratio",
    });
    const failure = new DomainFailure("validation_failed", result.message);
    expect(failure.message).toMatch(/^Resposta fora da grade/);
    expect(failure.toJSON("en").message).toMatch(/^Response off the grid/);
  });

  it("o contrato ainda aceita avisos e erros em texto simples (legado)", () => {
    expect(PythonResponse.safeParse({ protocolVersion: 1, status: "needs_review", outputs: [], report: {}, warnings: ["aviso antigo"] }).success).toBe(true);
    expect(PythonResponse.safeParse({ protocolVersion: 1, status: "error", error: { code: "internal", message: "ValueError: x" } }).success).toBe(true);
    expect(PythonResponse.safeParse({ protocolVersion: 1, status: "error", error: { code: "internal", message: { "pt-BR": "só pt" } } }).success).toBe(false);
  });
});
