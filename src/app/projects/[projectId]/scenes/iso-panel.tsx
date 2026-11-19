"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { type BasePayload, DIRECTIONS_8, type Direction, type IsoTilesetPayload, type TilemapPayload } from "@/contracts";
import { characterView, type IsoActor, isoDrawList, isoWorld, occludersOf, stepActor, viewForWorld } from "@/domain/scenes/iso-walk";
import { apiFetch } from "@/app/client/api";
import { errorText, fileOf, flatRevisions, mediaUrl, PIXEL, type ScenesCatalog } from "./scenes-client";
import { Message } from "./shared";

/**
 * Isométrico com personagem (06 §perspectivas; 04 §isométrico): a entrada é a
 * direção NO MUNDO; a vista desenhada é a projetada pelo mapa mundo → vista
 * (E → SE, N → NE). Sem girar nem espelhar bitmap: vista ausente aparece como
 * ausente. Apoio pela elevação do piso, colisão pelo footprint, oclusão pela
 * ordem de profundidade e pela região de oclusão revisada do prop.
 */

interface OpenedMap {
  payload: TilemapPayload;
  tileset: { payload: IsoTilesetPayload; atlasMediaId: string; kind: string };
}

const KEYS: Record<string, Direction> = { ArrowUp: "N", ArrowRight: "E", ArrowDown: "S", ArrowLeft: "W" };

