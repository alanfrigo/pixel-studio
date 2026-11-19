"use client";

import { useEffect, useRef, useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import { type Locale, type TextValue } from "@/i18n/locales";
import { animationMessages } from "@/i18n/messages/animation";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { clipFrameLayers, DIRS, errorText, estimateText, type PlanPreview, review, type RunResult, viewUrl } from "./shared";

/**
 * Peças de interface do cartão S3: quadro composto por camadas, escolha de
 * vistas com lacunas explícitas, prévia de plano (rota, custo, capacidades e
 * prompt) e ações de revisão. Tudo publica candidatas; aprovar segue o fluxo
 * de revisão existente.
 */

export type RunFn = (plan: Record<string, unknown>) => Promise<RunResult | null>;

/** Um quadro do clipe composto pelas suas camadas, em zoom inteiro. */
export function FrameThumb({ projectId, revision, index, zoom = 2, selected, onClick, title }: { projectId: string; revision: RevisionView; index: number; zoom?: number; selected?: boolean; onClick?: () => void; title?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const clip = revision.payload as ClipPayload;
  const [w, h] = clip.logicalSize;
  useEffect(() => {
    const layers = clipFrameLayers(projectId, revision)[index] ?? [];
    const c = ref.current;
    if (!c) return;
    c.width = w * zoom;
    c.height = h * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    let alive = true;
    const imgs = layers.map((l) => {
      const img = new Image();
      img.src = l.src;
      return img;
    });
    Promise.all(imgs.map((img) => img.decode().catch(() => undefined))).then(() => {
      if (!alive) return;
      ctx.clearRect(0, 0, c.width, c.height);
      layers.forEach((l, i) => {
        const [rx, ry, rw, rh] = l.rect;
        if (imgs[i]!.naturalWidth) ctx.drawImage(imgs[i]!, rx, ry, rw, rh, l.offset[0] * zoom, l.offset[1] * zoom, rw * zoom, rh * zoom);
      });
    });
    return () => {
      alive = false;
    };
  }, [projectId, revision, index, zoom, w, h]);
  return <canvas ref={ref} className={`pixel bg-checker anim-frame${selected ? " selected" : ""}`} title={title} onClick={onClick} />;
}

export function PlanPreviewBox({ preview }: { preview: PlanPreview & { summary: Record<string, unknown> } }) {
  const sh = useMessages(animationMessages).shared;
  const locale = useLocale();
  const text = useText();
  const sheet = (preview.plan.params as { sheet?: { columns: number; rows: number; backgroundKey: string | null } }).sheet;
  const note = (preview.summary as { note?: TextValue; keepFirstFrameNote?: TextValue; costNote?: TextValue }) ?? {};
  return (
    <div className="small anim-plan">
      <p>
        <strong className={preview.route.strategy === "native" ? "" : "anim-sheet"}>{text(preview.route.label)}</strong> · {sh.plan.destination(preview.destination.name)}
        {preview.destination.simulated ? sh.simulated : ""} · {sh.plan.estimate(estimateText(preview.plan, locale))} · {sh.plan.capabilities(preview.plan.requiredCapabilities.join(", "))}
        {sheet ? sh.plan.sheet(sheet.columns, sheet.rows, Boolean(sheet.backgroundKey)) : ""}
      </p>
      {[note.note, note.keepFirstFrameNote, note.costNote].filter(Boolean).map((n, i) => (
        <p key={i} className="muted">
          {text(n)}
        </p>
      ))}
      {preview.plan.prompt.compiled && <pre>{preview.plan.prompt.compiled}</pre>}
    </div>
  );
}

/** Prévia + gerar com o mesmo plano; mensagens de erro estruturadas visíveis. */
export function PlanActions({ projectId, plan, run, disabled, label }: { projectId: string; plan: Record<string, unknown> | null; run: RunFn; disabled?: boolean; label?: string }) {
  const sh = useMessages(animationMessages).shared;
  const [preview, setPreview] = useState<(PlanPreview & { summary: Record<string, unknown> }) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Mudou a entrada: a prévia anterior não vale mais.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreview(null);
  }, [JSON.stringify(plan)]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={!plan || disabled || busy}
          onClick={async () => {
            setMessage(null);
            try {
              setPreview(await apiFetch(`/projects/${projectId}/generation-plans`, { method: "POST", json: plan }));
            } catch (err) {
              setPreview(null);
              setMessage(errorText(err));
            }
          }}
        >
          {sh.planPreview}
        </button>
        <button
          type="button"
          disabled={!plan || disabled || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await run(plan!);
            } catch {
              /* mensagem já exibida pela página */
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? sh.sending : (label ?? sh.generate)}
        </button>
      </div>
      {message && <p className="small error">{message}</p>}
      {preview && <PlanPreviewBox preview={preview} />}
    </div>
  );
}

