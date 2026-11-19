import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Capability, CostEstimate, JointPose, MotionPayload, Skeleton } from "@/contracts";
import { drawPose } from "@/domain/animation/pose-guide";
import { createImage, encodePng, readPngInfo, type RgbaImage, setPixel } from "@/lib/media/png";
import type { PlanOperation } from "@/contracts";
import { ProviderError, type ProviderAdapter, type ProviderResult, type ProviderSubmitRequest, type RemoteStatus, type SubmitOutcome } from "./types";
import { genericWorldCapabilities, isWorldOperation } from "../world/provider-caps";
import { type SimulatedWorldJob, simulatedWorldImage, simulatedWorldJob } from "../world/simulated-art";

/**
 * Provedor SIMULADO para desenvolvimento e testes (08 §pronto para entregar:
 * "CI usa fixtures e respostas simuladas"). Identificado como tal na
 * interface; nunca substitui silenciosamente um provedor real.
 *
 * O "servidor remoto" guarda seus jobs num armazenamento separado do worker,
 * então reiniciar o worker não perde o job remoto — exatamente o cenário de
 * retomada por consulta.
 */

export interface SimulatedRemoteJob {
  id: string;
  idempotencyKey: string;
  prompt: string;
  size: [number, number];
  createdAt: number;
  readyAt: number;
  cancelled: boolean;
  /** Animação simulada (S1): quantos quadros devolver e, no esqueleto, as poses recebidas como dados. */
  animation?: { frames: number; skeleton?: Skeleton; poses?: Record<string, JointPose>[] };
  /** Mundo simulado (T1): material repetível ou eco do gabarito do tileset. */
  world?: SimulatedWorldJob;
}

export interface SimulatedState {
  jobs: Record<string, SimulatedRemoteJob>;
  /** Chamadas de submissão recebidas (inclusive deduplicadas pela chave). */
  submissions: number;
  /** Jobs remotos efetivamente criados (= gerações cobradas). */
  charged: number;
}

export interface SimulatedStore {
  read(): SimulatedState;
  write(state: SimulatedState): void;
}

export class MemorySimulatedStore implements SimulatedStore {
  private state: SimulatedState = { jobs: {}, submissions: 0, charged: 0 };
  read() {
    return structuredClone(this.state);
  }
  write(state: SimulatedState) {
    this.state = structuredClone(state);
  }
}

export class FileSimulatedStore implements SimulatedStore {
  constructor(private readonly file: string) {}
  read(): SimulatedState {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as SimulatedState;
    } catch {
      return { jobs: {}, submissions: 0, charged: 0 };
    }
  }
  write(state: SimulatedState) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.file);
  }
}

export interface SimulatedOptions {
  /** Tempo de "processamento remoto". */
  delayMs: number;
  /** Deduplica pela chave de idempotência (como um provedor que documenta essa garantia). */
  idempotent: boolean;
  now?: () => number;
  /** Injeção de falhas para ensaio: lança depois de aceitar (resposta perdida). */
  failAfterAccept?: boolean;
}

export const SIMULATED_CAPABILITIES: Capability[] = ["text_to_image", "alpha_output", "seed"];

export class SimulatedProvider implements ProviderAdapter {
  readonly transport = "simulated" as const;
  readonly pollIntervalMs: number;
  readonly idempotentSubmit: boolean;
  private readonly now: () => number;

  constructor(
    private readonly store: SimulatedStore,
    private readonly options: SimulatedOptions,
  ) {
    this.idempotentSubmit = options.idempotent;
    this.pollIntervalMs = Math.max(20, Math.min(500, Math.floor(options.delayMs / 4)));
    this.now = options.now ?? Date.now;
  }

  capabilities(operation: PlanOperation): Capability[] {
    // Inpainting simulado: a "resposta" redesenha o canvas inteiro, o que ensaia a proteção local.
    if (operation === "inpaint") return ["image_edit", "native_mask"];
    if (SIMULATED_ANIMATION_OPS.includes(operation)) return SIMULATED_ANIMATION_CAPABILITIES;
    if (isWorldOperation(operation)) return genericWorldCapabilities(operation, 16);
    return operation === "generate_asset" ? SIMULATED_CAPABILITIES : [];
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    return { kind: "known", amount: { amount: parts, unit: "generations" }, basis: `${parts} geração(ões) simulada(s), 1 por imagem` };
  }

  async submit(request: ProviderSubmitRequest): Promise<SubmitOutcome> {
    const state = this.store.read();
    state.submissions += 1;
    if (this.idempotentSubmit) {
      const existing = Object.values(state.jobs).find((j) => j.idempotencyKey === request.idempotencyKey);
      if (existing) {
        this.store.write(state);
        return { kind: "async", remoteId: existing.id };
      }
    }
    const animation = simulatedAnimation(request);
    const size = (request.params.logicalSize as [number, number] | undefined) ?? animation?.size ?? [16, 16];
    const id = `sim_${randomUUID().slice(0, 8)}`;
    const now = this.now();
    state.jobs[id] = { id, idempotencyKey: request.idempotencyKey, prompt: request.prompt, size, createdAt: now, readyAt: now + this.options.delayMs, cancelled: false };
    if (animation?.job) state.jobs[id].animation = animation.job;
    const world = simulatedWorldJob(request);
    if (world) state.jobs[id].world = world;
    state.charged += 1;
    this.store.write(state);
    if (this.options.failAfterAccept) throw new ProviderError("ambiguous", "Conexão perdida depois do envio (simulado)");
    return { kind: "async", remoteId: id };
  }

