"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { JobStatus } from "../world/job-status";
import { errorText, estimateLabel, PIXEL, type PlanPreview, reportLabel, review, runPlan } from "./scenes-client";

/** Cartão de revisão candidata/aprovada com imagem, rótulo da rota e decisão pelo fluxo existente. */
export function RevisionCard({ projectId, asset, revision, src, width, refresh, children }: { projectId: string; asset: AssetView; revision: RevisionView; src: string | null; width?: number; refresh: () => void; children?: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  async function decide(decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt("Motivo da reprovação") ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const label = reportLabel(revision);
  const warnings = ((revision.technicalReport as { warnings?: string[] } | null)?.warnings ?? []).slice(0, 3);
  return (
    <div className="small" style={{ border: "1px solid var(--border, #444)", padding: 8, borderRadius: 6, maxWidth: (width ?? 256) + 24 }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src && <img src={src} alt={asset.name} className="pixel bg-checker" style={{ ...PIXEL, width: width ?? 256, maxWidth: "100%" }} />}
      <div>
        <strong>{asset.name}</strong> r{revision.number} <span className={`badge state-${revision.status}`}>{revision.status}</span>
      </div>
      {label && <div className="muted">{label}</div>}
      {warnings.map((w) => (
        <div key={w} className="muted">
          ⚠ {w}
        </div>
      ))}
      {children}
      {revision.status === "candidate" && (
        <div className="row">
          <button type="button" onClick={() => decide("approve")}>
            Aprovar
          </button>
          <button type="button" className="secondary" onClick={() => decide("reject")}>
            Reprovar
          </button>
        </div>
      )}
      {message && <p className="error">{message}</p>}
    </div>
  );
}

/**
 * Prévia do plano (rota, capacidades, estimativa) antes de enviar e
 * acompanhamento do job. O mesmo plano gera o mesmo job (sem cobrança dupla).
 */
export function PlanRunner({ projectId, label, body, target, onDone, disabled }: { projectId: string; label: string; body: () => Record<string, unknown> | null; target: () => Promise<string>; onDone: () => void; disabled?: boolean }) {
  const [preview, setPreview] = useState<(PlanPreview & Record<string, unknown>) | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function plan() {
    setMessage(null);
    setPreview(null);
    const b = body();
    if (!b) return;
    try {
      setPreview(await apiFetch<PlanPreview & Record<string, unknown>>(`/projects/${projectId}/generation-plans`, { method: "POST", json: b }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function send() {
    if (!preview) return;
    setBusy(true);
    try {
      const assetId = (preview.targetAssetId as string | undefined) ?? (await target());
      const { job } = await runPlan(projectId, preview, assetId);
      setJobId(job.id);
      setPreview(null);
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const restrictions = (preview?.restrictions as string[] | undefined) ?? [];
  return (
    <div>
      <button type="button" onClick={plan} disabled={disabled}>
        {label}: conferir plano
      </button>
      {preview && (
        <div className="small" style={{ marginTop: 6 }}>
          <div>
            Rota: <strong>{String(preview.routeLabel ?? preview.plan.operation)}</strong>
            {preview.destination.simulated ? <span className="badge"> simulado</span> : null}
          </div>
          <div className="muted">
            Destino {preview.destination.name} · capacidades {preview.plan.requiredCapabilities.join(", ")} · {preview.plan.parts.length} parte(s) · estimativa {estimateLabel(preview.plan)}
          </div>
          {restrictions.map((r) => (
            <div key={r} className="muted">
              ⚠ {r}
            </div>
          ))}
          <details>
            <summary>Prompt compilado</summary>
            <pre style={{ whiteSpace: "pre-wrap" }}>{preview.plan.prompt.compiled}</pre>
          </details>
          <button type="button" onClick={send} disabled={busy}>
            Enviar
          </button>
        </div>
      )}
      {jobId && <JobStatus projectId={projectId} jobId={jobId} onDone={onDone} />}
      {message && <p className="error">{message}</p>}
    </div>
  );
}

/** Máscara binária desenhada sobre uma imagem (pincel ou retângulo), exportada como PNG opaco preto/branco. */
export function MaskPainter({ src, size, color = [255, 0, 200, 120], onChange }: { src: string; size: [number, number]; color?: [number, number, number, number]; onChange: (png: Blob | null, pixels: number) => void }) {
  const [w, h] = size;
  const zoom = Math.max(1, Math.floor(512 / Math.max(w, h)));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<Uint8Array>(new Uint8Array(w * h));
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<[number, number] | null>(null);
  const [tool, setTool] = useState<"rect" | "brush" | "erase">("rect");
  const [brush, setBrush] = useState(3);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setVersion((v) => v + 1);
    };
    img.src = src;
    maskRef.current = new Uint8Array(w * h);
  }, [src, w, h]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = w * zoom;
    canvas.height = h * zoom;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (imgRef.current) ctx.drawImage(imgRef.current, 0, 0, canvas.width, canvas.height);
    const overlay = new ImageData(w, h);
    const mask = maskRef.current;
    for (let i = 0; i < mask.length; i++) if (mask[i]) overlay.data.set(color, i * 4);
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    off.getContext("2d")!.putImageData(overlay, 0, 0);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, [version, w, h, zoom, color]);
  const at = (e: React.PointerEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * w), Math.floor(((e.clientY - r.top) / r.height) * h)];
  };
  const paint = (x0: number, y0: number, x1: number, y1: number, value: number) => {
    const mask = maskRef.current;
    for (let y = Math.max(0, Math.min(y0, y1)); y <= Math.min(h - 1, Math.max(y0, y1)); y++) for (let x = Math.max(0, Math.min(x0, x1)); x <= Math.min(w - 1, Math.max(x0, x1)); x++) mask[y * w + x] = value;
  };
  async function emit() {
    const mask = maskRef.current;
    const pixels = mask.reduce((n, v) => n + (v ? 1 : 0), 0);
    if (!pixels) return onChange(null, 0);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const data = new ImageData(w, h);
    for (let i = 0; i < mask.length; i++) data.data.set([mask[i]!, mask[i]!, mask[i]!, 255], i * 4);
    c.getContext("2d")!.putImageData(data, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    onChange(blob, pixels);
  }
  return (
    <div>
      <div className="row small">
        {(["rect", "brush", "erase"] as const).map((t) => (
          <button key={t} type="button" className={tool === t ? "" : "secondary"} onClick={() => setTool(t)}>
            {t === "rect" ? "Retângulo" : t === "brush" ? "Pincel" : "Borracha"}
          </button>
        ))}
        <label>
          Pincel {brush}px <input type="range" min={1} max={12} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            maskRef.current = new Uint8Array(w * h);
            setVersion((v) => v + 1);
            void emit();
          }}
        >
          Limpar
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="pixel bg-checker"
        style={{ ...PIXEL, maxWidth: "100%", cursor: "crosshair", touchAction: "none" }}
        onPointerDown={(e) => {
          const p = at(e);
          dragRef.current = p;
          if (tool !== "rect") {
            const half = Math.floor((brush - 1) / 2);
            paint(p[0] - half, p[1] - half, p[0] - half + brush - 1, p[1] - half + brush - 1, tool === "brush" ? 255 : 0);
            setVersion((v) => v + 1);
          }
        }}
        onPointerMove={(e) => {
          if (!dragRef.current || tool === "rect") return;
          const p = at(e);
          const half = Math.floor((brush - 1) / 2);
          paint(p[0] - half, p[1] - half, p[0] - half + brush - 1, p[1] - half + brush - 1, tool === "brush" ? 255 : 0);
          setVersion((v) => v + 1);
        }}
        onPointerUp={(e) => {
          const start = dragRef.current;
          dragRef.current = null;
          if (start && tool === "rect") {
            const p = at(e);
            paint(start[0], start[1], p[0], p[1], 255);
            setVersion((v) => v + 1);
          }
          void emit();
        }}
      />
    </div>
  );
}

/** Imagem em zoom inteiro onde um clique devolve o ponto em px lógicos (apoio, colocação). */
export function PointPicker({ src, size, points, onPick, zoom: z }: { src: string; size: [number, number]; points: { at: [number, number]; label?: string }[]; onPick: (p: [number, number]) => void; zoom?: number }) {
  const zoom = z ?? Math.max(1, Math.floor(512 / Math.max(size[0], size[1])));
  return (
    <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className="pixel bg-checker"
        style={{ ...PIXEL, width: size[0] * zoom, maxWidth: "100%", cursor: "crosshair" }}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onPick([Math.round(((e.clientX - r.left) / r.width) * size[0]), Math.round(((e.clientY - r.top) / r.height) * size[1])]);
        }}
      />
      {points.map((p, i) => (
        <span key={i} title={p.label} style={{ position: "absolute", left: `${(p.at[0] / size[0]) * 100}%`, top: `${(p.at[1] / size[1]) * 100}%`, width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: 4, background: "#ffd600", border: "1px solid #000", pointerEvents: "none" }} />
      ))}
    </div>
  );
}

export function Message({ text, error }: { text: string | null; error?: boolean }) {
  if (!text) return null;
  return <p className={error ? "error" : "small"}>{text}</p>;
}
