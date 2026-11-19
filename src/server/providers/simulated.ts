import { tx } from "@/i18n/locales";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Capability, CostEstimate, JointPose, MotionPayload, Skeleton } from "@/contracts";
import { drawPose } from "@/domain/animation/pose-guide";
import { createImage, encodePng, fillRect, readPngInfo, type Rgba, type RgbaImage, setPixel } from "@/lib/media/png";
import type { PlanOperation } from "@/contracts";
import { ProviderError, type ProviderAdapter, type ProviderResult, type ProviderSubmitRequest, type RemoteStatus, type SubmitOutcome } from "./types";
import { genericWorldCapabilities, isWorldOperation } from "../world/provider-caps";
import { type SimulatedWorldJob, simulatedWorldImage, simulatedWorldJob } from "../world/simulated-art";
import { isSimulatedSceneOperation, type SimulatedSceneJob, simulatedSceneCapabilities, simulatedSceneJob, simulatedSceneResult } from "../scenes/simulated-art";
import { isTemporalOperation, type SimulatedTemporalJob, simulatedTemporalCapabilities, simulatedTemporalImages, simulatedTemporalJob } from "../animation/provider-temporal";
import { genericEquipmentCapabilities, isEquipmentOperation } from "../equipment/provider-caps";
import { type SimulatedEquipmentJob, simulatedEquipmentJob } from "../equipment/simulated-art";
import { isDialogueOperation } from "../dialogue/provider-caps";
import { type SimulatedDialogueJob, simulatedDialogueCapabilities, simulatedDialogueJob } from "../dialogue/simulated-art";
import { genericUiCapabilities, isUiOperation } from "../ui/provider-caps";
import { type SimulatedUiJob, simulatedUiJob } from "../ui/simulated-art";

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
  character?: boolean;
  /** Animação simulada (S1): quantos quadros devolver e, no esqueleto, as poses recebidas como dados. */
  animation?: { frames: number; skeleton?: Skeleton; poses?: Record<string, JointPose>[] };
  /** Mundo simulado (T1): material repetível ou eco do gabarito do tileset. */
  world?: SimulatedWorldJob;
  /** Cenas, planos, salas e props simulados (T2). */
  scene?: SimulatedSceneJob;
  /** Estados e edição temporal simulados (S3). */
  temporal?: SimulatedTemporalJob;
  /** Candidato vestido ou vista rígida simulados (S2). */
  equipment?: SimulatedEquipmentJob;
  /** Retrato, folha de bocas ou página de glyphs simulados (D1). */
  dialogue?: SimulatedDialogueJob;
  /** Template pintado na guia ou folha de estados por imagem + referência (U3), como a rota genérica. */
  ui?: SimulatedUiJob;
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
    if (isSimulatedSceneOperation(operation)) return [...simulatedSceneCapabilities(operation)];
    if (isTemporalOperation(operation)) return simulatedTemporalCapabilities(operation);
    if (isEquipmentOperation(operation)) return genericEquipmentCapabilities(16);
    if (isDialogueOperation(operation)) return simulatedDialogueCapabilities(operation);
    // U3: as mesmas capacidades da rota genérica (nada de template ou estados nativos).
    if (isUiOperation(operation)) return genericUiCapabilities(operation, 16);
    return operation === "generate_asset" ? SIMULATED_CAPABILITIES : [];
  }

  estimate(_operation: PlanOperation, parts: number): CostEstimate {
    return { kind: "known", amount: { amount: parts, unit: "generations" }, basis: tx(`${parts} geração(ões) simulada(s), 1 por imagem`, `${parts} simulated generation(s), 1 per image`) };
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
    if (request.operation === "generate_asset" && request.params.family === "character") state.jobs[id].character = true;
    if (animation?.job) state.jobs[id].animation = animation.job;
    const world = simulatedWorldJob(request);
    if (world) state.jobs[id].world = world;
    if (isSimulatedSceneOperation(request.operation)) state.jobs[id].scene = simulatedSceneJob(request);
    const temporal = simulatedTemporalJob(request);
    if (temporal) state.jobs[id].temporal = temporal;
    const equipment = simulatedEquipmentJob(request);
    if (equipment) state.jobs[id].equipment = equipment;
    const dialogue = simulatedDialogueJob(request);
    if (dialogue) state.jobs[id].dialogue = dialogue;
    const ui = simulatedUiJob(request);
    if (ui) state.jobs[id].ui = ui;
    state.charged += 1;
    this.store.write(state);
    if (this.options.failAfterAccept) throw new ProviderError("ambiguous", tx("Conexão perdida depois do envio (simulado)", "Connection lost after submission (simulated)"));
    return { kind: "async", remoteId: id };
  }

  async poll(remoteId: string): Promise<RemoteStatus> {
    const job = this.store.read().jobs[remoteId];
    if (!job) return { state: "failed", message: tx(`Job remoto ${remoteId} desconhecido`, `Unknown remote job ${remoteId}`) };
    if (job.cancelled) return { state: "failed", message: tx("Cancelado no provedor", "Cancelled at the provider") };
    const now = this.now();
    if (now >= job.readyAt) return { state: "succeeded" };
    return { state: "pending", progress: (now - job.createdAt) / Math.max(1, job.readyAt - job.createdAt) };
  }

  async fetchResult(remoteId: string): Promise<ProviderResult> {
    const job = this.store.read().jobs[remoteId];
    if (!job) throw new ProviderError("rejected", tx(`Job remoto ${remoteId} desconhecido`, `Unknown remote job ${remoteId}`));
    if (job.animation) {
      const { frames, skeleton, poses } = job.animation;
      const images = Array.from({ length: frames }, (_, i) => ({ bytes: simulatedFrame(job.prompt, job.size, i, skeleton, poses?.[i]), mime: "image/png" }));
      return { images, cost: { amount: 1, unit: "generations" } };
    }
    if (job.world) return { images: [{ bytes: simulatedWorldImage(job), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
    if (job.scene) return { images: simulatedSceneResult(job.scene), cost: { amount: 1, unit: "generations" } };
    if (job.ui) return { images: [{ bytes: new Uint8Array(Buffer.from(job.ui.png, "base64")), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
    if (job.dialogue) return { images: [{ bytes: new Uint8Array(Buffer.from(job.dialogue.png, "base64")), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
    if (job.equipment) return { images: [{ bytes: new Uint8Array(Buffer.from(job.equipment.png, "base64")), mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
    if (job.temporal) return { images: simulatedTemporalImages(job.temporal, job.prompt).map((bytes) => ({ bytes, mime: "image/png" })), cost: { amount: 1, unit: "generations" } };
    const bytes = job.character ? simulatedCharacter(`${job.prompt}\n${job.idempotencyKey}`, job.size) : simulatedImage(job.prompt, job.size);
    return { images: [{ bytes, mime: "image/png" }], cost: { amount: 1, unit: "generations" } };
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

/** Sprite de teste neutro: exercita a célula, o alfa e o apoio, sem fingir interpretar o briefing. */
function simulatedCharacter(seed: string, [w, h]: [number, number]): Uint8Array {
  const digest = createHash("sha256").update(seed).digest();
  const fill = [80 + digest[0]! % 135, 80 + digest[1]! % 135, 80 + digest[2]! % 135, 255] as const;
  const ink = [31, 38, 50, 255] as const;
  const light = [232, 242, 226, 255] as const;
  const img = createImage(w, h);
  const rect = (left: number, top: number, right: number, bottom: number, color: Rgba) => {
    const x = Math.floor((left * w) / 16);
    const y = Math.floor((top * h) / 16);
    fillRect(img, x, y, Math.max(1, Math.floor((right * w) / 16) - x), Math.max(1, Math.floor((bottom * h) / 16) - y), color);
  };
  rect(5, 3, 12, 8, ink);
  rect(6, 4, 11, 7, fill);
  rect(7, 5, 8, 6, light);
  rect(9, 5, 10, 6, light);
  rect(4, 8, 13, 12, ink);
  rect(6, 8, 11, 11, fill);
  rect(6, 12, 8, 14, ink);
  rect(10, 12, 13, 14, ink);
  return encodePng(img);
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