  async poll(remoteId: string): Promise<RemoteStatus> {
    const job = this.store.read().jobs[remoteId];
    if (!job) return { state: "failed", message: `Job remoto ${remoteId} desconhecido` };
    if (job.cancelled) return { state: "failed", message: "Cancelado no provedor" };
    const now = this.now();
    if (now >= job.readyAt) return { state: "succeeded" };
    return { state: "pending", progress: (now - job.createdAt) / Math.max(1, job.readyAt - job.createdAt) };
  }

  async fetchResult(remoteId: string): Promise<ProviderResult> {
    const job = this.store.read().jobs[remoteId];
    if (!job) throw new ProviderError("rejected", `Job remoto ${remoteId} desconhecido`);
    if (job.animation) {
      const { frames, skeleton, poses } = job.animation;
      const images = Array.from({ length: frames }, (_, i) => ({ bytes: simulatedFrame(job.prompt, job.size, i, skeleton, poses?.[i]), mime: "image/png" }));
      return { images, cost: { amount: 1, unit: "generations" } };
    }
    if (job.world) return { images: [{ bytes: simulatedWorldImage(job), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
    return { images: [{ bytes: simulatedImage(job.prompt, job.size), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
  }

  async cancel(remoteId: string): Promise<void> {
    const state = this.store.read();
    const job = state.jobs[remoteId];
    if (job) {
      job.cancelled = true;
      this.store.write(state);
    }
  }
}

/** Imagem determinística derivada do prompt: losango colorido com contorno, fundo transparente. */
export function simulatedImage(prompt: string, [w, h]: [number, number]): Uint8Array {
  const digest = createHash("sha256").update(prompt).digest();
  const fill = [digest[0]!, digest[1]!, digest[2]!, 255] as const;
  const img = createImage(w, h);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const r = Math.min(w, h) / 2 - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= r - 1) setPixel(img, x, y, fill);
      else if (d <= r) setPixel(img, x, y, [20, 20, 28, 255]);
    }
  }
  return encodePng(img);
}

// ---------------------------------------------------------------------------
// Animação e vistas simuladas (cartão S1)
// ---------------------------------------------------------------------------

const SIMULATED_ANIMATION_OPS: PlanOperation[] = ["animate_preset", "animate_text", "animate_skeleton", "rotate_views"];

/** Declara as operações nativas para ensaiar fila, publicação e revisão sem custo; nunca vira provedor real. */
export const SIMULATED_ANIMATION_CAPABILITIES: Capability[] = [
  "text_animation",
  "skeleton_keypoints",
  "custom_skeleton",
  "rotation_4",
  "rotation_8",
  "isometric_views",
  "image_references",
];

/** Tamanho pela referência da base; quadros pela contagem pedida (texto/preset) ou pelas poses recebidas (esqueleto). */
function simulatedAnimation(request: ProviderSubmitRequest): { size?: [number, number]; job?: SimulatedRemoteJob["animation"] } | null {
  if (!SIMULATED_ANIMATION_OPS.includes(request.operation)) return null;
  const image = request.references.find((r) => r.mime === "image/png");
  const info = image ? readPngInfo(image.bytes) : null;
  const size: [number, number] | undefined = info ? [info.width, info.height] : undefined;
  if (request.operation === "rotate_views") return { ...(size ? { size } : {}) };
  const motionRef = request.references.find((r) => r.role === "motion");
  const motion = motionRef ? (JSON.parse(new TextDecoder().decode(motionRef.bytes)) as MotionPayload) : null;
  const durations = request.params.durationsMs as number[] | undefined;
  const frames = motion?.poses.length ?? durations?.length ?? 4;
  return {
    ...(size ? { size } : {}),
    job: { frames, ...(motion ? { skeleton: motion.skeleton, poses: motion.poses.map((p) => p.joints) } : {}) },
  };
}

/** Quadro simulado: losango do prompt deslocado pelo índice e, no esqueleto, a pose recebida desenhada por cima. */
export function simulatedFrame(prompt: string, [w, h]: [number, number], index: number, skeleton?: Skeleton, pose?: Record<string, JointPose>): Uint8Array {
  const digest = createHash("sha256").update(prompt).digest();
  const fill = [digest[0]!, digest[1]!, digest[2]!, 255] as const;
  const img: RgbaImage = createImage(w, h);
  const r = Math.min(w, h) / 3;
  const cx = (w - 1) / 2 + ((index % 3) - 1) * Math.max(1, Math.round(w / 32));
  const cy = h - 2 - r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy);
      if (d <= r - 1) setPixel(img, x, y, fill);
      else if (d <= r) setPixel(img, x, y, [20, 20, 28, 255]);
    }
  }
  if (skeleton && pose) drawPose(img, skeleton, pose, [0, 0, w, h], 1);
  return encodePng(img);
}
