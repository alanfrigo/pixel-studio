"use client";

import Link from "next/link";
import { useState } from "react";
import type { RoomPayload } from "@/contracts";
import { type KitKey, proposeMaskOrder } from "@/domain/scenes/room-map";
import { apiFetch } from "@/app/client/api";
import { errorText, flatRevisions, mediaUrl, PIXEL, type ScenesCatalog, scenesApi, SIDES } from "./scenes-client";
import { Message } from "./shared";

/**
 * Kit → mapa editável (06 §demonstrações: "mapear paredes/cantos/portas e
 * remontar um trecho editável"). O kit é local: a própria imagem da sala,
 * cortada pela grade declarada; cada célula recebe uma chave (máscara
 * piso/parede 0–15, porta ou ignorar) e vira tileset por cantos do T1. A sala
 * é remontada no editor de mapas do T1 com entradas, móveis, apoio, footprint
 * e colisão.
 */

interface Inspected {
  sheets: { sheetId: string; name: string; mediaId: string | null; size: [number, number]; source: "picture" }[];
  grid: { cellPx: [number, number]; gridOrigin: [number, number] };
  projection: RoomPayload["projection"];
}

const keyLabel = (k: KitKey | undefined) => (!k || k.kind === "ignore" ? "·" : k.kind === "mask" ? String(k.mask) : `P${k.side}`);

