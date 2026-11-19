"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { MeterPayload } from "@/contracts";
import { meterFillRegion } from "@/domain/ui-screen";
import type { RevisionView } from "@/server/catalog/catalog";
import { useMessages } from "@/i18n/client";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { apiFetch } from "@/app/client/api";
import { Card, ReviewBar } from "./kit-shared";
import { loadImage } from "./render";
import { approvedRevisions, errorText, fileUrl, PIXEL, type UiCatalog, uiApi } from "./ui-client";

export function ComponentsPanel({ projectId, catalog, refresh }: { projectId: string; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).components;
  return (
    <>
      <MenuItemForm projectId={projectId} catalog={catalog} refresh={refresh} />
      <section>
        <h2>{m.title}</h2>
        <p className="muted small">{m.help}</p>
        {catalog.components.length === 0 && <p className="muted">{m.none}</p>}
        {catalog.components.map((entry) => (
          <div key={entry.asset.id} style={{ marginBottom: 12 }}>
            <h3 className="small">
              {entry.asset.name} <span className="muted">ui/{entry.asset.kind}</span>{" "}
              {(entry.asset.kind === "button" || entry.asset.kind === "panel") && <Link href={`/projects/${projectId}/ui/${entry.asset.id}`}>{m.openEditor}</Link>}
            </h3>
            <div className="row" style={{ alignItems: "flex-start" }}>
              {entry.revisions.slice(0, 3).map((revision) => (
                <Card key={revision.id}>
                  {entry.asset.kind === "meter" ? <MeterPreview projectId={projectId} revision={revision} /> : <Thumb projectId={projectId} kind={entry.asset.kind} revision={revision} catalog={catalog} />}
                  <ReviewBar projectId={projectId} asset={entry.asset} revision={revision} refresh={refresh} />
                </Card>
              ))}
            </div>
          </div>
        ))}
      </section>
    </>
  );
}

function Thumb({ projectId, kind, revision, catalog }: { projectId: string; kind: string; revision: RevisionView; catalog: UiCatalog }) {
  const m = useMessages(uiKitMessages).components;
  const p = revision.payload as { states?: { fileId: string }[]; image?: { fileId: string }; buttonRevisionId?: string; actionId?: string; text?: { key: string; sample: string }; shortcut?: string | null };
  if (kind === "menu_item") {
    const button = catalog.components.flatMap((e) => e.revisions).find((r) => r.id === p.buttonRevisionId);
    const key = (button?.payload as { states?: { fileId: string }[] } | undefined)?.states?.[0]?.fileId;
    return (
      <div className="small">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {button && key && <img src={fileUrl(projectId, button, key) ?? ""} alt="" className="pixel bg-checker" style={{ ...PIXEL, height: 42 }} />}
        <div>{m.menuItemSummary(p.actionId ?? "", p.text?.key ?? "", p.text?.sample ?? "", p.shortcut ?? "—")}</div>
      </div>
    );
  }
  const key = p.states?.[0]?.fileId ?? p.image?.fileId;
  const src = key ? fileUrl(projectId, revision, key) : null;
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} alt="" className="pixel bg-checker" style={{ ...PIXEL, height: 64 }} /> : null;
}

