"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Insets } from "@/contracts";
import { contentArea, nineSlice } from "@/domain/ui-geometry";
import { layoutText } from "@/domain/ui-screen";
import type { AssetView, RevisionView, UploadView } from "@/server/catalog/catalog";
import { useMessages } from "@/i18n/client";
import { commonMessages } from "@/i18n/messages/common";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { ApiError, apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { drawCaption } from "../render";

/**
 * Editor de componente de UI (07 §fluxo, cartão U2): estados na mesma célula,
 * guias de nine-slice e área de conteúdo, legenda separada da arte e prévia
 * em vários tamanhos com foco sobreposto ao hover.
 */

const STATES = ["normal", "hover", "pressed", "disabled"] as const;
type State = (typeof STATES)[number];
const ZOOM = 4;

const zero: Insets = { left: 0, right: 0, top: 0, bottom: 0 };

function useImage(src: string | null) {
  const [loaded, setLoaded] = useState<{ src: string; img: HTMLImageElement } | null>(null);
  useEffect(() => {
    if (!src) return;
    const i = new Image();
    i.onload = () => setLoaded({ src, img: i });
    i.src = src;
  }, [src]);
  return src && loaded?.src === src ? loaded.img : null;
}

/** Desenha o componente no tamanho pedido usando a mesma geometria do domínio. */
function drawComponent(ctx: CanvasRenderingContext2D, img: HTMLImageElement, insets: Insets | null, size: [number, number], x = 0, y = 0) {
  const src: [number, number] = [img.naturalWidth, img.naturalHeight];
  const pieces = insets ? nineSlice(src, insets, size) : [{ src: [0, 0, src[0], src[1]] as const, dst: [0, 0, size[0], size[1]] as const }];
  for (const p of pieces) ctx.drawImage(img, p.src[0], p.src[1], p.src[2], p.src[3], x + p.dst[0], y + p.dst[1], p.dst[2], p.dst[3]);
}

function InsetInputs({ label, value, onChange }: { label: string; value: Insets; onChange: (v: Insets) => void }) {
  const m = useMessages(uiKitMessages).editor;
  return (
    <div className="row small">
      <strong style={{ minWidth: 110 }}>{label}</strong>
      {(["left", "right", "top", "bottom"] as const).map((k) => (
        <label key={k} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {m.sides[k]}
          <input type="number" min={0} value={value[k]} style={{ width: 56 }} onChange={(e) => onChange({ ...value, [k]: Math.max(0, Number(e.target.value)) })} />
        </label>
      ))}
    </div>
  );
}

function Preview({
  img,
  focus,
  insets,
  padding,
  size,
  text,
}: {
  img: HTMLImageElement;
  focus: HTMLImageElement | null;
  insets: Insets | null;
  padding: Insets;
  size: [number, number];
  text: string;
}) {
  const m = useMessages(uiKitMessages).editor;
  const ref = useRef<HTMLCanvasElement>(null);
  const status = useMemo(() => {
    try {
      if (insets) nineSlice([img.naturalWidth, img.naturalHeight], insets, size);
      if (!text) return { fits: true, error: null };
      // Mesma medição da prévia do compositor e do salvar da tela (fonte de prévia embutida).
      const [, , cw, ch] = contentArea(size, padding);
      return { fits: !layoutText(text, [cw, ch], { wrap: "none", overflow: "report" }).overflow, error: null };
    } catch (err) {
      return { fits: false, error: err instanceof Error ? err.message : String(err) };
    }
  }, [img, insets, padding, size, text]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || status.error) return;
    const [w, h] = size;
    const off = document.createElement("canvas");
    off.width = w;
    off.height = h;
    const o = off.getContext("2d")!;
    drawComponent(o, img, insets, size);
    if (focus) drawComponent(o, focus, insets, size); // foco é sobreposição sobre o estado atual
    if (text) {
      const area = contentArea(size, padding);
      drawCaption(o, text, area, { wrap: "none", overflow: "report", align: "center", verticalAlign: "middle" }, "#f4f1e8");
    }
    canvas.width = w * ZOOM;
    canvas.height = h * ZOOM;
    const c = canvas.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, canvas.width, canvas.height);
    c.drawImage(off, 0, 0, w * ZOOM, h * ZOOM);
  }, [img, focus, insets, padding, size, text, status.error]);
  return (
    <div className="revision">
      <canvas ref={ref} className="pixel" />
      <span className="small">
        {size[0]}×{size[1]} {status.error ? <span className="error">· {status.error}</span> : text ? (status.fits ? `· ${m.captionFits}` : <span className="error">· {m.captionOverflows}</span>) : ""}
      </span>
    </div>
  );
}

