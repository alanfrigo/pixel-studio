"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { workspaceMessages } from "@/i18n/messages/workspace";

export type PreviewBg = "checker" | "dark" | "light";

interface Side {
  label: string;
  src: string;
}

function loadPixels(src: string, failed: (src: string) => string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    img.onerror = () => reject(new Error(failed(src)));
    img.src = src;
  });
}

function Pixels({ data, zoom, bg, title }: { data: ImageData; zoom: number; bg: PreviewBg; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    canvas.width = data.width * zoom;
    canvas.height = data.height * zoom;
    const off = document.createElement("canvas");
    off.width = data.width;
    off.height = data.height;
    off.getContext("2d")!.putImageData(data, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
  }, [data, zoom]);
  return <canvas ref={ref} className={`pixel bg-${bg}`} title={title} />;
}

/**
 * Comparador de duas revisões (U1): lado a lado na mesma escala inteira e
 * mapa dos pixels que mudaram (RGBA exato), para revisar uma variação.
 */
export function RevisionCompare({ a, b, zoom, bg, onClose }: { a: Side; b: Side; zoom: number; bg: PreviewBg; onClose?: () => void }) {
  const locale = useLocale();
  const m = useMessages(workspaceMessages).compare;
  const c = useMessages(commonMessages);
  const loadFailed = m.loadFailed;
  const [state, setState] = useState<{ key: string; a: ImageData; b: ImageData; diff: ImageData | null; changed: number } | { key: string; error: string } | null>(null);
  const key = `${a.src}|${b.src}`;
  useEffect(() => {
    let alive = true;
    Promise.all([loadPixels(a.src, loadFailed), loadPixels(b.src, loadFailed)])
      .then(([pa, pb]) => {
        if (!alive) return;
        if (pa.width !== pb.width || pa.height !== pb.height) return setState({ key, a: pa, b: pb, diff: null, changed: -1 });
        const diff = new ImageData(pa.width, pa.height);
        let changed = 0;
        for (let i = 0; i < pa.data.length; i += 4) {
          const same = pa.data[i] === pb.data[i] && pa.data[i + 1] === pb.data[i + 1] && pa.data[i + 2] === pb.data[i + 2] && pa.data[i + 3] === pb.data[i + 3];
          if (!same) changed++;
          // Mudou: vermelho; igual: a revisão A esmaecida.
          diff.data.set(same ? [pa.data[i]!, pa.data[i + 1]!, pa.data[i + 2]!, Math.round(pa.data[i + 3]! * 0.25)] : [230, 40, 40, 255], i);
        }
        setState({ key, a: pa, b: pb, diff, changed });
      })
      .catch((err: Error) => alive && setState({ key, error: err.message }));
    return () => {
      alive = false;
    };
  }, [a.src, b.src, key, loadFailed]);

  const current = state?.key === key ? state : null;
  return (
    <div className="compare">
      <div className="row">
        <strong>{m.title}</strong>
        <span className="small muted">
          {a.label} × {b.label}
        </span>
        {onClose && (
          <button type="button" className="secondary" onClick={onClose}>
            {c.close}
          </button>
        )}
      </div>
      {!current && <p className="muted small">{c.loading}</p>}
      {current && "error" in current && <p className="error small">{current.error}</p>}
      {current && !("error" in current) && (
        <>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <figure>
              <Pixels data={current.a} zoom={zoom} bg={bg} title={a.label} />
              <figcaption className="small">{a.label} · {current.a.width}×{current.a.height}</figcaption>
            </figure>
            <figure>
              <Pixels data={current.b} zoom={zoom} bg={bg} title={b.label} />
              <figcaption className="small">{b.label} · {current.b.width}×{current.b.height}</figcaption>
            </figure>
            {current.diff && (
              <figure>
                <Pixels data={current.diff} zoom={zoom} bg={bg} title={m.changedTitle} />
                <figcaption className="small">{m.diff}</figcaption>
              </figure>
            )}
          </div>
          <p className="small">
            {current.changed < 0
              ? m.sizeDiffers
              : current.changed === 0
                ? m.identical
                : m.changed(
                    current.changed,
                    current.a.width * current.a.height,
                    new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format((100 * current.changed) / (current.a.width * current.a.height)),
                  )}
          </p>
        </>
      )}
    </div>
  );
}
