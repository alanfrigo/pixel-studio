import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Capability, CostEstimate, PlanOperation } from "@/contracts";
import { sniff } from "../media/inspect";
import { DomainFailure } from "../errors";
import type { AdapterProfile } from "./adapters";
import { type GenericRoute, genericCanvas, genericCapabilities, genericLimits, genericSupports, genericWantsAlpha, genericWantsOpaque, ratio } from "./generic-route";
import { ProviderError, type ProviderAdapter, type ProviderImage, type ProviderResult, type ProviderSubmitRequest, type RemoteStatus, type SubmitOutcome } from "./types";

/**
 * Codex CLI local como provedor de imagem. Cada parte é um turno headless
 * (`codex exec`) em que o agente chama UMA vez a ferramenta de imagem embutida
 * (skill `imagegen`). O Studio não recebe chave nenhuma: vale o login feito
 * com `codex login` (plano do ChatGPT ou chave de API configurada no Codex).
 *
 * - Sandbox somente leitura e diretório de trabalho temporário: o agente não
 *   precisa (nem pode) gravar arquivos; as referências vão como anexos.
 * - A imagem é lida, byte a byte, da pasta que o Codex cria para a sessão
 *   (`$CODEX_HOME/generated_images/<thread_id>/`), identificada pelo evento
 *   `thread.started` da saída `--json`. Nada de "SAVED:" interpretado do texto.
 * - Síncrono e sem idempotência remota: um turno interrompido depois de começar
 *   pode ter consumido cota, então é tratado como envio incerto.
 */

export const CODEX_MIN_VERSION = "0.144.0";

/** Limite da ferramenta de imagem embutida: até 5 imagens de referência por pedido. */
const CODEX_MAX_REFERENCES = 5;

export const CodexCliConfig = z.strictObject({
  /** Executável (nome no PATH ou caminho absoluto); nunca passa por shell. */
  command: z
    .string()
    .regex(/^[\w./@+-]+$/, "Use o nome ou o caminho do executável, sem espaços nem argumentos")
    .default("codex"),
  /** Esforço do turno que conduz a ferramenta de imagem; o padrão do usuário pode ser alto e lento. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).default("low"),
  maxReferences: z.number().int().min(0).max(CODEX_MAX_REFERENCES).default(CODEX_MAX_REFERENCES),
  /** Pede fundo transparente quando o plano quer alfa; a ferramenta devolve PNG com alfa real. */
  transparent: z.boolean().default(true),
  /** Ignora `~/.codex/config.toml` (MCP, plugins, modelo padrão); o login continua valendo. */
  ignoreUserConfig: z.boolean().default(true),
  /** Mantém a cópia que o Codex grava em `generated_images/` (por padrão é apagada após a leitura). */
  keepCodexCopy: z.boolean().default(false),
  timeoutMs: z.number().int().min(30_000).max(1_800_000).default(600_000),
});
export type CodexCliConfig = z.infer<typeof CodexCliConfig>;

// ---------------------------------------------------------------------------
// Execução do processo (injetável nos testes)
// ---------------------------------------------------------------------------

export interface CodexRun {
  /** `null` quando o processo foi encerrado por sinal. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** O executável não foi encontrado (ENOENT). */
  missing: boolean;
}

export interface CodexRunOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

export type CodexSpawner = (command: string, args: string[], options: CodexRunOptions) => Promise<CodexRun>;

const STDOUT_LIMIT = 16 * 1024 * 1024;
const STDERR_TAIL = 64 * 1024;

/** Spawn sem shell, stdin fechado (senão o `codex exec` espera entrada) e grupo de processos próprio para encerrar a árvore inteira. */
export const spawnCodex: CodexSpawner = (command, args, { cwd, signal, timeoutMs, env }) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* já encerrado */
        }
      }, 5_000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = () => kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < STDOUT_LIMIT) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    const finish = (run: CodexRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(run);
    };
    child.on("error", (err: NodeJS.ErrnoException) => finish({ status: null, stdout, stderr: stderr + String(err.message), timedOut, missing: err.code === "ENOENT" }));
    child.on("close", (status) => finish({ status, stdout, stderr, timedOut, missing: false }));
  });

/** Só o necessário para o Codex achar o login, a rede e o PATH; segredos do Studio (ex.: OPENROUTER_API_KEY) não vão para o agente. */
export function codexEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|XDG_[A-Z_]+|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|ALL_PROXY|CODEX_[A-Z0-9_]+|SYSTEMROOT|APPDATA|LOCALAPPDATA|USERPROFILE)$/;
  return Object.fromEntries(Object.entries(source).filter(([k, v]) => keep.test(k) && v !== undefined)) as NodeJS.ProcessEnv;
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