export function IsoPanel({ projectId, catalog }: { projectId: string; catalog: ScenesCatalog }) {
  const characters = flatRevisions(catalog.characters);
  const [mapId, setMapId] = useState("");
  const [charId, setCharId] = useState("");
  const [opened, setOpened] = useState<OpenedMap | null>(null);
  const [actor, setActor] = useState<IsoActor>({ cell: [0, 0], facing: "S" });
  const [status, setStatus] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [images, setImages] = useState<Record<string, HTMLImageElement>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const char = characters.find((c) => c.revision.id === charId);
  const base = char?.revision.payload as BasePayload | undefined;

  useEffect(() => {
    if (!mapId) return;
    apiFetch<OpenedMap>(`/projects/${projectId}/world/maps/${mapId}`)
      .then((o) => {
        if (o.tileset.kind !== "isometric") throw new Error("O mapa não é isométrico");
        setOpened(o);
        setActor({ cell: [0, 0], facing: "S" });
      })
      .catch((err) => setMessage(errorText(err)));
  }, [mapId, projectId]);

  useEffect(() => {
    const wanted: [string, string][] = [];
    if (opened) wanted.push(["atlas", mediaUrl(projectId, opened.tileset.atlasMediaId)]);
    if (char && base)
      for (const v of base.views) {
        const f = fileOf(char.revision, v.fileId);
        if (f) wanted.push([`view:${charId}:${v.direction}`, mediaUrl(projectId, f.id)]);
      }
    for (const [key, src] of wanted) {
      if (images[key]) continue;
      const img = new Image();
      img.onload = () => setImages((x) => ({ ...x, [key]: img }));
      img.src = src;
    }
  }, [opened, char, base, charId, projectId, images]);

  const world = useMemo(() => (opened ? isoWorld(opened.payload, opened.tileset.payload) : null), [opened]);
  const view = base ? characterView(base, actor.facing) : null;
  const size: [number, number] = base?.logicalSize ?? [16, 32];
  const pivot: [number, number] = base?.groundOrigin ?? [8, 30];
  const drawn = world ? isoDrawList(world, actor, { size, pivot }) : null;
  const hiddenBy = drawn ? occludersOf(drawn.items) : [];

  function move(dir: Direction) {
    if (!world) return;
    const r = stepActor(world, actor, dir);
    setActor(r.actor);
    setStatus(r.moved ? `andou para ${dir} (mundo) → vista ${viewForWorld(dir, base?.orientation?.worldToView)}` : `bloqueado: ${r.reason}`);
  }
  const moveRef = useRef(move);
  useEffect(() => {
    moveRef.current = move;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const dir = KEYS[e.key];
      if (dir && document.activeElement === canvasRef.current) {
        e.preventDefault();
        moveRef.current(dir);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !drawn || !opened) return;
    const tallest = Math.max(64, ...opened.tileset.payload.pieces.map((p) => p.logicalSize[1]), size[1]);
    const z = 2;
    const pad = tallest;
    canvas.width = (drawn.bounds.width + 2) * z;
    canvas.height = (drawn.bounds.height + pad) * z;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const atlas = images.atlas;
    const pieces = new Map(opened.tileset.payload.pieces.map((p) => [p.pieceKey, p]));
    for (const item of drawn.items) {
      const x = item.at[0] * z;
      const y = (item.at[1] + pad) * z;
      if (item.kind === "actor") {
        const img = view?.art ? images[`view:${charId}:${view.view}`] : undefined;
        if (img && view?.art) {
          const [rx, ry, rw, rh] = view.art.rect;
          ctx.drawImage(img, rx, ry, rw, rh, x + view.art.sourceOffset[0] * z, y + view.art.sourceOffset[1] * z, rw * z, rh * z);
        } else {
          ctx.strokeStyle = "#ff3b3b";
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(x, y, size[0] * z, size[1] * z);
          ctx.setLineDash([]);
        }
        ctx.fillStyle = "#ffd600";
        ctx.fillRect(drawn.actorSupport[0] * z - 2, (drawn.actorSupport[1] + pad) * z - 2, 4, 4);
        continue;
      }
      const piece = pieces.get(item.key) ?? pieces.get(opened.payload.objects.find((o) => o.objectId === item.key)?.pieceKey ?? "");
      if (atlas && piece) ctx.drawImage(atlas, piece.rect[0], piece.rect[1], piece.rect[2], piece.rect[3], x, y, piece.rect[2] * z, piece.rect[3] * z);
    }
  });

  return (
    <>
      <section>
        <h2>Prévia isométrica com personagem</h2>
        <div className="row">
          <label>
            Mapa isométrico (T1)
            <select value={mapId} onChange={(e) => setMapId(e.target.value)}>
              <option value="">—</option>
              {catalog.isoMaps.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Personagem
            <select value={charId} onChange={(e) => setCharId(e.target.value)}>
              <option value="">—</option>
              {characters.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {asset.name} r{revision.number} ({(revision.payload as BasePayload).views.map((v) => v.direction).join(" ")})
                </option>
              ))}
            </select>
          </label>
        </div>
        {catalog.isoMaps.length === 0 && (
          <p className="small muted">
            Crie um mapa isométrico com um prop alto no <Link href={`/projects/${projectId}/world?tab=maps`}>editor de mapas do T1</Link>.
          </p>
        )}
        {drawn && (
          <div className="grid2">
            <div>
              <canvas ref={canvasRef} tabIndex={0} className="pixel bg-checker" style={{ ...PIXEL, maxWidth: "100%", outline: "1px dashed #666" }} />
              <p className="small muted">Clique no mapa e use as setas (direções do mundo: ↑ N, → E, ↓ S, ← W) ou os botões.</p>
              <div className="row">
                {DIRECTIONS_8.map((d) => (
                  <button key={d} type="button" className="secondary" onClick={() => move(d)}>
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <div className="small">
              <p>
                Célula {actor.cell.join(",")} · elevação {drawn.elevation} · olhando para <strong>{actor.facing}</strong> no mundo → vista <strong>{view?.view}</strong>{" "}
                {view?.art ? "" : <span className="error">(vista ausente na base: sem espelho nem rotação de bitmap; gere a vista na animação)</span>}
              </p>
              <p>{hiddenBy.length ? `Atrás de: ${hiddenBy.join(", ")} (coberto pela região de oclusão)` : "Na frente: nada cobre o personagem"}</p>
              <p className="muted">{status}</p>
              <table>
                <thead>
                  <tr>
                    <th>Mundo</th>
                    {DIRECTIONS_8.map((d) => (
                      <th key={d}>{d}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Vista</td>
                    {DIRECTIONS_8.map((d) => {
                      const v = viewForWorld(d, base?.orientation?.worldToView);
                      return (
                        <td key={d} className={base?.views.some((x) => x.direction === v) ? "" : "muted"}>
                          {v}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
      <Message text={message} error />
    </>
  );
}
