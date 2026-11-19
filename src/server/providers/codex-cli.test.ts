import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { canonicalDigest } from "@/domain/canonical-json";
import { createImage, encodePng, fillRect } from "@/lib/media/png";
import { listRevisions } from "../catalog/catalog";
import { iconPlan, makeTestStudio, seedIconJob, type TestStudio } from "../testing";
import {
  classifyCodexFailure,
  CodexCliAdapter,
  codexArgs,
  CodexCliConfig,
  codexEnv,
  codexInstruction,
  type CodexRun,
  type CodexSpawner,
  findExecutable,
  parseCodexEvents,
  spawnCodex,
} from "./codex-cli";
import type { ProviderSubmitRequest } from "./types";

/**
 * Codex CLI sem custo: um executável falso imita `codex exec --json` (eventos
 * reais do 0.169: thread.started → item.* → turn.completed) e grava a imagem em
 * `$CODEX_HOME/generated_images/<thread_id>/`, como a ferramenta embutida faz.
 */

const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const args = process.argv.slice(2);
const mode = process.env.CODEX_FAKE_MODE || "ok";
if (args[0] === "--version") { console.log("codex-cli 0.169.0"); process.exit(0); }
if (args[0] === "login") {
  if (mode === "logged_out") { console.error("Not logged in"); process.exit(1); }
  console.log("Logged in using ChatGPT"); process.exit(0);
}
// stdin precisa vir fechado: com um pipe aberto, o codex real fica em "Reading additional input from stdin..."
const stdin = fs.readFileSync(0, "utf8");
const images = []; for (let i = 0; i < args.length; i++) if (args[i] === "--image") images.push(args[i + 1]);
fs.appendFileSync(process.env.CODEX_FAKE_LOG, JSON.stringify({ args, stdin, images: images.map((f) => fs.existsSync(f)), leaked: Object.keys(process.env).filter((k) => /PROVIDER_KEY|OPENROUTER/.test(k)) }) + "\\n");
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
const thread = crypto.randomUUID();
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
if (mode === "hang") { out({ type: "item.started", item: { id: "item_0", type: "command_execution", command: "x" } }); setTimeout(() => {}, 60000); return; }
if (mode === "usage_limit") { out({ type: "error", message: "You've hit your usage limit. Try again later." }); out({ type: "turn.failed", error: { message: "usage limit" } }); process.exit(1); }
if (mode === "refused") { out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "I can't create that image." } }); out({ type: "turn.completed", usage: { input_tokens: 10 } }); process.exit(0); }
const dir = path.join(process.env.CODEX_HOME, "generated_images", thread);
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(process.env.CODEX_FAKE_PNG, path.join(dir, "exec-1.png"));
out({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "DONE" } });
out({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 5 } });
`;

let root: string;
let fake: string;
let log: string;
let home: string;
const saved: Record<string, string | undefined> = {};

function icon(color: [number, number, number, number] = [60, 200, 90, 255], size = 16): Uint8Array {
  const img = createImage(size, size);
  fillRect(img, 4, 4, size - 8, size - 8, color);
  return encodePng(img);
}

function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "codex-cli-test-"));
  fake = path.join(root, "bin", "codex");
  mkdirSync(path.dirname(fake), { recursive: true });
  writeFileSync(fake, FAKE_CODEX);
  chmodSync(fake, 0o755);
  log = path.join(root, "calls.jsonl");
  home = path.join(root, "codex-home");
  const png = path.join(root, "result.png");
  writeFileSync(png, icon([200, 40, 40, 255]));
  setEnv({ CODEX_HOME: home, CODEX_FAKE_LOG: log, CODEX_FAKE_PNG: png, CODEX_FAKE_MODE: "ok", TEST_PROVIDER_KEY: "chave-de-teste" });
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});
afterEach(() => {
  process.env.CODEX_FAKE_MODE = "ok";
  rmSync(log, { force: true });
});

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string; images: boolean[]; leaked: string[] }) : []);
const profile = (model: string | null = null) => ({ id: "codex", baseUrl: "", secretRef: null, model });
const signal = () => new AbortController().signal;

const request = (overrides: Partial<ProviderSubmitRequest> = {}): ProviderSubmitRequest => ({
  idempotencyKey: "job_1:image:v1",
  operation: "generate_asset",
  prompt: "poção verde em pixel art",
  params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants: 1 },
  references: [],
  ...overrides,
});

describe("instrução e argumentos do Codex", () => {
  it("turno headless somente leitura, sem aprovação, efêmero, com esforço baixo e anexos na ordem", () => {
    const config = CodexCliConfig.parse({});
    const args = codexArgs({ config, model: "gpt-x", workdir: "/tmp/w", references: ["/tmp/w/a.png", "/tmp/w/b.png"], instruction: "faça" });
    expect(args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('model_reasoning_effort="low"');
    for (const flag of ["--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--json"]) expect(args).toContain(flag);
    expect(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2)).toEqual(["-m", "gpt-x"]);
    expect(args.filter((_, i) => args[i - 1] === "--image")).toEqual(["/tmp/w/a.png", "/tmp/w/b.png"]);
    // O prompt vem depois de "--": um prompt que começa com "-" nunca vira flag.
    expect(args.slice(-2)).toEqual(["--", "faça"]);
    expect(codexArgs({ config: CodexCliConfig.parse({ ignoreUserConfig: false }), model: null, workdir: "/w", references: [], instruction: "x" })).not.toContain("--ignore-user-config");
  });

  it("a instrução pede uma chamada da ferramenta, sem pós-processamento, com papéis, proporção e fundo", () => {
    const text = codexInstruction({ prompt: "folha de 4 quadros", references: [{ path: "/w/ref-01-base.png", role: "base" }], aspect: "4:1", background: "transparent" });
    expect(text).toMatch(/image_gen exactly once/);
    expect(text).toMatch(/Do not save, copy, move or post-process/);
    expect(text).toContain("1. /w/ref-01-base.png (role: base)");
    expect(text).toContain("Aspect ratio 4:1 (landscape)");
    expect(text).toMatch(/transparent, with a real alpha channel/);
    expect(text.endsWith("Image specification:\nfolha de 4 quadros")).toBe(true);
    expect(codexInstruction({ prompt: "x", references: [], aspect: null, background: null })).not.toMatch(/Reference images|Output requirements/);
  });

  it("lê thread, início do turno, erros e última mensagem da saída --json", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"01a1f350-c727-7281-9757-dea3cdb8c0fe"}',
      '{"type":"turn.started"}',
      "lixo que não é JSON",
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"DONE"}}',
      '{"type":"turn.completed","usage":{"input_tokens":88348,"output_tokens":435}}',
    ].join("\n");
    expect(parseCodexEvents(stdout)).toEqual({
      threadId: "01a1f350-c727-7281-9757-dea3cdb8c0fe",
      started: true,
      errors: [],
      lastMessage: "DONE",
      usage: { input_tokens: 88348, output_tokens: 435 },
    });
  });

  it("segredos do Studio não vão para o processo do Codex", () => {
    const env = codexEnv({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/c", OPENROUTER_API_KEY: "x", TEST_PROVIDER_KEY: "y", HTTPS_PROXY: "p" } as unknown as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/c", HTTPS_PROXY: "p" });
  });

  it("classifica falhas: sem login, limite de uso, recusa, tempo esgotado e executável ausente", () => {
    const run = (r: Partial<CodexRun>): CodexRun => ({ status: 1, stdout: "", stderr: "", timedOut: false, missing: false, ...r });
    const none = parseCodexEvents("");
    const started = { ...none, started: true };
    expect(classifyCodexFailure(run({ stderr: "Error: Not logged in" }), none, 1000).kind).toBe("auth");
    expect(classifyCodexFailure(run({}), { ...started, errors: ["You've hit your usage limit"] }, 1000).kind).toBe("rate_limited");
    expect(classifyCodexFailure(run({ status: 0 }), { ...started, lastMessage: "I can't create that image." }, 1000)).toMatchObject({ kind: "rejected", message: expect.stringMatching(/can't create/) });
    expect(classifyCodexFailure(run({ timedOut: true, status: null }), started, 600_000)).toMatchObject({ kind: "ambiguous", message: expect.stringMatching(/600 s/) });
    expect(classifyCodexFailure(run({ timedOut: true, status: null }), none, 600_000).kind).toBe("not_accepted");
    expect(classifyCodexFailure(run({ stderr: "The 'gpt-z' model is not supported when using Codex with a ChatGPT account." }), none, 1000).kind).toBe("rejected");
    expect(classifyCodexFailure(run({ missing: true }), none, 1000)).toMatchObject({ kind: "not_accepted", message: expect.stringMatching(/npm install -g @openai\/codex/) });
  });
});

describe("adaptador Codex CLI", () => {
  it("declara a rota genérica: texto, até 5 referências, alfa e edição por candidata; custo em gerações da cota", () => {
    const adapter = new CodexCliAdapter(profile(), {});
    expect(adapter.capabilities("generate_asset")).toEqual(["text_to_image", "image_references", "alpha_output"]);
    expect(adapter.capabilities("inpaint")).toEqual(["image_edit"]);
    expect(adapter.capabilities("animate_preset")).toEqual(["text_to_image", "image_references"]);
    expect(adapter.limits("generate_asset")).toEqual({ maxReferences: 5 });
    expect(new CodexCliAdapter(profile(), { transparent: false }).capabilities("generate_asset")).toEqual(["text_to_image", "image_references"]);
    expect(adapter.estimate("generate_asset", 3)).toMatchObject({ kind: "known", amount: { amount: 3, unit: "generations" } });
    expect(() => new CodexCliAdapter(profile(), { maxReferences: 6 })).toThrow();
    expect(() => new CodexCliAdapter(profile(), { command: "codex --dangerously-bypass-approvals-and-sandbox" })).toThrow();
  });

  it("gera pelo executável real: stdin fechado, anexos gravados, imagem lida da pasta da sessão e temporários apagados", async () => {
    const tmpDir = path.join(root, "work");
    const adapter = new CodexCliAdapter(profile("gpt-x"), { command: fake }, { tmpDir });
    const out = await adapter.submit(request({ references: [{ role: "style", mime: "image/png", bytes: icon() }] }), signal());
    expect(out).toMatchObject({ kind: "sync", cost: { amount: 1, unit: "generations" } });
    if (out.kind !== "sync") throw new Error("esperado síncrono");
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mime).toBe("image/png");
    expect(Buffer.from(out.images[0]!.bytes).equals(readFileSync(process.env.CODEX_FAKE_PNG!))).toBe(true);
    const [call] = calls();
    expect(call!.stdin).toBe("");
    expect(call!.images).toEqual([true]); // a referência existia no disco durante o turno
    expect(call!.leaked).toEqual([]);
    expect(call!.args.at(-1)).toMatch(/Background: transparent/);
    expect(readdirSync(tmpDir)).toEqual([]); // diretório de trabalho removido
    expect(readdirSync(path.join(home, "generated_images"))).toEqual([]); // cópia do Codex removida
  });

  it("mantém a cópia do Codex quando configurado", async () => {
    const adapter = new CodexCliAdapter(profile(), { command: fake, keepCodexCopy: true }, { tmpDir: path.join(root, "work") });
    await adapter.submit(request(), signal());
    expect(readdirSync(path.join(home, "generated_images"))).toHaveLength(1);
    rmSync(path.join(home, "generated_images"), { recursive: true, force: true });
  });

  it("limite de uso e recusa viram erros classificados; referência que não é imagem nem chega ao Codex", async () => {
    const adapter = new CodexCliAdapter(profile(), { command: fake }, { tmpDir: path.join(root, "work") });
    process.env.CODEX_FAKE_MODE = "usage_limit";
    expect((await adapter.submit(request(), signal()).catch((e) => e)).kind).toBe("rate_limited");
    process.env.CODEX_FAKE_MODE = "refused";
    expect(await adapter.submit(request(), signal()).catch((e) => e)).toMatchObject({ kind: "rejected", message: expect.stringMatching(/can't create/) });
    rmSync(log, { force: true });
    const json = new TextEncoder().encode('{"motion":true}');
    expect((await adapter.submit(request({ references: [{ role: "motion", mime: "application/json", bytes: json }] }), signal()).catch((e) => e)).kind).toBe("rejected");
    const six = Array.from({ length: 6 }, () => ({ role: "style", mime: "image/png", bytes: icon() }));
    expect((await adapter.submit(request({ references: six }), signal()).catch((e) => e)).message).toMatch(/até 5 referências/);
    expect(calls()).toHaveLength(0);
  });

  it("tempo esgotado depois do início é envio incerto; cancelamento encerra o processo", async () => {
    process.env.CODEX_FAKE_MODE = "hang";
    const slow = new CodexCliAdapter(profile(), { command: fake, timeoutMs: 30_000 }, { tmpDir: path.join(root, "work") });
    // Prazo curto injetado pelo spawner (o mínimo da configuração é 30 s).
    const fast: CodexSpawner = (cmd, args, o) => spawnCodex(cmd, args, { ...o, timeoutMs: 400 });
    const timed = new CodexCliAdapter(profile(), { command: fake }, { tmpDir: path.join(root, "work"), spawner: fast });
    expect((await timed.submit(request(), signal()).catch((e) => e)).kind).toBe("ambiguous");
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(new Error("cancelado pelo operador")), 300);
    await expect(slow.submit(request(), controller.signal)).rejects.toThrow(/cancelado pelo operador/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("verificação sem custo: versão, login e skill; executável ausente é apontado", async () => {
    mkdirSync(path.join(home, "skills", ".system", "imagegen"), { recursive: true });
    writeFileSync(path.join(home, "skills", ".system", "imagegen", "SKILL.md"), "---\nname: imagegen\n---\n");
    const adapter = new CodexCliAdapter(profile(), { command: fake });
    expect(await adapter.check(signal())).toMatchObject({ ok: true, message: expect.stringMatching(/Codex 0\.169\.0 · Logged in using ChatGPT · skill imagegen presente/) });
    process.env.CODEX_FAKE_MODE = "logged_out";
    expect(await adapter.check(signal())).toMatchObject({ ok: false, message: expect.stringMatching(/sem login/) });
    expect(await new CodexCliAdapter(profile(), { command: path.join(root, "nao-existe") }).check(signal())).toMatchObject({ ok: false, message: expect.stringMatching(/não encontrado/) });
    expect(calls()).toHaveLength(0); // nenhuma checagem iniciou turno
    expect(findExecutable("codex", path.dirname(fake))).toBe(fake);
    expect(() => CodexCliAdapter.assertInstalled({ command: "nao-existe-codex" }, "codex", path.dirname(fake))).toThrow(/Codex CLI não encontrado/);
  });
});

describe.skipIf(!existsSync(`${process.cwd()}/python/.venv/bin/python`))("cadastro e geração pelo worker com o Codex CLI", () => {
  let studio: TestStudio;
  afterEach(() => studio?.cleanup());

  it("perfil sem URL nem segredo; ProfileInput recusa segredo no perfil do Codex e ID reservado", async () => {
    const { saveProfile, capabilityMatrix, ProfileInput } = await import("./profiles");
    studio = makeTestStudio();
    const saved = saveProfile(studio.db, studio.clock, { id: "codex", name: "Codex", transport: "codex_cli", config: { command: fake } });
    expect(saved).toMatchObject({ transport: "codex_cli", secretRef: null, baseUrl: null, model: null, simulated: false });
    const matrix = capabilityMatrix(studio.db, "codex");
    expect(matrix.filter((m) => m.operation === "generate_asset").map((m) => m.capability).sort()).toEqual(["alpha_output", "image_references", "text_to_image"]);
    expect(matrix.find((m) => m.capability === "image_references")?.limits).toEqual({ maxReferences: 5 });
    expect(matrix.every((m) => m.status === "declared" && m.contractSnapshot?.includes("Codex CLI"))).toBe(true);
    expect(ProfileInput.safeParse({ id: "x", name: "X", transport: "codex_cli", secretRef: "OPENAI_API_KEY", config: {} }).success).toBe(false);
    expect(ProfileInput.safeParse({ id: "simulated", name: "X", transport: "codex_cli", config: {} }).success).toBe(false);
    expect(ProfileInput.safeParse({ id: "x", name: "X", transport: "codex_cli", model: "gpt-x", config: {} }).success).toBe(true);
  });

  it("um job de ícone vira revisão com custo em gerações, sem chave no ambiente do Codex", async () => {
    const { saveProfile } = await import("./profiles");
    const { ProviderRegistry } = await import("./registry");
    const { JobRunner } = await import("../jobs/runner");
    studio = makeTestStudio();
    saveProfile(studio.db, studio.clock, { id: "codex", name: "Codex", transport: "codex_cli", config: { command: fake } });
    const seeded = seedIconJob(studio, { variants: 1 });
    const plan = { ...iconPlan(studio, seeded.project.id, { variants: 1 }), providerProfileId: "codex", parts: [{ partKey: "image:v1", unit: "image" as const, label: "Envio 1" }] };
    const job = studio.queue.enqueue({ projectId: seeded.project.id, kind: "generation", request: { plan, planDigest: canonicalDigest(plan), targetAssetId: seeded.asset.id }, idempotencyKey: "k" }).job;
    await new JobRunner({ ...studio.deps, providers: new ProviderRegistry(studio.db, studio.config) }, { workerId: "w", heartbeatMs: 60_000 }).runOnce();
    const final = studio.queue.get(job.id)!;
    expect(final.state, final.error_json ?? "").toBe("succeeded");
    expect(listRevisions(studio.db, seeded.project.id, seeded.asset.id)).toHaveLength(1);
    expect(JSON.parse(final.result_json!).cost).toEqual([{ unit: "generations", amount: 1 }]);
    const [call] = calls();
    expect(call!.leaked).toEqual([]);
    expect(call!.args.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
  });
});
