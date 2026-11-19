"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Insets, LayerRef } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { type ComboView, errorText, type LayerView, layerRefKey, mediaUrl, STATUS_LABEL } from "./shared";

/**
 * Player do clipe resolvido (04 §revisar): toca com o `durationMs` de cada
 * frame, em zoom inteiro, com camadas alternáveis, guias de sockets,
 * empunhaduras, pivô e limites da célula (contorno cortado aparece fora dela),
 * transparência da base, override da ordem do frame e composição no servidor
 * (a mesma folha achatada que vai no pacote). Nada aqui chama provedor.
 */

type Bg = "checker" | "dark" | "light" | "green";
const PAD = 12;

export function ResolvedPlayer({
  projectId,
  combo,
  request,
  onSaveOrder,
  onExpand,
}: {
  projectId: string;
  combo: ComboView;
  /** Pedido de resolução que originou o combo (para compor no servidor). */
  request: { loadoutRevisionId: string } | { config: unknown };
  onSaveOrder?: (clipRevisionId: string, frameId: string, layers: LayerRef[]) => Promise<void>;
  onExpand?: (clipRevisionId: string, margins: Insets) => Promise<void>;
}) {
  const clip = combo.clip!;
  const [w, h] = clip.logicalSize;
  const [zoom, setZoom] = useState(Math.max(1, Math.floor(320 / Math.max(w, h))));
  const [bg, setBg] = useState<Bg>("checker");
  const [playing, setPlaying] = useState(true);
  const [current, setCurrent] = useState(0);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [baseAlpha, setBaseAlpha] = useState(100);
  const [guides, setGuides] = useState({ sockets: true, grips: true, pivot: true, bounds: true });
  /** Ordem editada (ainda não salva) do frame em que foi editada. */
  const [edited, setEdited] = useState<{ frameId: string; layers: LayerView[] } | null>(null);
  const [server, setServer] = useState<{ sheet: string; warnings: string[]; frames: unknown[] } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const images = useRef(new Map<string, HTMLImageElement>());
  const canvas = useRef<HTMLCanvasElement>(null);
  const frames = combo.frames;
  const frame = frames[Math.min(current, frames.length - 1)]!;
  const order = edited?.frameId === frame.frameId ? edited.layers : null;
  const layers = order ?? frame.layers;

  // Imagens de todas as camadas do clipe (cada arquivo uma vez).
  useEffect(() => {
    let alive = true;
    for (const f of frames) {
      for (const l of f.layers) {
        if (!l.mediaId || images.current.has(l.mediaId)) continue;
        const img = new Image();
        img.onload = () => alive && setLoaded((n) => n + 1);
        img.src = mediaUrl(projectId, l.mediaId);
        images.current.set(l.mediaId, img);
      }
    }
    return () => {
      alive = false;
    };
  }, [frames, projectId]);

  // Relógio pelas durações (autoridade temporal), sem FPS.
  useEffect(() => {
    if (!playing) return;
    const total = frames.reduce((n, f) => n + f.durationMs, 0);
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      let t = (performance.now() - start) % total;
      let i = 0;
      while (i < frames.length - 1 && t >= frames[i]!.durationMs) t -= frames[i++]!.durationMs;
      setCurrent(i);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, frames]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = (w + PAD * 2) * zoom;
    c.height = (h + PAD * 2) * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    const ox = PAD * zoom;
    const oy = PAD * zoom;
    for (const l of layers) {
      if (hidden.has(l.key) || !l.mediaId) continue;
      const img = images.current.get(l.mediaId);
      if (!img?.complete || !img.naturalWidth) continue;
      ctx.globalAlpha = l.kind === "base" ? baseAlpha / 100 : 1;
      const [sx, sy, sw, sh] = l.rect;
      const dx = ox + l.offset[0] * zoom;
      const dy = oy + l.offset[1] * zoom;
      if (l.mirrored) {
        ctx.save();
        ctx.translate(dx + sw * zoom, dy);
        ctx.scale(-1, 1);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw * zoom, sh * zoom);
        ctx.restore();
      } else {
        ctx.drawImage(img, sx, sy, sw, sh, dx, dy, sw * zoom, sh * zoom);
      }
    }
    ctx.globalAlpha = 1;
    // Fora da célula: escurecido (o que passa dali é contorno cortado).
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, c.width, oy);
    ctx.fillRect(0, oy + h * zoom, c.width, c.height - oy - h * zoom);
    ctx.fillRect(0, oy, ox, h * zoom);
    ctx.fillRect(ox + w * zoom, oy, c.width - ox - w * zoom, h * zoom);
    if (guides.bounds) {
      ctx.strokeStyle = "rgba(60,90,160,0.9)";
      ctx.strokeRect(ox - 0.5, oy - 0.5, w * zoom + 1, h * zoom + 1);
      for (const issue of frame.issues.filter((i) => i.kind === "clipped_outline")) {
        const l = layers.find((x) => x.key === issue.layerKey);
        if (!l) continue;
        ctx.strokeStyle = "rgba(220,30,30,0.95)";
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(ox + l.offset[0] * zoom, oy + l.offset[1] * zoom, l.size[0] * zoom, l.size[1] * zoom);
        ctx.setLineDash([]);
      }
    }
    const mark = (x: number, y: number, color: string, size = 3) => {
      // Índice de pixel: centro do pixel.
      const cx = ox + (x + 0.5) * zoom;
      const cy = oy + (y + 0.5) * zoom;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(cx - size * 2, cy);
      ctx.lineTo(cx + size * 2, cy);
      ctx.moveTo(cx, cy - size * 2);
      ctx.lineTo(cx, cy + size * 2);
      ctx.stroke();
    };
    if (guides.sockets) {
      for (const s of frame.sockets) mark(s.at[0], s.at[1], s.socketId.includes("right") ? "rgba(255,140,0,0.95)" : "rgba(0,180,255,0.95)", s.hidden ? 2 : 3);
    }
    if (guides.grips) {
      for (const l of layers) {
        for (const g of l.grips) {
          const color = g.exceeds ? "rgba(230,0,0,1)" : "rgba(0,200,90,1)";
          ctx.strokeStyle = color;
          ctx.strokeRect(ox + g.drawnAt[0] * zoom + 0.5, oy + g.drawnAt[1] * zoom + 0.5, zoom - 1, zoom - 1);
        }
      }
    }
    if (guides.pivot) {
      // Pivô: ponto da grade (pode estar na borda da célula).
      const px = ox + clip.pivot[0] * zoom;
      const py = oy + clip.pivot[1] * zoom;
      ctx.strokeStyle = "rgba(255,0,170,0.9)";
      ctx.beginPath();
      ctx.moveTo(px - 5, py);
      ctx.lineTo(px + 5, py);
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px, py + 5);
      ctx.stroke();
    }
  }, [layers, frame, hidden, zoom, w, h, baseAlpha, guides, loaded, clip.pivot]);

  const allKeys = useMemo(() => {
    const seen = new Map<string, string>();
    for (const f of frames) for (const l of f.layers) if (!seen.has(l.key)) seen.set(l.key, l.label);
    return [...seen];
  }, [frames]);

  const clipped = frames.flatMap((f) => f.issues.filter((i) => i.kind === "clipped_outline" && i.overflow).map((i) => i.overflow!));
  const suggested: Insets = clipped.reduce<Insets>(
    (acc, o) => ({ left: Math.max(acc.left, o.left ? o.left + 1 : 0), right: Math.max(acc.right, o.right ? o.right + 1 : 0), top: Math.max(acc.top, o.top ? o.top + 1 : 0), bottom: Math.max(acc.bottom, o.bottom ? o.bottom + 1 : 0) }),
    { left: 0, right: 0, top: 0, bottom: 0 },
  );
  // O player é remontado por combinação (chave no pai): a sugestão vale como valor inicial.
  const [margins, setMargins] = useState<Insets>(suggested);

  async function composeOnServer() {
    setMessage(null);
    try {
      const res = await apiFetch<{ sheet: string; warnings: string[]; frames: unknown[] }>(`/projects/${projectId}/equipment/compose`, { method: "POST", json: { request, action: combo.action, direction: combo.direction } });
      setServer(res);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  function move(i: number, d: -1 | 1) {
    const list = [...layers];
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    setEdited({ frameId: frame.frameId, layers: list });
  }

  return (
    <div>
      <div className="row small">
        <strong>
          {combo.action} · {combo.direction} · {combo.stance}
        </strong>
        <span className={`badge state-${combo.status === "ready" ? "ready" : "failed"}`}>{STATUS_LABEL[combo.status]}</span>
        <span className="muted">
          {clip.name} r{clip.number} · célula {w}×{h} · pivô {clip.pivot.join(",")}
          {clip.margins.top + clip.margins.left + clip.margins.right + clip.margins.bottom > 0 && ` · margens ${clip.margins.left}/${clip.margins.top}/${clip.margins.right}/${clip.margins.bottom}`}
        </span>
      </div>
      <canvas ref={canvas} className={`pixel bg-${bg}`} style={{ maxWidth: "100%" }} />
      <div className="row small">
        <button type="button" className="secondary" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pausar" : "Tocar"}
        </button>
        <button type="button" className="secondary" onClick={() => (setPlaying(false), setCurrent((c) => (c + frames.length - 1) % frames.length))}>
          ◀ frame
        </button>
        <button type="button" className="secondary" onClick={() => (setPlaying(false), setCurrent((c) => (c + 1) % frames.length))}>
          frame ▶
        </button>
        <label>
          Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 8].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <label>
          Fundo
          <select value={bg} onChange={(e) => setBg(e.target.value as Bg)}>
            <option value="checker">quadriculado</option>
            <option value="dark">escuro</option>
            <option value="light">claro</option>
            <option value="green">grama</option>
          </select>
        </label>
        <label>
          Base {baseAlpha}%
          <input type="range" min={0} max={100} step={10} value={baseAlpha} onChange={(e) => setBaseAlpha(Number(e.target.value))} />
        </label>
      </div>
      <div className="row small">
        {(["sockets", "grips", "pivot", "bounds"] as const).map((g) => (
          <label key={g} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={guides[g]} onChange={(e) => setGuides((x) => ({ ...x, [g]: e.target.checked }))} />
            {g === "sockets" ? "sockets (mão direita laranja, esquerda azul)" : g === "grips" ? "empunhaduras (vermelho = desvio acima da tolerância)" : g === "pivot" ? "pivô" : "limites da célula"}
          </label>
        ))}
      </div>
      <table className="anim-timeline small">
        <thead>
          <tr>
            <th>Frame</th>
            {frames.map((f, i) => (
              <th key={f.frameId} className={i === current ? "current" : ""} onClick={() => (setPlaying(false), setCurrent(i))} style={{ cursor: "pointer" }}>
                {f.frameId}
                {f.gaps.length > 0 ? " ⚠" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ms</td>
            {frames.map((f) => (
              <td key={f.frameId}>{f.durationMs}</td>
            ))}
          </tr>
        </tbody>
      </table>

      <div className="grid2">
        <div>
          <h3 className="small">Camadas (alternáveis)</h3>
          <ul className="eq-layers">
            {allKeys.map(([key, label]) => (
              <li key={key}>
                <input type="checkbox" checked={!hidden.has(key)} onChange={(e) => setHidden((s) => (e.target.checked ? new Set([...s].filter((k) => k !== key)) : new Set([...s, key])))} />
                {label}
              </li>
            ))}
          </ul>
          {frame.gaps.length > 0 && <p className="small error">Faltando neste frame: {frame.gaps.map((g) => `${g.overlayName} · ${g.partId}`).join("; ")}</p>}
          {frame.empty.length > 0 && <p className="small muted">Vazias explícitas: {frame.empty.map((e) => e.partId).join(", ")}</p>}
          {frame.issues.map((i) => (
            <p key={`${i.kind}-${i.layerKey}-${i.socketId ?? ""}`} className={`small ${i.kind === "socket_deviation" ? "" : "error"}`}>
              {i.message}
            </p>
          ))}
        </div>
        <div>
          <h3 className="small">
            Ordem de desenho do frame {frame.frameId} (trás → frente){frame.override.applied ? " · override" : ""}
          </h3>
          <ol className="eq-layers">
            {layers.map((l, i) => (
              <li key={l.key}>
                <button type="button" className="secondary" disabled={!onSaveOrder || i === 0} onClick={() => move(i, -1)} aria-label="Mover para trás">
                  ↑
                </button>
                <button type="button" className="secondary" disabled={!onSaveOrder || i === layers.length - 1} onClick={() => move(i, 1)} aria-label="Mover para frente">
                  ↓
                </button>
                {l.label} <span className="muted">({l.drawIndex})</span>
              </li>
            ))}
          </ol>
          {onSaveOrder && order && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await onSaveOrder(clip.revisionId, frame.frameId, order.map((l) => l.ref as LayerRef));
                  setEdited(null);
                } catch (err) {
                  setMessage(errorText(err));
                }
              }}
            >
              Salvar ordem deste frame (nova revisão do conjunto)
            </button>
          )}
          {frame.override.problems.map((p) => (
            <p key={p} className="small error">
              {p}
            </p>
          ))}
        </div>
      </div>

      {onExpand && (
        <div className="row small" style={{ marginTop: 8 }}>
          <strong>Ampliar célula</strong>
          {clipped.length > 0 ? <span className="error">contorno cortado em {clipped.length} camada(s)</span> : <span className="muted">nenhum contorno cortado</span>}
          {(["left", "top", "right", "bottom"] as const).map((side) => (
            <label key={side}>
              {side === "left" ? "esq." : side === "top" ? "topo" : side === "right" ? "dir." : "base"}
              <input type="number" min={0} max={64} value={margins[side]} style={{ width: 56 }} onChange={(e) => setMargins((m) => ({ ...m, [side]: Math.max(0, Math.round(Number(e.target.value) || 0)) }))} />
            </label>
          ))}
          <button
            type="button"
            className="secondary"
            disabled={margins.left + margins.right + margins.top + margins.bottom === 0}
            onClick={async () => {
              try {
                await onExpand(clip.revisionId, margins);
              } catch (err) {
                setMessage(errorText(err));
              }
            }}
          >
            Ampliar (camadas, sockets, pivô e coberturas pela mesma margem)
          </button>
        </div>
      )}

      <div className="row small" style={{ marginTop: 8 }}>
        <button type="button" className="secondary" onClick={composeOnServer}>
          Compor no servidor (folha achatada, pixel a pixel)
        </button>
        {message && <span className="error">{message}</span>}
      </div>
      {server && (
        <figure style={{ margin: "8px 0" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={`pixel bg-${bg}`} src={server.sheet} alt="Folha achatada composta no servidor" style={{ width: `${frames.length * w * Math.min(zoom, 3)}px`, maxWidth: "100%" }} />
          <figcaption className="small muted">
            Folha achatada (frames lado a lado), composta localmente; é o que vai no pacote quando a folha é pedida.
            {server.warnings.length ? ` Avisos: ${server.warnings.join("; ")}` : ""}
          </figcaption>
        </figure>
      )}
    </div>
  );
}

export function layerKeyOf(ref: LayerRef) {
  return layerRefKey(ref);
}