export function KitPanel({ projectId, catalog, refresh }: { projectId: string; catalog: ScenesCatalog; refresh: () => void }) {
  const rooms = flatRevisions(catalog.rooms, (r) => r.status === "approved");
  const [roomId, setRoomId] = useState("");
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [sheetId, setSheetId] = useState("");
  const [origin, setOrigin] = useState<[number, number]>([0, 0]);
  const [cell, setCell] = useState<[number, number]>([32, 32]);
  const [spacing, setSpacing] = useState(0);
  const [keys, setKeys] = useState<KitKey[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("Kit da sala");
  const [mapped, setMapped] = useState<{ tileset: { id: string }; missing: number[]; complete: boolean; doors: { side: string; revision: { id: string } }[] } | null>(null);
  const [mapResult, setMapResult] = useState<{ openUrl: string; passages: { from: string; to: string; connected: boolean }[] } | null>(null);
  const [tilesetId, setTilesetId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const entry = rooms.find((r) => r.revision.id === roomId);
  const room = entry?.revision.payload as RoomPayload | undefined;
  const sheet = inspected?.sheets.find((s) => s.sheetId === sheetId);
  const rects: [number, number, number, number][] = [];
  if (sheet) for (let y = origin[1]; y + cell[1] <= sheet.size[1]; y += cell[1] + spacing) for (let x = origin[0]; x + cell[0] <= sheet.size[0]; x += cell[0] + spacing) rects.push([x, y, cell[0], cell[1]]);
  const zoom = sheet ? Math.max(1, Math.floor(512 / Math.max(...sheet.size))) : 1;

  async function inspect(id: string) {
    setRoomId(id);
    setInspected(null);
    setMapped(null);
    if (!id) return;
    try {
      const r = await apiFetch<Inspected>(scenesApi(projectId, `/rooms/${id}/kit`));
      setInspected(r);
      const first = r.sheets[0];
      if (first) chooseSheet(first.sheetId, r);
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  function chooseSheet(id: string, data = inspected) {
    setSheetId(id);
    const s = data?.sheets.find((x) => x.sheetId === id);
    if (!s || !data) return;
    // Kit local: grade da sala deslocada meia célula (os cantos piso/parede ficam no meio dos tiles).
    setOrigin([Math.max(0, data.grid.gridOrigin[0] - data.grid.cellPx[0] / 2), Math.max(0, data.grid.gridOrigin[1] - data.grid.cellPx[1] / 2)]);
    setCell(data.grid.cellPx);
    setKeys([]);
  }
  async function publishMapping() {
    try {
      setMapped(await apiFetch(scenesApi(projectId, "/rooms/kit-map"), { method: "POST", json: { roomRevisionId: roomId, sheetId, name, origin, cell, spacing, keys: rects.map((_, i) => keys[i] ?? { kind: "ignore" }) } }));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function toMap() {
    try {
      const doorObjects = Object.fromEntries((mapped?.doors ?? []).map((d) => [d.side, d.revision.id]));
      setMapResult(await apiFetch(scenesApi(projectId, "/rooms/to-map"), { method: "POST", json: { roomRevisionId: roomId, tilesetRevisionId: tilesetId || mapped?.tileset.id, name: `${entry?.asset.name ?? "Sala"} (mapa)`, doorObjects } }));
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  const tilesets = catalog.cornerTilesets.flatMap(({ asset, revisions }) => revisions.map((r) => ({ asset, r })));
  return (
    <>
      <section>
        <h2>Kit da sala</h2>
        <select value={roomId} onChange={(e) => inspect(e.target.value)}>
          <option value="">— sala aprovada —</option>
          {rooms.map(({ asset, revision }) => (
            <option key={revision.id} value={revision.id}>
              {asset.name} r{revision.number}
            </option>
          ))}
        </select>
        {room && <p className="small muted">Kit local: a própria imagem da sala, cortada pela grade declarada; cada célula recebe uma chave.</p>}
        {room?.projection === "oblique" && <p className="small">⚠ Sala oblíqua: as paredes inclinadas não cabem no tileset por cantos (quadro = célula); sem mapa automático.</p>}
      </section>
      {inspected && sheet && (
        <section>
          <h2>Mapear por chave</h2>
          <div className="row small">
            <select value={sheetId} onChange={(e) => chooseSheet(e.target.value)}>
              {inspected.sheets.map((s) => (
                <option key={s.sheetId} value={s.sheetId}>
                  {s.name} ({s.size.join("×")})
                </option>
              ))}
            </select>
            origem <input type="number" value={origin[0]} style={{ width: 50 }} onChange={(e) => setOrigin([Number(e.target.value), origin[1]])} />
            <input type="number" value={origin[1]} style={{ width: 50 }} onChange={(e) => setOrigin([origin[0], Number(e.target.value)])} />
            célula <input type="number" value={cell[0]} style={{ width: 50 }} onChange={(e) => setCell([Number(e.target.value) || 1, cell[1]])} />
            <input type="number" value={cell[1]} style={{ width: 50 }} onChange={(e) => setCell([cell[0], Number(e.target.value) || 1])} />
            espaço <input type="number" value={spacing} style={{ width: 40 }} onChange={(e) => setSpacing(Number(e.target.value) || 0)} />
            <button type="button" className="secondary" onClick={() => setKeys(proposeMaskOrder(rects.length))}>
              Propor 0–15 em ordem (conferir!)
            </button>
          </div>
          <div style={{ position: "relative", display: "inline-block" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {sheet.mediaId && <img src={mediaUrl(projectId, sheet.mediaId)} alt={sheet.name} className="pixel bg-checker" style={{ ...PIXEL, width: sheet.size[0] * zoom }} />}
            {rects.map((r, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setSelected(i)}
                style={{ position: "absolute", left: r[0] * zoom, top: r[1] * zoom, width: r[2] * zoom, height: r[3] * zoom, padding: 0, background: "transparent", border: `1px solid ${selected === i ? "#ffd600" : "rgba(0,220,255,0.6)"}`, color: "#fff", textShadow: "0 0 2px #000", fontSize: 11, borderRadius: 0 }}
              >
                {keyLabel(keys[i])}
              </button>
            ))}
          </div>
          {selected !== null && (
            <div className="row small">
              Célula {selected}:
              <select
                value={keys[selected] ? JSON.stringify(keys[selected]) : JSON.stringify({ kind: "ignore" })}
                onChange={(e) => setKeys((ks) => Object.assign([...ks], { [selected]: JSON.parse(e.target.value) as KitKey }))}
              >
                <option value={JSON.stringify({ kind: "ignore" })}>ignorar</option>
                {Array.from({ length: 16 }, (_, m) => (
                  <option key={m} value={JSON.stringify({ kind: "mask", mask: m })}>
                    máscara {m} (parede em {[m & 1 && "NO", m & 2 && "NE", m & 4 && "SE", m & 8 && "SO"].filter(Boolean).join("+") || "nenhum canto"})
                  </option>
                ))}
                {SIDES.map((s) => (
                  <option key={s} value={JSON.stringify({ kind: "door", side: s })}>
                    porta {s}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="row">
            <label>
              Nome do tileset
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="button" onClick={publishMapping} disabled={!keys.some((k) => k && k.kind !== "ignore")}>
              Publicar tileset piso ↔ parede
            </button>
          </div>
          {mapped && (
            <p className="small">
              Tileset publicado (candidato): {mapped.complete ? "16 máscaras — completo" : `faltam as máscaras ${mapped.missing.join(", ")} — não declarado completo`} · {mapped.doors.length} porta(s) como prop.
            </p>
          )}
        </section>
      )}
      {room && (
        <section>
          <h2>Remontar num mapa editável (T1)</h2>
          {room.projection !== "top_down" ? (
            <p className="small muted">Remontar por cantos vale para salas top-down; a isométrica usa o tileset isométrico do T1.</p>
          ) : (
            <div className="row">
              <select value={tilesetId} onChange={(e) => setTilesetId(e.target.value)}>
                <option value="">{mapped ? "tileset recém-mapeado" : "— tileset por cantos —"}</option>
                {tilesets.map(({ asset, r }) => (
                  <option key={r.id} value={r.id}>
                    {asset.name} r{r.number} ({r.status})
                  </option>
                ))}
              </select>
              <button type="button" onClick={toMap} disabled={!tilesetId && !mapped}>
                Criar rascunho de mapa
              </button>
            </div>
          )}
          {mapResult && (
            <p className="small">
              Mapa criado: entradas com os IDs das portas, móveis com apoio/footprint/colisão.{" "}
              {mapResult.passages.map((p) => `${p.from} → ${p.to}: ${p.connected ? "passagem livre" : "interrompida"}`).join(" · ")} — <Link href={mapResult.openUrl}>abrir no editor de mapas</Link>
            </p>
          )}
        </section>
      )}
      <Message text={message} error />
    </>
  );
}