function Guides({ img, insets, padding }: { img: HTMLImageElement; insets: Insets | null; padding: Insets }) {
  const m = useMessages(uiKitMessages).editor;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const z = 8;
    const [w, h] = [img.naturalWidth, img.naturalHeight];
    canvas.width = w * z;
    canvas.height = h * z;
    const c = canvas.getContext("2d")!;
    c.imageSmoothingEnabled = false;
    c.drawImage(img, 0, 0, w * z, h * z);
    const line = (x0: number, y0: number, x1: number, y1: number, color: string) => {
      c.strokeStyle = color;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x0 * z, y0 * z);
      c.lineTo(x1 * z, y1 * z);
      c.stroke();
    };
    if (insets) {
      for (const x of [insets.left, w - insets.right]) line(x, 0, x, h, "#00e5ff");
      for (const y of [insets.top, h - insets.bottom]) line(0, y, w, y, "#00e5ff");
    }
    c.setLineDash([6, 4]);
    c.strokeStyle = "#ffd600";
    c.lineWidth = 2;
    c.strokeRect(padding.left * z, padding.top * z, (w - padding.left - padding.right) * z, (h - padding.top - padding.bottom) * z);
  }, [img, insets, padding]);
  return <canvas ref={ref} className="pixel" title={m.guidesTitle} />;
}