// ---------------------------------------------------------------------------
// Instrução e argumentos (funções puras)
// ---------------------------------------------------------------------------

export interface CodexReference {
  path: string;
  role: string;
}

export interface CodexInstructionInput {
  prompt: string;
  references: CodexReference[];
  /** Proporção do canvas fixado pelo plano, ex.: "3:2"; `null` = livre. */
  aspect: string | null;
  background: "transparent" | "opaque" | null;
}

function orientation(aspect: string): string {
  const [w, h] = aspect.split(":").map(Number) as [number, number];
  if (w > h * 1.15) return "landscape";
  if (h > w * 1.15) return "portrait";
  return "square";
}

export function codexInstruction(input: CodexInstructionInput): string {
  const lines = [
    "Use the imagegen skill with its built-in image_gen tool only (never the CLI fallback, never an API key).",
    "",
    "Call image_gen exactly once to create one image from the specification below. Do not save, copy, move or post-process any file, do not make variants and do not retry. No shell commands are needed.",
  ];
  if (input.references.length) {
    lines.push("", "Reference images, attached to this turn in this order; pass these absolute paths to image_gen as reference images:");
    input.references.forEach((r, i) => lines.push(`${i + 1}. ${r.path} (role: ${r.role})`));
  }
  const requirements: string[] = [];
  if (input.aspect) requirements.push(`- Aspect ratio ${input.aspect} (${orientation(input.aspect)}); use the image_gen size closest to it.`);
  if (input.background === "transparent") requirements.push("- Background: transparent, with a real alpha channel (no painted checkerboard, no solid backdrop).");
  if (input.background === "opaque") requirements.push("- Background: opaque, painted edge to edge.");
  if (requirements.length) lines.push("", "Output requirements:", ...requirements);
  lines.push("", "After the image_gen call, reply with exactly: DONE", "", "Image specification:", input.prompt);
  return lines.join("\n");
}

export function codexArgs(input: { config: CodexCliConfig; model: string | null; workdir: string; references: string[]; instruction: string }): string[] {
  return [
    "exec",
    "--sandbox",
    "read-only",
    // Headless: sem pedido de aprovação mesmo se a configuração do usuário ligar o revisor automático.
    "-c",
    'approval_policy="never"',
    "-c",
    `model_reasoning_effort=${JSON.stringify(input.config.reasoningEffort)}`,
    "--skip-git-repo-check",
    "--ephemeral",
    ...(input.config.ignoreUserConfig ? ["--ignore-user-config"] : []),
    "--color",
    "never",
    "--json",
    "-C",
    input.workdir,
    ...(input.model ? ["-m", input.model] : []),
    ...input.references.flatMap((r) => ["--image", r]),
    "--",
    input.instruction,
  ];
}

// ---------------------------------------------------------------------------
// Leitura da saída `--json`
// ---------------------------------------------------------------------------

export interface CodexEvents {
  threadId: string | null;
  /** O turno passou da inicialização (a ferramenta pode ter rodado e consumido cota). */
  started: boolean;
  errors: string[];
  lastMessage: string | null;
  usage: Record<string, number> | null;
}

export function parseCodexEvents(stdout: string): CodexEvents {
  const out: CodexEvents = { threadId: null, started: false, errors: [], lastMessage: null, usage: null };
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: { type?: string; thread_id?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string }; usage?: Record<string, number> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "thread.started" && typeof e.thread_id === "string") out.threadId = e.thread_id;
    if (e.type?.startsWith("item.")) out.started = true;
    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string") out.lastMessage = e.item.text;
    if (e.type === "item.completed" && e.item?.type === "error" && typeof (e.item as { message?: string }).message === "string") out.errors.push((e.item as { message: string }).message);
    if (e.type === "error" && typeof e.message === "string") out.errors.push(e.message);
    if (e.type === "turn.failed") out.errors.push(e.error?.message ?? "turno falhou");
    if (e.type === "turn.completed" && e.usage) out.usage = e.usage;
  }
  return out;
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Imagens que o Codex gravou para a sessão, na ordem de criação. */
export function readGeneratedImages(home: string, threadId: string | null): { images: ProviderImage[]; dir: string | null } {
  if (!threadId || !THREAD_ID.test(threadId)) return { images: [], dir: null };
  const dir = path.join(home, "generated_images", threadId);
  if (!existsSync(dir)) return { images: [], dir: null };
  const files = readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile())
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  const images: ProviderImage[] = [];
  for (const file of files) {
    const bytes = new Uint8Array(readFileSync(file));
    const kind = sniff(bytes);
    if (kind?.modality === "raster") images.push({ bytes, mime: kind.mime });
  }
  return { images, dir };
}

