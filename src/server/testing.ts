import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalDigest } from "@/domain/canonical-json";
import type { GenerationPlan } from "@/contracts";
import { createAsset, createProject, getProject } from "./catalog/catalog";
import { loadConfig, REPO_ROOT, resolvePaths, type StudioConfig } from "./config";
import { migrate } from "./db/migrate";
import type { WorkerDeps } from "./jobs/context";
import { JobRunner } from "./jobs/runner";
import { ensureSimulatedProfile, ProviderRegistry, SIMULATED_PROFILE_ID } from "./providers/registry";
import { MemorySimulatedStore, SimulatedProvider } from "./providers/simulated";
import type { ProviderAdapter } from "./providers/types";
import { openStudio, type Studio } from "./studio";
import { ManualClock } from "./util";

/** Studio isolado em pasta temporária, com relógio manual e provedor simulado em memória. */
export interface TestStudio extends Studio {
  clock: ManualClock;
  simulatedStore: MemorySimulatedStore;
  simulated: SimulatedProvider;
  deps: WorkerDeps;
  depsFor(adapter?: ProviderAdapter): WorkerDeps;
  runner(workerId?: string, adapter?: ProviderAdapter): JobRunner;
  cleanup(): void;
}

export function makeTestStudio(opts: { delayMs?: number; idempotent?: boolean; config?: Partial<StudioConfig> } = {}): TestStudio {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pixel-studio-test-"));
  const base = loadConfig({ PIXEL_STUDIO_DATA_DIR: dir, NODE_ENV: "test", PIXEL_STUDIO_MIN_FREE_BYTES: "0" });
  const config: StudioConfig = {
    ...base,
    paths: resolvePaths(dir),
    python: path.join(REPO_ROOT, "python", ".venv", "bin", "python"),
    simulatedProvider: true,
    ...opts.config,
  };
  const clock = new ManualClock();
  const studio = openStudio({ config, clock, skipMigrationCheck: true, queue: { leaseMs: 30_000, backoffBaseMs: 1_000 } });
  migrate(studio.db);
  ensureSimulatedProfile(studio.db, clock, { delayMs: opts.delayMs ?? 0, idempotent: opts.idempotent ?? false });
  const simulatedStore = new MemorySimulatedStore();
  const simulated = new SimulatedProvider(simulatedStore, {
    delayMs: opts.delayMs ?? 0,
    idempotent: opts.idempotent ?? false,
    now: () => clock.now().getTime(),
  });
  const deps = (adapter: ProviderAdapter = simulated): WorkerDeps => ({
    db: studio.db,
    clock,
    queue: studio.queue,
    blobs: studio.blobs,
    config,
    providers: new ProviderRegistry(studio.db, config, new Map([[SIMULATED_PROFILE_ID, adapter]])),
    log: () => undefined,
  });
  return {
    ...studio,
    clock,
    simulatedStore,
    simulated,
    deps: deps(),
    depsFor: deps,
    runner: (workerId = "worker-test", adapter?: ProviderAdapter) => new JobRunner(deps(adapter), { workerId, heartbeatMs: 3_600_000 }),
    cleanup() {
      studio.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Projeto + asset de item + plano de geração de ícone por texto puro (perfil simulado). */
export function seedIconJob(studio: TestStudio, opts: { brief?: string; variants?: number; name?: string } = {}) {
  const project = createProject(studio.db, studio.clock, { name: "Clareira" });
  const asset = createAsset(studio.db, studio.clock, { projectId: project.id, family: "item", kind: "consumable", name: opts.name ?? "Poção verde" });
  const plan = iconPlan(studio, project.id, opts);
  return { project, asset, plan, request: { plan, planDigest: canonicalDigest(plan), targetAssetId: asset.id } };
}

export function iconPlan(studio: Studio, projectId: string, opts: { brief?: string; variants?: number } = {}): GenerationPlan {
  const project = getProject(studio.db, projectId);
  const variants = opts.variants ?? 1;
  const brief = opts.brief ?? "poção verde em frasco de vidro";
  return {
    planVersion: 1,
    projectId,
    operation: "generate_asset",
    styleRevisionId: project.activeStyleRevisionId!,
    recipeRevisionId: "builtin-item-icon-v1",
    providerProfileId: SIMULATED_PROFILE_ID,
    prompt: { brief, compiled: `Ícone de inventário: ${brief}`, language: "pt-BR" },
    sources: [],
    requiredCapabilities: ["text_to_image", "alpha_output"],
    parts: Array.from({ length: variants }, (_, i) => ({ partKey: `image:v${i + 1}`, unit: "image" as const, label: `Variante ${i + 1}` })),
    limits: { maxSubmissions: variants, costCeiling: null, estimate: { kind: "known", amount: { amount: variants, unit: "generations" }, basis: "simulado" } },
    params: { family: "item", kind: "consumable", logicalSize: [16, 16], transparent: true, variants },
  };
}
