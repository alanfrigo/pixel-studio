"use client";

import { useState } from "react";
import type { MapObjectPayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages } from "@/i18n/client";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { worldMessages } from "@/i18n/messages/world";
import { MapEditor } from "./map-editor";
import { errorText, fileOf, mediaUrl, PIXEL, review, uploadImage, type WorldCatalog } from "./world-client";

/**
 * Mapas (06 §montar a região): criar a partir de um tileset, importar objetos
 * com apoio/colisão/oclusão revisados e abrir o editor.
 */
export function MapsPanel({ projectId, catalog, refresh, initialMap }: { projectId: string; catalog: WorldCatalog; refresh: () => void; initialMap: string | null }) {
  const m = useMessages(worldMessages).maps;
  const w = useMessages(worldMessages).shared;
  const c = useMessages(commonMessages);
  const [open, setOpen] = useState<string | null>(initialMap);
  const [message, setMessage] = useState<string | null>(null);
  const tilesets = catalog.tilesets.flatMap(({ asset, revisions }) => revisions.filter((r) => r.status !== "rejected").map((r) => ({ asset, revision: r })));

  async function decideObject(asset: AssetView, revision: RevisionView, decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt(c.rejectReasonPrompt) ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <>
      {message && <p className="error">{message}</p>}
      <div className="grid2">
        <CreateMap projectId={projectId} tilesets={tilesets} onCreated={(id) => (refresh(), setOpen(id))} />
        <ImportObject projectId={projectId} refresh={refresh} />
      </div>
      <section>
        <h2>{m.title}</h2>
        {catalog.maps.length === 0 && <p className="muted small">{m.empty}</p>}
        <ul className="small">
          {catalog.maps.map(({ asset, revisions }) => (
            <li key={asset.id}>
              <button type="button" className={open === asset.id ? "" : "secondary"} onClick={() => setOpen(asset.id)}>
                {asset.name}
              </button>{" "}
              {m.revisions(revisions.length)}
              {asset.approvedRevisionId ? ` · ${w.activeRevision(revisions.find((r) => r.id === asset.approvedRevisionId)?.number)}` : ""}
            </li>
          ))}
        </ul>
        <h3 className="small">{m.mapObjects}</h3>
        <div className="row" style={{ alignItems: "flex-end" }}>
          {catalog.objects.flatMap(({ asset, revisions }) =>
            revisions.slice(0, 2).map((rev) => {
              const p = rev.payload as MapObjectPayload;
              const img = fileOf(rev, p.fileId);
              return (
                <div key={rev.id} className="small" style={{ textAlign: "center" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {img && <img src={mediaUrl(projectId, img.id)} alt={asset.name} className="pixel bg-checker" style={{ ...PIXEL, width: p.logicalSize[0] * 2 }} />}
                  <div>
                    {asset.name} r{rev.number} <span className={`badge state-${rev.status}`}>{labelOf(c.revisionStatus, rev.status)}</span>
                  </div>
                  <div className="muted">{m.objectInfo(p.supportPoint.join(","), p.collision.length)}</div>
                  {rev.status === "candidate" && (
                    <div className="row" style={{ justifyContent: "center" }}>
                      <button type="button" onClick={() => decideObject(asset, rev, "approve")}>
                        {c.approve}
                      </button>
                      <button type="button" className="secondary" onClick={() => decideObject(asset, rev, "reject")}>
                        {c.reject}
                      </button>
                    </div>
                  )}
                </div>
              );
            }),
          )}
        </div>
      </section>
      {open && <MapEditor key={open} projectId={projectId} assetId={open} onCatalogChange={refresh} onOpen={setOpen} />}
    </>
  );
}

function CreateMap({ projectId, tilesets, onCreated }: { projectId: string; tilesets: { asset: AssetView; revision: RevisionView }[]; onCreated: (assetId: string) => void }) {
  const m = useMessages(worldMessages).maps;
  const w = useMessages(worldMessages).shared;
  const c = useMessages(commonMessages);
  const [name, setName] = useState(m.createDefaultName);
  const [tileset, setTileset] = useState("");
  const [cols, setCols] = useState(12);
  const [rows, setRows] = useState(8);
  const [message, setMessage] = useState<string | null>(null);
  async function submit() {
    setMessage(null);
    try {
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/world/maps`, { method: "POST", json: { name, tilesetRevisionId: tileset, size: [cols, rows] } });
      onCreated(asset.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>{m.createTitle}</h2>
      <div className="row">
        <label>
          {w.name}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {m.tileset}
          <select value={tileset} onChange={(e) => setTileset(e.target.value)}>
            <option value="">—</option>
            {tilesets.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} ({asset.kind}, {labelOf(c.revisionStatus, revision.status)})
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.columns}
          <input type="number" min={1} max={128} value={cols} onChange={(e) => setCols(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          {m.rows}
          <input type="number" min={1} max={128} value={rows} onChange={(e) => setRows(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <button type="button" disabled={!tileset} onClick={submit}>
          {m.create}
        </button>
      </div>
      <p className="small muted">{m.createNote}</p>
      {message && <p className="error small">{message}</p>}
    </section>
  );
}

function ImportObject({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const m = useMessages(worldMessages).maps;
  const w = useMessages(worldMessages).shared;
  const locale = useLocale();
  const [size, setSize] = useState<[number, number] | null>(null);
  const [name, setName] = useState(m.objectDefaultName);
  const [support, setSupport] = useState("16,44");
  const [footprint, setFootprint] = useState("1,1");
  const [collision, setCollision] = useState("13,38,6,7");
  const [occlusion, setOcclusion] = useState("34");
  const [projection, setProjection] = useState("top_down");
  const [message, setMessage] = useState<string | null>(null);

  function pick(f: File | null) {
    setFile(f);
    setSize(null);
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      setSize([img.width, img.height]);
      // Sugestão: apoio no centro da base; o artista revisa (o tronco nem sempre está no meio).
      setSupport(`${Math.floor(img.width / 2)},${img.height - 1}`);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  }

  async function submit() {
    if (!file) return;
    setMessage(null);
    try {
      const nums = (s: string) => s.split(",").map((n) => Number(n.trim()));
      const uploadId = await uploadImage(projectId, file, file.name, locale);
      const res = await apiFetch<{ revision: RevisionView }>(`/projects/${projectId}/world/objects`, {
        method: "POST",
        json: {
          target: { name },
          object: {
            image: { from: "upload", uploadId },
            projection,
            supportPoint: nums(support),
            footprintCells: nums(footprint),
            collision: collision.trim() ? collision.split(";").map(nums) : [],
            occlusionAboveY: occlusion.trim() ? Number(occlusion) : null,
          },
        },
      });
      setMessage(m.objectPublished(name, res.revision.number));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>{m.importTitle}</h2>
      <p className="small muted">{m.importNote}</p>
      <div className="row">
        <input type="file" accept="image/png" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {size && <span className="small muted">{size.join("×")} px</span>}
        <label>
          {w.name}
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          {m.view}
          <select value={projection} onChange={(e) => setProjection(e.target.value)}>
            <option value="top_down">{m.projection.top_down}</option>
            <option value="three_quarter">{m.projection.three_quarter}</option>
            <option value="side">{m.projection.side}</option>
          </select>
        </label>
        <label>
          {m.supportXY}
          <input value={support} onChange={(e) => setSupport(e.target.value)} style={{ width: 70 }} />
        </label>
        <label>
          {m.footprint}
          <input value={footprint} onChange={(e) => setFootprint(e.target.value)} style={{ width: 50 }} />
        </label>
        <label>
          {m.collision}
          <input value={collision} onChange={(e) => setCollision(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          {m.occlusionAbove}
          <input value={occlusion} onChange={(e) => setOcclusion(e.target.value)} style={{ width: 60 }} />
        </label>
        <button type="button" disabled={!file} onClick={submit}>
          {m.import}
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