const AUTH_PATTERN = /not logged in|codex login|unauthori[sz]ed|\b401\b|invalid api key|authentication/i;
const LIMIT_PATTERN = /usage limit|rate limit|\b429\b|too many requests|quota/i;
const MODEL_PATTERN = /\bmodel\b[^\n]{0,200}\b(not supported|unsupported|not available|does not exist|not found)\b|unknown model|reasoning effort/i;

function excerpt(text: string, max = 400): string {
  const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

/** Falha sem imagem → erro classificado para o worker (auth, cota, recusa, incerto). */
export function classifyCodexFailure(run: CodexRun, events: CodexEvents, timeoutMs: number): ProviderError {
  if (run.missing) return new ProviderError("not_accepted", "Codex CLI não encontrado: instale com `npm install -g @openai/codex` e rode `codex login`");
  const detail = excerpt([...events.errors, run.stderr].join("\n"));
  if (AUTH_PATTERN.test(detail)) return new ProviderError("auth", `Codex sem login válido: rode \`codex login\` na máquina do servidor (${excerpt(detail, 160)})`);
  if (LIMIT_PATTERN.test(detail)) return new ProviderError("rate_limited", `Limite de uso do Codex atingido: ${excerpt(detail, 200)}`);
  if (run.timedOut) {
    return events.started
      ? new ProviderError("ambiguous", `O turno do Codex passou de ${Math.round(timeoutMs / 1000)} s e foi encerrado; a geração pode ter consumido cota`)
      : new ProviderError("not_accepted", `O Codex não iniciou o turno em ${Math.round(timeoutMs / 1000)} s`);
  }
  if (!events.started) {
    if (MODEL_PATTERN.test(detail)) return new ProviderError("rejected", `O Codex recusou o modelo ou o esforço do perfil: ${excerpt(detail, 200)}`);
    return new ProviderError("not_accepted", `O Codex encerrou antes de começar o turno (código ${run.status ?? "sinal"}): ${detail || "sem mensagem"}`);
  }
  // Turno concluído sem imagem: recusa da ferramenta ou o agente não a chamou.
  return new ProviderError("rejected", `O Codex terminou sem gerar imagem${events.lastMessage ? `: ${excerpt(events.lastMessage, 300)}` : ""}${detail ? ` (${excerpt(detail, 200)})` : ""}`);
}

function extensionFor(mime: string): string {
  return mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
}

/** Procura o executável sem shell: caminho explícito ou entradas do PATH. */
export function findExecutable(command: string, envPath = process.env.PATH ?? ""): string | null {
  const executable = (file: string) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes("/") || command.includes("\\")) return executable(command) ? command : null;
  const suffixes = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const file = path.join(dir, command + suffix);
      if (executable(file)) return file;
    }
  }
  return null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---------------------------------------------------------------------------
// Adaptador
// ---------------------------------------------------------------------------

export interface CodexCliDeps {
  spawner?: CodexSpawner;
  env?: NodeJS.ProcessEnv;
  /** Diretório base dos temporários de trabalho (padrão: o temporário do sistema). */
  tmpDir?: string;
}

export class CodexCliAdapter implements ProviderAdapter {
  readonly transport = "codex_cli" as const;
  readonly idempotentSubmit = false;
  readonly pollIntervalMs = 0;
  private readonly config: CodexCliConfig;
  private readonly route: GenericRoute;
  private readonly spawner: CodexSpawner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly tmpDir: string;

  constructor(
    private readonly profile: AdapterProfile,
    config: unknown,
    deps: CodexCliDeps = {},
  ) {
    this.config = CodexCliConfig.parse(config ?? {});
    this.route = { maxReferences: this.config.maxReferences, transparent: this.config.transparent };
    this.spawner = deps.spawner ?? spawnCodex;
    this.env = deps.env ?? process.env;
    this.tmpDir = deps.tmpDir ?? os.tmpdir();
  }

  /** Checagem síncrona antes de planejar: o executável existe nesta máquina? (o login é conferido em "Testar sem custo"). */
  static assertInstalled(config: unknown, profileId: string, envPath = process.env.PATH ?? ""): void {
    const parsed = CodexCliConfig.safeParse(config ?? {});
    const command = parsed.success ? parsed.data.command : "codex";
    if (!findExecutable(command, envPath)) {
      throw new DomainFailure("capability_missing", `Codex CLI não encontrado (${command}): instale com \`npm install -g @openai/codex\` e rode \`codex login\``, { profileId });
    }
  }

  capabilities(operation: PlanOperation): Capability[] {
    return genericCapabilities(operation, this.route);
  }

  limits(operation: PlanOperation) {
    return genericLimits(operation, this.route);
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    return {
      kind: "known",
      amount: { amount: parts, unit: "generations" },
      basis: `${parts} turno(s) do Codex com uma imagem cada, descontado(s) da cota do plano (com login por chave de API, cobrado na conta da API)`,
    };
  }