/** Aprovar/reprovar uma revisão candidata pelo fluxo de revisão. */
export function ReviewButtons({ projectId, assetId, revision, activeRevisionId, onChanged }: { projectId: string; assetId: string; revision: RevisionView; activeRevisionId: string | null; onChanged: () => void }) {
  const sh = useMessages(animationMessages).shared;
  const c = useMessages(commonMessages);
  const [message, setMessage] = useState<string | null>(null);
  if (revision.status !== "candidate") return <span className={`badge state-${revision.status}`}>{labelOf(c.revisionStatus, revision.status)}</span>;
  return (
    <span className="row">
      <button
        type="button"
        onClick={async () => {
          try {
            await review(projectId, assetId, revision.id, "approve", activeRevisionId);
            onChanged();
          } catch (err) {
            setMessage(errorText(err));
          }
        }}
      >
        {sh.approveRev(revision.number)}
      </button>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          const reason = window.prompt(c.rejectReasonPrompt);
          if (!reason) return;
          try {
            await review(projectId, assetId, revision.id, "reject", activeRevisionId, reason);
            onChanged();
          } catch (err) {
            setMessage(errorText(err));
          }
        }}
      >
        {c.reject}
      </button>
      {message && <span className="small error">{message}</span>}
    </span>
  );
}

/**
 * Aprovação parcial por vista: só as marcadas entram na revisão publicada; as
 * desmarcadas viram lacunas explícitas com motivo (não disparam lote novo).
 */