export function UiEditor({ projectId, assetId }: { projectId: string; assetId: string }) {
  const m = useMessages(uiKitMessages).editor;
  const c = useMessages(commonMessages);
  const base = `/projects/${projectId}`;
  const [states, setStates] = useState<Partial<Record<State, string>>>({});
  const [focusUpload, setFocusUpload] = useState<string>("");
  const [insets, setInsets] = useState<Insets>({ left: 4, right: 4, top: 4, bottom: 4 });
  const [useNine, setUseNine] = useState(true);
  const [padding, setPadding] = useState<Insets>({ left: 7, right: 7, top: 5, bottom: 5 });
  const [textKey, setTextKey] = useState("inventory.use");
  const [sample, setSample] = useState(m.defaultSample);
  const [previewState, setPreviewState] = useState<State>("normal");
  const [showFocus, setShowFocus] = useState(false);
  const [custom, setCustom] = useState<[number, number]>([128, 32]);
  const [message, setMessage] = useState<string | null>(null);

  const { data, refresh: load } = usePoll(
    async () => {
      const [{ asset, revisions }, { uploads }] = await Promise.all([
        apiFetch<{ asset: AssetView; revisions: RevisionView[] }>(`${base}/assets/${assetId}`),
        apiFetch<{ uploads: UploadView[] }>(`${base}/uploads`),
      ]);
      return { asset, revisions, uploads: uploads.filter((u) => u.status === "ready" && u.modality === "raster") };
    },
    { active: () => false, slowMs: 30_000 },
  );
  const asset = data?.asset ?? null;
  const revisions = data?.revisions ?? [];
  const uploads = data?.uploads ?? [];

  const media = (id: string | undefined) => (id ? `/api/v1/projects/${projectId}/media/${id}` : null);
  const kind = asset?.kind === "panel" ? "panel" : "button";
  const stateImg = useImage(media(states[previewState] ?? states.normal));
  const normalImg = useImage(media(states.normal));
  const focusImg = useImage(focusUpload ? media(focusUpload) : null);
  const sizes = useMemo<[number, number][]>(() => {
    if (!normalImg) return [];
    const [w, h] = [normalImg.naturalWidth, normalImg.naturalHeight];
    return [[w, h], [w * 3, Math.round(h * 1.5)], custom];
  }, [normalImg, custom]);
  const activeInsets = useNine ? insets : null;

  async function publish() {
    setMessage(null);
    const ref = (uploadId: string) => ({ from: "upload" as const, uploadId });
    const component =
      kind === "panel"
        ? { kind: "panel", image: ref(states.normal!), nineSlice: insets, contentPadding: padding }
        : {
            kind: "button",
            states: STATES.filter((s) => states[s]).map((s) => ({ state: s, image: ref(states[s]!) })),
            focus: focusUpload ? { mode: "overlay", image: ref(focusUpload) } : null,
            nineSlice: activeInsets,
            contentPadding: padding,
            text: sample ? { key: textKey, sample } : null,
            accessibleName: sample ? null : asset?.name ?? null,
          };
    try {
      const { revision } = await apiFetch<{ revision: RevisionView }>(`${base}/assets/${assetId}/revisions`, { method: "POST", json: { from: "ui_component", component } });
      setMessage(m.published(revision.number));
      load();
    } catch (err) {
      const issues = err instanceof ApiError ? (err.details?.issues as { path: string[]; message: string }[] | undefined) : undefined;
      setMessage(issues?.length ? issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ") : String(err instanceof Error ? err.message : err));
    }
  }

  if (!asset) return <p className="muted">{c.loading}</p>;
  const uploadOptions = (
    <>
      <option value="">—</option>
      {uploads.map((u) => (
        <option key={u.id} value={u.id}>
          {u.originalName} ({String(u.metadata?.width)}×{String(u.metadata?.height)})
        </option>
      ))}
    </>
  );

  return (
    <>
      <h1>
        {asset.name} <span className="muted small">ui/{asset.kind} · {m.revisions(revisions.length)}</span> <Link className="small" href={`/projects/${projectId}/ui?tab=components`}>{m.kitLink}</Link>
      </h1>
      <div className="grid2">
        <section>
          <h2>{m.images}</h2>
          <p className="muted small">{m.imagesHelp}</p>
          {(kind === "panel" ? (["normal"] as const) : STATES).map((s) => (
            <label key={s}>
              {kind === "panel" ? m.panel : m.state(s)}
              <select value={states[s] ?? ""} onChange={(e) => setStates({ ...states, [s]: e.target.value || undefined })}>
                {uploadOptions}
              </select>
            </label>
          ))}
          {kind === "button" && (
            <label>
              {m.focus}
              <select value={focusUpload} onChange={(e) => setFocusUpload(e.target.value)}>
                {uploadOptions}
              </select>
            </label>
          )}
        </section>
        <section>
          <h2>{m.guides}</h2>
          <label style={{ flexDirection: "row", alignItems: "center", gap: 6, color: "inherit" }}>
            <input type="checkbox" checked={useNine} disabled={kind === "panel"} onChange={(e) => setUseNine(e.target.checked)} /> {m.resizable}
          </label>
          {useNine && <InsetInputs label={m.cuts} value={insets} onChange={setInsets} />}
          <InsetInputs label={m.captionArea} value={padding} onChange={setPadding} />
          {kind === "button" && (
            <div className="row" style={{ marginTop: 8 }}>
              <label>
                {m.textKey}
                <input value={textKey} onChange={(e) => setTextKey(e.target.value)} />
              </label>
              <label>
                {m.sample}
                <input value={sample} onChange={(e) => setSample(e.target.value)} />
              </label>
            </div>
          )}
          {normalImg && <Guides img={normalImg} insets={activeInsets ?? zero} padding={padding} />}
        </section>
      </div>
      <section>
        <h2>{m.preview}</h2>
        <div className="row">
          {kind === "button" &&
            STATES.map((s) => (
              <label key={s} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
                <input type="radio" checked={previewState === s} onChange={() => setPreviewState(s)} disabled={!states[s]} />
                {s}
              </label>
            ))}
          {kind === "button" && (
            <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
              <input type="checkbox" checked={showFocus} disabled={!focusUpload} onChange={(e) => setShowFocus(e.target.checked)} /> {m.focusToggle}
            </label>
          )}
          <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            {m.free}
            <input type="number" value={custom[0]} min={1} style={{ width: 64 }} onChange={(e) => setCustom([Number(e.target.value), custom[1]])} />×
            <input type="number" value={custom[1]} min={1} style={{ width: 64 }} onChange={(e) => setCustom([custom[0], Number(e.target.value)])} />
          </label>
        </div>
        <div className="revisions">
          {stateImg &&
            sizes.map((s) => (
              <Preview key={s.join("x")} img={stateImg} focus={showFocus ? focusImg : null} insets={activeInsets} padding={padding} size={s} text={kind === "button" ? sample : ""} />
            ))}
          {!stateImg && <p className="muted">{m.chooseNormal}</p>}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button disabled={!states.normal} onClick={publish}>
            {m.publish}
          </button>
          {message && <span className="small">{message}</span>}
        </div>
      </section>
    </>
  );
}
