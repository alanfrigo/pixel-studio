import { type OverlayCoverageParams } from "@/contracts";
import { createImage, type RgbaImage } from "@/lib/media/png";
import type { ProviderSubmitRequest } from "../providers/types";
import { PAL, put, rect } from "./demo-art";
import { decodePng, encodePngDeflate } from "./png";
import { isEquipmentOperation } from "./provider-caps";

/**
 * Respostas SIMULADAS do cartão S2 (provedor de desenvolvimento, identificado
 * como tal): o "modelo" redesenha a grade recebida e pinta uma malha só onde a
 * guia marca a zona autorizada; a vista rígida é uma lâmina simples. Serve para
 * ensaiar fila, extração local, publicação e revisão sem custo.
 */

export interface SimulatedEquipmentJob {
  /** PNG da resposta em base64 (já na grade lógica: a extração não depende de redução). */
  png: string;
}

function hexRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

export function simulatedEquipmentJob(request: ProviderSubmitRequest): SimulatedEquipmentJob | null {
  if (!isEquipmentOperation(request.operation)) return null;
  const params = request.params as OverlayCoverageParams;
  if (params.mode === "rigid_view") return { png: Buffer.from(encodePngDeflate(simulatedRigid(params.size, params.backgroundKey))).toString("base64") };
  const context = request.references.find((r) => r.role === "base");
  const guide = request.references.find((r) => r.role === "composition");
  if (!context || !guide) return null;
  const ctx = decodePng(context.bytes);
  const gd = decodePng(guide.bytes);
  // Fator inteiro da guia: a tela lógica da tira cabe exatamente na referência.
  const strip = params.strips.find((s) => ctx.width % s.canvas[0] === 0 && ctx.height % s.canvas[1] === 0 && ctx.width / s.canvas[0] === ctx.height / s.canvas[1]);
  const k = strip ? ctx.width / strip.canvas[0] : 1;
  const w = Math.round(ctx.width / k);
  const h = Math.round(ctx.height / k);
  const mark = hexRgb(params.markColor);
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * k * ctx.width + x * k) * 4;
      const painted = gd.data[i] === mark[0] && gd.data[i + 1] === mark[1] && gd.data[i + 2] === mark[2];
      const color = painted ? ((x + y) % 2 === 0 ? PAL.mailDark : PAL.mailLight) : ([ctx.data[i]!, ctx.data[i + 1]!, ctx.data[i + 2]!, ctx.data[i + 3]!] as const);
      put(out, x, y, color);
    }
  }
  return { png: Buffer.from(encodePngDeflate(out)).toString("base64") };
}

/** Lâmina vertical com guarda e cabo, na grade pedida, sobre a cor-chave (ou transparente). */
function simulatedRigid([w, h]: [number, number], key: string | null): RgbaImage {
  const img = createImage(w, h);
  if (key) {
    const [r, g, b] = hexRgb(key);
    rect(img, 0, 0, w, h, [r, g, b, 255]);
  }
  const cx = Math.floor(w / 2);
  const guard = Math.max(1, Math.round(h * 0.7));
  rect(img, cx - 1, 1, 2, guard - 1, PAL.steel);
  rect(img, Math.max(0, cx - 2), guard, Math.min(w, 5), 1, PAL.gold);
  rect(img, cx - 1, guard + 1, 2, Math.max(1, h - guard - 2), PAL.wood);
  return img;
}
