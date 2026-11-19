"use client";

import { useEffect, useRef, useState } from "react";
import type { ClipPayload } from "@/contracts";
import { averageFps, frameAt, totalMs } from "@/domain/animation/timeline";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { clipFrameLayers, errorText } from "./shared";

/**
 * Prévia do clipe (04 §revisar): reproduz com o `durationMs` de cada quadro,
 * em zoom inteiro, com onion skin e fundo escolhido. Cada quadro é composto
 * pelas suas camadas (arquivo, retângulo e posição na célula), como no pacote
 * exportado — atlas e canvas ampliado aparecem certos. As durações são editáveis
 * localmente; "Salvar tempos" publica revisão nova com os mesmos quadros —
 * nenhum pixel é gerado e nenhum provedor é chamado.
 */

type Bg = "checker" | "dark" | "light";

export function ClipPlayer({ projectId, revision, onSaved }: { projectId: string; revision: RevisionView; onSaved: (revisionId: string) => void }) {
  const clip = revision.payload as ClipPayload;
  const frames = clipFrameLayers(projectId, revision);
  const [w, h] = clip.logicalSize;
  const [durations, setDurations] = useState(() => clip.frames.map((f) => f.durationMs));
  const [playback, setPlayback] = useState(clip.playback);
  const [playing, setPlaying] = useState(true);
  const [onion, setOnion] = useState(false);
  const [bg, setBg] = useState<Bg>("checker");
  const [zoom, setZoom] = useState(Math.max(1, Math.floor(256 / Math.max(w, h))));
  const [current, setCurrent] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const images = useRef<Map<string, HTMLImageElement>>(new Map());
  const canvas = useRef<HTMLCanvasElement>(null);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    let alive = true;
    const map = new Map<string, HTMLImageElement>();
    for (const src of new Set(frames.flat().map((l) => l.src))) {
      const img = new Image();
      img.onload = () => alive && setLoaded((n) => n + 1);
      img.src = src;
      map.set(src, img);
    }
    images.current = map;
    return () => {
      alive = false;
    };
    // As URLs mudam só com a revisão.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision.id]);

  // Relógio: o quadro exibido sai das durações locais (autoridade temporal), não de um FPS.
  useEffect(() => {
    if (!playing) return;
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      setCurrent(frameAt(durations, performance.now() - start, playback));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, durations, playback]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = w * zoom;
    c.height = h * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    const draw = (i: number, alpha: number) => {
      ctx.globalAlpha = alpha;
      for (const layer of frames[i] ?? []) {
        const img = images.current.get(layer.src);
        if (!img?.complete || !img.naturalWidth) continue;
        const [rx, ry, rw, rh] = layer.rect;
        ctx.drawImage(img, rx, ry, rw, rh, layer.offset[0] * zoom, layer.offset[1] * zoom, rw * zoom, rh * zoom);
      }
    };
    if (onion && current > 0) draw(current - 1, 0.3);
    draw(current, 1);
    ctx.globalAlpha = 1;
    // Pivô de cena (ponto da grade, pode estar na borda da célula).
    ctx.strokeStyle = "rgba(255,0,170,0.9)";
    ctx.beginPath();
    ctx.moveTo(clip.pivot[0] * zoom - 4, clip.pivot[1] * zoom);
    ctx.lineTo(clip.pivot[0] * zoom + 4, clip.pivot[1] * zoom);
    ctx.moveTo(clip.pivot[0] * zoom, clip.pivot[1] * zoom - 4);
    ctx.lineTo(clip.pivot[0] * zoom, clip.pivot[1] * zoom + 4);
    ctx.stroke();
    // Quadros mudam só com a revisão (mesma chave do efeito de carga).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, onion, zoom, w, h, loaded, clip.pivot]);

  const changed = durations.some((d, i) => d !== clip.frames[i]!.durationMs) || playback !== clip.playback;

  async function save() {
    setMessage(null);
    try {
      const res = await apiFetch<{ revision: RevisionView; unchanged: boolean }>(`/projects/${projectId}/animation/retime`, {
        method: "POST",
        json: { clipRevisionId: revision.id, durationsMs: durations, playback },
      });
      setMessage(res.unchanged ? "Nada mudou." : `Revisão r${res.revision.number} publicada com os mesmos quadros (nenhuma geração).`);
      if (!res.unchanged) onSaved(res.revision.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <div className="anim-player">
      <canvas ref={canvas} className={`pixel bg-${bg}`} />
      <div className="row small">
        <button type="button" className="secondary" onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pausar" : "Tocar"}
        </button>
        <label>
          Repetição
          <select value={playback} onChange={(e) => setPlayback(e.target.value as ClipPayload["playback"])}>
            <option value="loop">ciclo</option>
            <option value="once">uma vez</option>
            <option value="ping_pong">vai e volta</option>
          </select>
        </label>
        <label>
          Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 2, 3, 4, 6, 8].map((z) => (
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
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={onion} onChange={(e) => setOnion(e.target.checked)} /> onion skin
        </label>
      </div>
      <table className="anim-timeline small">
        <thead>
          <tr>
            <th>Quadro</th>
            {clip.frames.map((f, i) => (
              <th key={f.frameId} className={i === current ? "current" : ""} onClick={() => (setPlaying(false), setCurrent(i))}>
                {f.frameId}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>ms</td>
            {durations.map((d, i) => (
              <td key={clip.frames[i]!.frameId}>
                <input
                  type="number"
                  min={1}
                  max={60000}
                  step={10}
                  value={d}
                  aria-label={`Duração do quadro ${clip.frames[i]!.frameId}`}
                  onChange={(e) => {
                    const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                    setDurations((all) => all.map((x, j) => (j === i ? v : x)));
                  }}
                />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        Total {totalMs(durations)} ms · média {averageFps(durations)} FPS (só exibição; a duração de cada quadro é a autoridade).
      </p>
      <div className="row">
        <button type="button" disabled={!changed} onClick={save}>
          Salvar tempos (sem gerar)
        </button>
        <button type="button" className="secondary" disabled={!changed} onClick={() => (setDurations(clip.frames.map((f) => f.durationMs)), setPlayback(clip.playback))}>
          Desfazer
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </div>
  );
}