  async submit(req: ProviderSubmitRequest, signal: AbortSignal): Promise<SubmitOutcome> {
    if (!genericSupports(req.operation)) throw new ProviderError("rejected", `Operação ${req.operation} não suportada pelo Codex CLI`);
    if (req.references.length > this.config.maxReferences) {
      throw new ProviderError("rejected", `O perfil aceita até ${this.config.maxReferences} referências; o pedido tem ${req.references.length}`);
    }
    for (const ref of req.references) {
      if (sniff(ref.bytes)?.modality !== "raster") throw new ProviderError("rejected", `Referência ${ref.role} não é imagem; o Codex só recebe imagens anexadas`);
    }

    mkdirSync(this.tmpDir, { recursive: true });
    const workdir = mkdtempSync(path.join(this.tmpDir, "pixel-studio-codex-"));
    const home = codexHome(this.env);
    let generatedDir: string | null = null;
    try {
      const refs = req.references.map((ref, i) => {
        const file = path.join(workdir, `ref-${String(i + 1).padStart(2, "0")}-${ref.role.replace(/[^\w-]/g, "_")}.${extensionFor(ref.mime)}`);
        writeFileSync(file, ref.bytes);
        return { path: file, role: ref.role };
      });
      const alpha = genericWantsAlpha(req, this.route);
      const canvas = genericCanvas(req);
      const instruction = codexInstruction({
        prompt: req.prompt,
        references: refs,
        aspect: canvas ? ratio(canvas) : null,
        background: alpha ? "transparent" : genericWantsOpaque(req, alpha, this.route) ? "opaque" : null,
      });
      const args = codexArgs({ config: this.config, model: this.profile.model, workdir, references: refs.map((r) => r.path), instruction });
      const run = await this.spawner(this.config.command, args, { cwd: workdir, signal, timeoutMs: this.config.timeoutMs, env: codexEnv(this.env) });
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new ProviderError("ambiguous", "Turno do Codex interrompido");
      const events = parseCodexEvents(run.stdout);
      const generated = readGeneratedImages(home, events.threadId);
      generatedDir = generated.dir;
      // A imagem gravada vale mesmo se o processo saiu com erro depois (ex.: tempo esgotado na resposta final).
      if (generated.images.length > 0) return { kind: "sync", images: generated.images, cost: { amount: generated.images.length, unit: "generations" } };
      throw classifyCodexFailure(run, events, this.config.timeoutMs);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      if (generatedDir && !this.config.keepCodexCopy) rmSync(generatedDir, { recursive: true, force: true });
    }
  }

  poll(): Promise<RemoteStatus> {
    return Promise.reject(new ProviderError("rejected", "O Codex CLI responde de forma síncrona; não há job remoto a consultar"));
  }

  fetchResult(): Promise<ProviderResult> {
    return Promise.reject(new ProviderError("rejected", "O Codex CLI responde de forma síncrona; não há job remoto a consultar"));
  }

  /** Verificação gratuita: versão, login e skill `imagegen` (nenhum turno é iniciado). */
  async check(signal: AbortSignal): Promise<{ ok: boolean; message: string; details?: unknown }> {
    const run = (args: string[]) => this.spawner(this.config.command, args, { cwd: this.tmpDir, signal, timeoutMs: 30_000, env: codexEnv(this.env) });
    const version = await run(["--version"]);
    if (version.missing) return { ok: false, message: `Codex CLI não encontrado (${this.config.command}): instale com \`npm install -g @openai/codex\`` };
    const found = /(\d+\.\d+\.\d+)/.exec(version.stdout + version.stderr)?.[1] ?? null;
    if (!found || compareVersions(found, CODEX_MIN_VERSION) < 0) {
      return { ok: false, message: `Codex CLI ${found ?? "de versão desconhecida"}: atualize para ${CODEX_MIN_VERSION} ou mais nova (ferramenta de imagem embutida)` };
    }
    const login = await run(["login", "status"]);
    const loginText = excerpt(`${login.stdout}\n${login.stderr}`, 120);
    const loggedIn = login.status === 0 && /logged in/i.test(loginText);
    const skill = existsSync(path.join(codexHome(this.env), "skills", ".system", "imagegen", "SKILL.md"));
    const details = { version: found, login: loginText, imagegenSkill: skill };
    if (!loggedIn) return { ok: false, message: `Codex ${found} sem login: rode \`codex login\` (${loginText || "sem resposta"})`, details };
    if (!skill) return { ok: false, message: `Codex ${found}: skill imagegen não encontrada em ${codexHome(this.env)}; atualize o Codex CLI`, details };
    return { ok: true, message: `Codex ${found} · ${loginText} · skill imagegen presente`, details };
  }
}