export function ViewPicker({ projectId, revision, onPublished }: { projectId: string; revision: RevisionView; onPublished: (revisionId: string) => void }) {
  const am = useMessages(animationMessages);
  const t = am.temporalUi;
  const c = useMessages(commonMessages);
  const text = useText();
  const views = (revision.payload as BasePayload).views;
  const [keep, setKeep] = useState<Record<string, boolean>>(() => Object.fromEntries(views.map((v) => [v.direction, true])));
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const kept = views.filter((v) => keep[v.direction]).map((v) => v.direction);
  const rejected = views.filter((v) => !keep[v.direction]).map((v) => ({ direction: v.direction, reason: reasons[v.direction]?.trim() || t.defaultGapReason }));
  return (
    <div className="anim-views">
      {views.map((v) => (
        <div key={v.direction} className={`anim-view${keep[v.direction] ? "" : " missing"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="pixel bg-checker" alt={am.shared.viewAlt(v.direction)} src={viewUrl(projectId, revision, v.direction)!} width={64} height={64} />
          <label className="small">
            <input type="checkbox" checked={keep[v.direction]} onChange={(e) => setKeep((k) => ({ ...k, [v.direction]: e.target.checked }))} /> {v.direction} · {c.directions[v.direction]}
          </label>
          {!keep[v.direction] && <input className="small" placeholder={t.gapReasonPlaceholder} value={reasons[v.direction] ?? ""} onChange={(e) => setReasons((r) => ({ ...r, [v.direction]: e.target.value }))} />}
        </div>
      ))}
      <div>
        <button
          type="button"
          disabled={kept.length === 0 || kept.length === views.length}
          onClick={async () => {
            setMessage(null);
            try {
              const res = await apiFetch<{ revision: RevisionView; gaps: { direction: string; reason: TextValue }[] }>(`/projects/${projectId}/animation/states`, { method: "POST", json: { revisionId: revision.id, keep: kept, reject: rejected } });
              setMessage(t.published(res.revision.number, kept.join(", "), res.gaps.map((g) => `${g.direction} (${text(g.reason)})`).join(", ") || c.none));
              onPublished(res.revision.id);
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          {t.publishChecked}
        </button>
        {message && <p className="small">{message}</p>}
      </div>
    </div>
  );
}

export function DirectionChecks({ available, value, onChange, disabledHint }: { available: Direction[]; value: Direction[]; onChange: (d: Direction[]) => void; disabledHint?: string }) {
  const t = useMessages(animationMessages).temporalUi;
  const c = useMessages(commonMessages);
  return (
    <div className="row small">
      {DIRS.map((d) => (
        <label key={d} style={{ flexDirection: "row", alignItems: "center", gap: 2 }} title={available.includes(d) ? c.directions[d] : (disabledHint ?? t.noViewInSource)}>
          <input type="checkbox" disabled={!available.includes(d)} checked={value.includes(d)} onChange={(e) => onChange(e.target.checked ? [...value, d] : value.filter((x) => x !== d))} /> {d}
        </label>
      ))}
    </div>
  );
}

/** Pincel de máscara sobre o quadro: branco = editar, preto = proteger (convenção interna 255/0). */
export function MaskPainter({ width, height, background, zoom, onChange }: { width: number; height: number; background: React.ReactNode; zoom: number; onChange: (mask: Uint8Array | null) => void }) {
  const t = useMessages(animationMessages).temporalUi;
  const ref = useRef<HTMLCanvasElement>(null);
  const mask = useRef(new Uint8Array(width * height));
  const [brush, setBrush] = useState(3);
  const [erase, setErase] = useState(false);
  const drawing = useRef(false);
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ref.current!;
    const rect = c.getBoundingClientRect();
    const cx = Math.floor(((e.clientX - rect.left) / rect.width) * width);
    const cy = Math.floor(((e.clientY - rect.top) / rect.height) * height);
    const r = Math.floor(brush / 2);
    for (let y = cy - r; y <= cy - r + brush - 1; y++) for (let x = cx - r; x <= cx - r + brush - 1; x++) if (x >= 0 && y >= 0 && x < width && y < height) mask.current[y * width + x] = erase ? 0 : 255;
    redraw();
  };
  const redraw = () => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "rgba(255, 0, 170, 0.45)";
    for (let i = 0; i < mask.current.length; i++) if (mask.current[i]) ctx.fillRect((i % width) * zoom, Math.floor(i / width) * zoom, zoom, zoom);
    const edited = mask.current.reduce((a, v) => a + (v ? 1 : 0), 0);
    onChange(edited ? mask.current.slice() : null);
  };
  return (
    <div>
      <div className="anim-mask" style={{ width: width * zoom, height: height * zoom }}>
        {background}
        <canvas
          ref={ref}
          width={width * zoom}
          height={height * zoom}
          onPointerDown={(e) => ((drawing.current = true), paint(e))}
          onPointerMove={(e) => drawing.current && paint(e)}
          onPointerUp={() => (drawing.current = false)}
          onPointerLeave={() => (drawing.current = false)}
        />
      </div>
      <div className="row small">
        <label>
          {t.brush}
          <select value={brush} onChange={(e) => setBrush(Number(e.target.value))}>
            {[1, 2, 3, 5, 8].map((b) => (
              <option key={b} value={b}>
                {b}px
              </option>
            ))}
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={erase} onChange={(e) => setErase(e.target.checked)} /> {t.eraser}
        </label>
        <button type="button" className="secondary" onClick={() => ((mask.current = new Uint8Array(width * height)), redraw())}>
          {t.clearMask}
        </button>
      </div>
    </div>
  );
}

/** PNG preto/branco opaco da máscara (255 edita, 0 protege). */
export async function maskToPng(mask: Uint8Array, w: number, h: number, locale: Locale): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const data = new ImageData(w, h);
  for (let i = 0; i < mask.length; i++) data.data.set([mask[i]!, mask[i]!, mask[i]!, 255], i * 4);
  canvas.getContext("2d")!.putImageData(data, 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(animationMessages[locale].shared.pngFailed))), "image/png"));
}