/** Barra com trilho, preenchimento recortado (arredondado para baixo) e moldura inteira; o valor muda sem gerar nada. */
function MeterPreview({ projectId, revision }: { projectId: string; revision: RevisionView }) {
  const m = useMessages(uiKitMessages).components;
  const parsed = MeterPayload.safeParse(revision.payload);
  const meter = parsed.success ? parsed.data : null;
  const [value, setValue] = useState(meter ? meter.range.max * 0.25 : 0);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!meter) return;
    let alive = true;
    const urls = [meter.track.fileId, meter.fill.fileId, meter.frame.fileId].map((k) => fileUrl(projectId, revision, k) ?? "");
    Promise.all(urls.map(loadImage)).then(([track, fill, frame]) => {
      const canvas = ref.current;
      if (!alive || !canvas) return;
      const zoom = 4;
      const [w, h] = meter.logicalSize;
      canvas.width = w * zoom;
      canvas.height = h * zoom;
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const o = off.getContext("2d")!;
      o.drawImage(track!, ...meter.track.rect, 0, 0, meter.track.rect[2], meter.track.rect[3]);
      const region = meterFillRegion(meter, value);
      if (region) o.drawImage(fill!, ...region.src, ...region.dst);
      o.drawImage(frame!, ...meter.frame.rect, 0, 0, meter.frame.rect[2], meter.frame.rect[3]);
      const c = canvas.getContext("2d")!;
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, canvas.width, canvas.height);
      c.drawImage(off, 0, 0, w * zoom, h * zoom);
    });
    return () => {
      alive = false;
    };
  }, [meter, projectId, revision, value]);
  if (!meter) return null;
  const region = meterFillRegion(meter, value);
  return (
    <div className="small">
      <canvas ref={ref} className="pixel bg-checker" />
      <label>
        {m.meterValue(Math.round(value), meter.range.min, meter.range.max, region?.dst[2] ?? 0)}
        <input type="range" min={meter.range.min} max={meter.range.max} value={value} onChange={(e) => setValue(Number(e.target.value))} />
      </label>
      <div className="row">
        {[0, 25, 100].map((v) => (
          <button key={v} type="button" className="secondary" onClick={() => setValue(meter.range.min + ((meter.range.max - meter.range.min) * v) / 100)}>
            {v}%
          </button>
        ))}
      </div>
    </div>
  );
}

function MenuItemForm({ projectId, catalog, refresh }: { projectId: string; catalog: UiCatalog; refresh: () => void }) {
  const m = useMessages(uiKitMessages).components;
  const buttons = approvedRevisions(catalog.components, ["button"]);
  const icons = catalog.images.filter((i) => i.family === "item");
  const [button, setButton] = useState("");
  const [icon, setIcon] = useState("");
  const [actionId, setActionId] = useState("continue");
  const [key, setKey] = useState("menu.continue");
  const [sample, setSample] = useState(m.defaultSample);
  const [shortcut, setShortcut] = useState("Enter");
  const [selectable, setSelectable] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    setMessage(null);
    try {
      const res = await apiFetch<{ revision: { number: number }; warnings: unknown[] }>(uiApi(projectId, "/menu-items"), {
        method: "POST",
        json: { name: sample, buttonRevisionId: button, iconRevisionId: icon || null, actionId, text: { key, sample }, shortcut: shortcut || null, selectable },
      });
      setMessage(m.menuItemDone(res.revision.number));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.menuTitle}</h2>
      <p className="muted small">{m.menuHelp}</p>
      <div className="row">
        <label>
          {m.button}
          <select value={button} onChange={(e) => setButton(e.target.value)}>
            <option value="">—</option>
            {buttons.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.icon}
          <select value={icon} onChange={(e) => setIcon(e.target.value)}>
            <option value="">{m.noIcon}</option>
            {icons.map((i) => (
              <option key={i.revisionId} value={i.revisionId}>
                {i.assetName} r{i.number}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.action}
          <input value={actionId} onChange={(e) => setActionId(e.target.value)} />
        </label>
        <label>
          {m.textKey}
          <input value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label>
          {m.sample}
          <input value={sample} onChange={(e) => setSample(e.target.value)} />
        </label>
        <label>
          {m.shortcut}
          <input value={shortcut} style={{ width: 80 }} onChange={(e) => setShortcut(e.target.value)} />
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
          <input type="checkbox" checked={selectable} onChange={(e) => setSelectable(e.target.checked)} /> {m.selectable}
        </label>
        <button type="button" onClick={submit} disabled={!button}>
          {m.createMenuItem}
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
