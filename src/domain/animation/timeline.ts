import type { ClipPayload } from "@/contracts";

/**
 * Tempo de clipe (04 §contratos): `durationMs` inteiro positivo de cada quadro
 * é a autoridade; FPS só preenche tempos uniformes ou é exibido como média.
 * Retimar muda durações sem gerar pixels; eventos ficam presos ao ID do quadro.
 */

export type Playback = ClipPayload["playback"];

export function totalMs(durations: readonly number[]): number {
  return durations.reduce((a, b) => a + b, 0);
}

export function uniformDurations(fps: number, frames: number): number[] {
  const ms = Math.max(1, Math.round(1000 / Math.max(0.1, fps)));
  return Array.from({ length: frames }, () => ms);
}

export function averageFps(durations: readonly number[]): number {
  const total = totalMs(durations);
  return total > 0 ? Math.round((durations.length * 1000 * 10) / total) / 10 : 0;
}

/**
 * Quadro exibido no instante `t` (ms desde o início). `once` para no último;
 * `ping_pong` volta sem repetir as pontas.
 */
export function frameAt(durations: readonly number[], t: number, playback: Playback): number {
  const n = durations.length;
  if (n === 0) return 0;
  const order = playback === "ping_pong" && n > 2 ? [...durations.keys(), ...Array.from({ length: n - 2 }, (_, i) => n - 2 - i)] : [...durations.keys()];
  const cycle = order.reduce((acc, i) => acc + durations[i]!, 0);
  let local = t;
  if (playback === "once") {
    if (t >= cycle) return n - 1;
  } else {
    local = ((t % cycle) + cycle) % cycle;
  }
  for (const i of order) {
    if (local < durations[i]!) return i;
    local -= durations[i]!;
  }
  return order[order.length - 1]!;
}

export function durationProblems(durations: readonly number[], frames: number): string[] {
  const problems: string[] = [];
  if (durations.length !== frames) problems.push(`Esperadas ${frames} durações, recebidas ${durations.length}`);
  durations.forEach((d, i) => {
    if (!Number.isInteger(d) || d < 1 || d > 60_000) problems.push(`Duração do quadro ${i + 1} deve ser inteira entre 1 e 60000 ms`);
  });
  return problems;
}

/** Novo payload com as durações trocadas; IDs, camadas, sockets e eventos intactos. */
export function retimeClip(clip: ClipPayload, durations: readonly number[]): ClipPayload {
  const problems = durationProblems(durations, clip.frames.length);
  if (problems.length > 0) throw new RangeError(problems[0]);
  return { ...clip, frames: clip.frames.map((f, i) => ({ ...f, durationMs: durations[i]! })) };
}

/**
 * Grade da folha pedida a uma rota genérica: só proporções que as rotas de
 * imagem aceitam (1:1 e 3:2; o OpenAI recusa 2:1 e 4:3 — ensaio real do S3),
 * com células sobrando declaradas vazias.
 */
export function sheetLayout(frames: number): { columns: number; rows: number } {
  if (frames <= 1) return { columns: 1, rows: 1 };
  if (frames <= 4) return { columns: 2, rows: 2 };
  if (frames <= 6) return { columns: 3, rows: 2 };
  if (frames <= 9) return { columns: 3, rows: 3 };
  return { columns: 4, rows: 4 };
}
