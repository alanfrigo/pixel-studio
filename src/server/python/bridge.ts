import { type LocalizedText, type TextValue, tx } from "@/i18n/locales";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { PythonRequest, PythonResponse, relativePathProblem } from "@/contracts";
import { readPngInfo } from "@/lib/media/png";
import { DomainFailure } from "../errors";

/**
 * Ponte Node → Python (05 §entrada e saída). Um subprocesso por tarefa com
 * argumentos fixos, JSON por stdin/stdout e cwd na pasta da tentativa. Node
 * revalida a resposta: schema, caminhos dentro da pasta, hash e dimensões.
 */

export interface PythonRunOptions {
  python: string;
  /** Pasta exclusiva da tentativa; entradas já copiadas para dentro dela. */
  workDir: string;
  timeoutMs?: number;
  maxMemoryMb?: number;
  signal?: AbortSignal;
}

export interface VerifiedOutput {
  role: string;
  key?: string;
  absolutePath: string;
  relPath: string;
  mime: string;
  width?: number;
  height?: number;
  sha256: string;
  rgbaSha256?: string;
}

export type PythonResult =
  | { status: "ok" | "needs_review"; outputs: VerifiedOutput[]; report: Record<string, unknown>; warnings: (string | LocalizedText)[] }
  | { status: "error"; code: string; message: string | LocalizedText };

const MAX_STDOUT = 4 * 1024 * 1024;

export async function runPython(request: PythonRequest, opts: PythonRunOptions): Promise<PythonResult> {
  const parsedRequest = PythonRequest.parse(request);
  const { stdout, stderr, code, timedOut } = await spawnPython(opts, JSON.stringify(parsedRequest));
  if (timedOut) throw new DomainFailure("internal", tx("Processamento local excedeu o tempo limite", "Local processing exceeded the time limit"), { stderr: tail(stderr) });
  if (code !== 0) throw new DomainFailure("internal", tx(`Processador Python terminou com código ${code}`, `Python processor exited with code ${code}`), { stderr: tail(stderr) });

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new DomainFailure("internal", tx("Resposta do processador Python não é JSON", "Python processor response is not JSON"), { stdout: tail(stdout), stderr: tail(stderr) });
  }
  const parsed = PythonResponse.safeParse(json);
  if (!parsed.success) {
    throw new DomainFailure("internal", tx("Resposta do processador Python fora do contrato", "Python processor response is outside the contract"), { issues: parsed.error.issues.slice(0, 5) });
  }
  const response = parsed.data;
  if (response.status === "error") return { status: "error", code: response.error.code, message: response.error.message };

  const root = await realpath(opts.workDir);
  const outputs: VerifiedOutput[] = [];
  for (const out of response.outputs) {
    const problem = relativePathProblem(out.relPath);
    if (problem) throw new DomainFailure("internal", tx(`Saída com caminho inválido: ${problem}`, `Output with an invalid path: ${problem}`));
    const absolute = await realpath(path.join(root, out.relPath)).catch(() => null);
    if (!absolute || !absolute.startsWith(root + path.sep)) {
      throw new DomainFailure("internal", tx(`Saída fora da pasta da tentativa: ${out.relPath}`, `Output outside the attempt folder: ${out.relPath}`));
    }
    const bytes = await readFile(absolute);
    if (createHash("sha256").update(bytes).digest("hex") !== out.sha256) {
      throw new DomainFailure("internal", tx(`Hash da saída ${out.relPath} diverge do relatório`, `Hash of output ${out.relPath} does not match the report`));
    }
    if (out.mime === "image/png") {
      const info = readPngInfo(bytes);
      if (!info || info.width !== out.width || info.height !== out.height) {
        throw new DomainFailure("internal", tx(`Dimensões da saída ${out.relPath} divergem do relatório`, `Dimensions of output ${out.relPath} do not match the report`));
      }
    }
    outputs.push({ ...out, absolutePath: absolute });
  }
  return {
    status: response.status,
    outputs,
    report: response.report,
    warnings: response.status === "needs_review" ? response.warnings : [],
  };
}

function spawnPython(opts: PythonRunOptions, input: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve, reject) => {
    const child = spawn(opts.python, ["-I", "-m", "pixel_pipeline"], {
      cwd: opts.workDir,
      // Ambiente mínimo: o processador nunca herda segredos de provedores do servidor.
      env: {
        PATH: process.env.PATH ?? "",
        PIXEL_PIPELINE_MAX_MEMORY_MB: String(opts.maxMemoryMb ?? 1024),
        PIXEL_PIPELINE_MAX_CPU_SECONDS: String(Math.ceil((opts.timeoutMs ?? 60_000) / 1000)),
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 60_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_STDOUT) kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-64 * 1024);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new DomainFailure("internal", tx(`Não foi possível iniciar o Python (${opts.python})`, `Could not start Python (${opts.python})`), { cause: err.message }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", kill);
      resolve({ stdout, stderr, code, timedOut });
    });
    child.stdin.end(input);
  });
}

function tail(text: string): string {
  return text.slice(-2000);
}

export interface PythonInfo {
  ok: boolean;
  protocolVersion?: number;
  pipeline?: string;
  pillow?: string;
  python?: string;
  /** Bilíngue quando a mensagem é nossa; a última linha do stderr fica como veio. */
  error?: TextValue;
}

/** Diagnóstico de inicialização: o interpretador existe e fala o protocolo esperado? */
export async function pythonInfo(python: string): Promise<PythonInfo> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-I", "-m", "pixel_pipeline", "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: tx(`Python não encontrado em ${python}: ${e.message}. Rode npm run python:setup`, `Python not found at ${python}: ${e.message}. Run npm run python:setup`) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: err.trim().split("\n").pop() ?? tx(`código ${code}`, `code ${code}`) });
      try {
        const info = JSON.parse(out) as Omit<PythonInfo, "ok">;
        resolve({ ok: info.protocolVersion === 1, ...info, ...(info.protocolVersion === 1 ? {} : { error: tx("Versão de protocolo incompatível", "Incompatible protocol version") }) });
      } catch {
        resolve({ ok: false, error: tx("Resposta de versão ilegível", "Unreadable version response") });
      }
    });
  });
}
