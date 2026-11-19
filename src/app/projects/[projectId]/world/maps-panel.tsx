"use client";

import { useState } from "react";
import type { MapObjectPayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { MapEditor } from "./map-editor";
import { errorText, fileOf, mediaUrl, PIXEL, review, uploadImage, type WorldCatalog } from "./world-client";

/**
 * Mapas (06 §montar a região): criar a partir de um tileset, importar objetos
 * com apoio/colisão/oclusão revisados e abrir o editor.
 */
export function MapsPanel({ projectId, catalog, refresh, initialMap }: { projectId: string; catalog: WorldCatalog; refresh: () => void; initialMap: string | null }) {
  const [open, setOpen] = useState<string | null>(initialMap);
  const [message, setMessage] = useState<string | null>(null);
  const tilesets = catalog.tilesets.flatMap(({ asset, revisions }) => revisions.filter((r) => r.status !== "rejected").map((r) => ({ asset, revision: r })));

  async function decideObject(asset: AssetView, revision: RevisionView, decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt("Motivo da reprovação") ?? "").trim() || null : null;
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
        <h2>Mapas</h2>
        {catalog.maps.length === 0 && <p className="muted small">Nenhum mapa ainda.</p>}
        <ul className="small">
          {catalog.maps.map(({ asset, revisions }) => (
            <li key={asset.id}>
              <button type="button" className={open === asset.id ? "" : "secondary"} onClick={() => setOpen(asset.id)}>
                {asset.name}
              </button>{" "}
              {revisions.length} revisão(ões){asset.approvedRevisionId ? ` · ativa r${revisions.find((r) => r.id === asset.approvedRevisionId)?.number}` : ""}
            </li>
          ))}
        </ul>
        <h3 className="small">Objetos de mapa</h3>
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
                    {asset.name} r{rev.number} <span className={`badge state-${rev.status}`}>{rev.status}</span>
                  </div>
                  <div className="muted">
                    apoio {p.supportPoint.join(",")} · {p.collision.length} colisão(ões)
                  </div>
                  {rev.status === "candidate" && (
                    <div className="row" style={{ justifyContent: "center" }}>
                      <button type="button" onClick={() => decideObject(asset, rev, "approve")}>
                        Aprovar
                      </button>
                      <button type="button" className="secondary" onClick={() => decideObject(asset, rev, "reject")}>
                        Reprovar
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
  const [name, setName] = useState("Clareira 12×8");
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
      <h2>Novo mapa</h2>
      <div className="row">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Tileset
          <select value={tileset} onChange={(e) => setTileset(e.target.value)}>
            <option value="">—</option>
            {tilesets.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} ({asset.kind}, {revision.status})
              </option>
            ))}
          </select>
        </label>
        <label>
          Colunas
          <input type="number" min={1} max={128} value={cols} onChange={(e) => setCols(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <label>
          Linhas
          <input type="number" min={1} max={128} value={rows} onChange={(e) => setRows(Number(e.target.value))} style={{ width: 70 }} />
        </label>
        <button type="button" disabled={!tileset} onClick={submit}>
          Criar
        </button>
      </div>
      <p className="small muted">O mapa guarda a grade lógica de terreno, a regra resolvida, objetos, colisões, regiões e portas; não é uma imagem achatada.</p>
      {message && <p className="error small">{message}</p>}
    </section>
  );
}

function ImportObject({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [name, setName] = useState("Árvore");
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
      const uploadId = await uploadImage(projectId, file, file.name);
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
      setMessage(`${name} r${res.revision.number} publicado como candidato`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>Importar objeto de mapa</h2>
      <p className="small muted">Apoio em px da imagem (pousa no centro do footprint); colisão em retângulos x,y,w,h separados por “;” (ex.: só o tronco); a copa acima da linha de oclusão cobre o personagem.</p>
      <div className="row">
        <input type="file" accept="image/png" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
        {size && <span className="small muted">{size.join("×")} px</span>}
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          Vista
          <select value={projection} onChange={(e) => setProjection(e.target.value)}>
            <option value="top_down">top-down</option>
            <option value="three_quarter">três-quartos</option>
            <option value="side">lateral</option>
          </select>
        </label>
        <label>
          Apoio x,y
          <input value={support} onChange={(e) => setSupport(e.target.value)} style={{ width: 70 }} />
        </label>
        <label>
          Footprint
          <input value={footprint} onChange={(e) => setFootprint(e.target.value)} style={{ width: 50 }} />
        </label>
        <label>
          Colisão
          <input value={collision} onChange={(e) => setCollision(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          Oclusão acima de y
          <input value={occlusion} onChange={(e) => setOcclusion(e.target.value)} style={{ width: 60 }} />
        </label>
        <button type="button" disabled={!file} onClick={submit}>
          Importar
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
