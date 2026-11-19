"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type CornerTilesetPayload, type IsoTilesetPayload, type MapObjectPayload, type MapPlacement, type SideTilesetPayload, TilemapPayload } from "@/contracts";
import { cornerMask } from "@/domain/world/corner";
import { compareSortKeys, isoDrawPosition, isoMapBounds, isoScreenToCell, isoSortKey } from "@/domain/world/iso";
import { checkPassages, fillCornerVertices, isCornerMap, moveObject, objectAnchor, paintCornerVertex, reresolveSide } from "@/domain/world/map";
import { isoCellTop } from "@/domain/projection";
import type { AssetView } from "@/server/catalog/catalog";
import { ApiError, apiFetch } from "@/app/client/api";
import { errorText, mediaUrl } from "./world-client";

/**
 * Editor de mapa (06 §montar a região): pintar terreno com autotile por
 * cantos (ou sólido/ar no lateral, peças no isométrico), colocar e mover
 * objetos, colisões, regiões e portas com coordenadas editáveis, conferir a
 * passagem entre portas, salvar rascunho, publicar revisão e reabrir.
 */

interface ObjectCtx {
  revisionId: string;
  assetId: string;
  name: string;
  number: number;
  status: string;
  payload: MapObjectPayload;
  mediaId: string;
  /** T2: sombra separada do prop. */
  shadowMediaId?: string;
}

interface Opened {
  asset: AssetView;
  source: { kind: "draft"; version: number } | { kind: "revision"; revisionId: string; number: number };
  draftVersion: number;
  payload: TilemapPayload;
  tileset: { revisionId: string; name: string; number: number; status: string; kind: "corner" | "sidescroller" | "isometric"; payload: CornerTilesetPayload | SideTilesetPayload | IsoTilesetPayload; atlasMediaId: string };
  objects: Record<string, ObjectCtx>;
  available: { objects: ObjectCtx[]; tilesets: { revisionId: string; name: string; number: number; status: string }[] };
  revisions: { id: string; number: number; status: string; createdAt: string; technicalReport: { passages?: { from: string; to: string; connected: boolean }[]; warnings?: string[] } | null }[];
}

type Tool = "inspect" | "object" | "terrainA" | "terrainB" | "fill" | "solid" | "air" | "piece" | "collision" | "region" | "entrance";
type Cell = [number, number];
type Selection = { type: "object" | "entrance" | "region"; id: string } | null;

const TOOL_LABEL: Record<Tool, string> = {
  inspect: "Selecionar / inspecionar",
  object: "Colocar e mover objetos",
  terrainA: "Pintar terreno A",
  terrainB: "Pintar terreno B",
  fill: "Preencher terreno",
  solid: "Pintar sólido",
  air: "Apagar (ar)",
  piece: "Pintar peça",
  collision: "Colisão por célula",
  region: "Região (arrastar)",
  entrance: "Porta / entrada",
};

function useImage(src: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!src) return;
    const image = new Image();
    image.onload = () => setImg(image);
    image.src = src;
  }, [src]);
  return img;
}

export function MapEditor({ projectId, assetId, onCatalogChange, onOpen }: { projectId: string; assetId: string; onCatalogChange: () => void; onOpen: (assetId: string) => void }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [map, setMap] = useState<TilemapPayload | null>(null);
  const [history, setHistory] = useState<TilemapPayload[]>([]);
  const [draftVersion, setDraftVersion] = useState(0);
  const [tool, setTool] = useState<Tool>("inspect");
  const [selection, setSelection] = useState<Selection>(null);
  const [objectSource, setObjectSource] = useState("");
  const [piece, setPiece] = useState("");
  const [elevation, setElevation] = useState(0);
  const [zoom, setZoom] = useState(2);
  const [overlays, setOverlays] = useState({ grid: true, blocked: false, path: true, collisions: true });
  const [inspect, setInspect] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [brokenPublish, setBrokenPublish] = useState(false);
  const [copyTileset, setCopyTileset] = useState("");
  const [objectImages, setObjectImages] = useState<Record<string, HTMLImageElement>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ kind: "paint" | "object" | "region"; start: Cell; objectId?: string } | null>(null);
  const [regionPreview, setRegionPreview] = useState<[number, number, number, number] | null>(null);

  function apply(data: Opened, revisionId?: string) {
    setOpened(data);
    setMap(data.payload);
    setDraftVersion(data.draftVersion);
    setHistory([]);
    setSelection(null);
    setMessage(revisionId ? `Revisão r${data.revisions.find((r) => r.id === revisionId)?.number} aberta: editar e salvar substitui o rascunho.` : null);
  }

  const fetchOpened = (revisionId?: string) => apiFetch<Opened>(`/projects/${projectId}/world/maps/${assetId}${revisionId ? `?revision=${revisionId}` : ""}`);

  async function load(revisionId?: string) {
    try {
      apply(await fetchOpened(revisionId), revisionId);
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  useEffect(() => {
    let cancelled = false;
    apiFetch<Opened>(`/projects/${projectId}/world/maps/${assetId}`)
      .then((data) => !cancelled && apply(data))
      .catch((err) => !cancelled && setMessage(errorText(err)));
    return () => {
      cancelled = true;
    };
  }, [projectId, assetId]);

  const atlas = useImage(opened ? mediaUrl(projectId, opened.tileset.atlasMediaId) : null);
  const allObjects = useMemo(() => {
    const out = new Map<string, ObjectCtx>();
    for (const o of [...Object.values(opened?.objects ?? {}), ...(opened?.available.objects ?? [])]) out.set(o.revisionId, o);
    return out;
  }, [opened]);
  useEffect(() => {
    for (const o of allObjects.values()) {
      if (objectImages[o.revisionId]) continue;
      const image = new Image();
      image.onload = () => setObjectImages((imgs) => ({ ...imgs, [o.revisionId]: image }));
      image.src = mediaUrl(projectId, o.mediaId);
      if (o.shadowMediaId) {
        // T2: sombra separada carregada junto (chave própria no mesmo mapa de imagens).
        const shadow = new Image();
        shadow.onload = () => setObjectImages((imgs) => ({ ...imgs, [`${o.revisionId}:shadow`]: shadow }));
        shadow.src = mediaUrl(projectId, o.shadowMediaId);
      }
    }
  }, [allObjects, objectImages, projectId]);

  const kind = opened?.tileset.kind ?? "corner";
  const isoPayload = kind === "isometric" ? (opened!.tileset.payload as IsoTilesetPayload) : null;
  const isoPieces = useMemo(() => new Map((isoPayload?.pieces ?? []).map((p) => [p.pieceKey, p])), [isoPayload]);
  const validation = useMemo(() => (map ? TilemapPayload.safeParse(map) : null), [map]);
  const passages = useMemo(() => {
    if (!map || !validation?.success) return null;
    return checkPassages(map, { objects: new Map([...allObjects.values()].map((o) => [o.revisionId, o.payload])), isoPieces });
  }, [map, validation, allObjects, isoPieces]);

  // ---- geometria da tela ----
  const geo = useMemo(() => {
    if (!map) return null;
    const [cols, rows] = map.size;
    const [cw, ch] = map.cellSize;
    if (map.projection !== "isometric") return { width: cols * cw, height: rows * ch, origin: [0, 0] as [number, number] };
    const bounds = isoMapBounds(map.size, map.cellSize);
    const tallest = Math.max(0, ...(isoPayload?.pieces ?? []).map((p) => p.logicalSize[1]));
    const top = tallest + 4 * (isoPayload?.elevationStepPx ?? 0);
    return { width: bounds.width, height: bounds.height + top, origin: [bounds.origin[0], top] as [number, number] };
  }, [map, isoPayload]);

  function cellAt(px: number, py: number): Cell | null {
    if (!map || !geo) return null;
    const [cols, rows] = map.size;
    const cell: Cell = map.projection === "isometric" ? isoScreenToCell([px, py], map.cellSize, geo.origin) : [Math.floor(px / map.cellSize[0]), Math.floor(py / map.cellSize[1])];
    return cell[0] >= 0 && cell[1] >= 0 && cell[0] < cols && cell[1] < rows ? cell : null;
  }

  function objectAtCell(cell: Cell): MapPlacement | undefined {
    if (!map) return undefined;
    return [...map.objects].reverse().find((o) => {
      const fp = o.pieceKey ? (isoPieces.get(o.pieceKey)?.footprintCells ?? [1, 1]) : (allObjects.get(o.objectRevisionId ?? "")?.payload.footprintCells ?? [1, 1]);
      return cell[0] >= o.cell[0] && cell[0] < o.cell[0] + fp[0] && cell[1] >= o.cell[1] && cell[1] < o.cell[1] + fp[1];
    });
  }

  // ---- desenho ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !map || !geo || !opened) return;
    const z = zoom;
    canvas.width = Math.ceil(geo.width * z);
    canvas.height = Math.ceil(geo.height * z);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const [cols, rows] = map.size;
    const [cw, ch] = map.cellSize;
    const hatch = (x: number, y: number, w: number, h: number) => {
      ctx.fillStyle = "rgba(230,40,40,0.45)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "#e62828";
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y);
      ctx.lineTo(x, y + h);
      ctx.stroke();
    };
    const t = map.terrain;
    if (t.mode === "corner" || t.mode === "side") {
      const ts = opened.tileset.payload as CornerTilesetPayload | SideTilesetPayload;
      const byKey = new Map<string, [number, number, number, number]>();
      if (t.mode === "corner") for (const tile of (ts as CornerTilesetPayload).tiles) byKey.set(tile.tileKey, tile.rect);
      else for (const tile of [...(ts as SideTilesetPayload).tiles].sort((a, b) => b.variant - a.variant)) byKey.set(tile.configuration, tile.rect);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const key = t.resolved[y * cols + x];
          if (key === null || key === undefined) {
            if (t.mode === "corner") hatch(x * cw * z, y * ch * z, cw * z, ch * z);
            continue;
          }
          const rect = byKey.get(key);
          if (!rect || !atlas) {
            hatch(x * cw * z, y * ch * z, cw * z, ch * z);
            continue;
          }
          ctx.drawImage(atlas, rect[0], rect[1], rect[2], rect[3], x * cw * z, y * ch * z, cw * z, ch * z);
        }
      }
      // Objetos por profundidade (y do apoio): copa de um objeto à frente cobre o de trás.
      const placed = map.objects
        .map((o) => ({ o, ctxObj: allObjects.get(o.objectRevisionId ?? "") }))
        .filter((x): x is { o: MapPlacement; ctxObj: ObjectCtx } => Boolean(x.ctxObj))
        .map(({ o, ctxObj }) => ({ o, ctxObj, anchor: objectAnchor(o, ctxObj.payload.footprintCells, map.cellSize) }))
        .sort((a, b) => a.anchor[1] - b.anchor[1]);
      for (const { o, ctxObj, anchor } of placed) {
        const img = objectImages[ctxObj.revisionId];
        const x = (anchor[0] - ctxObj.payload.supportPoint[0]) * z;
        const y = (anchor[1] - ctxObj.payload.supportPoint[1]) * z;
        const shadowImg = objectImages[`${ctxObj.revisionId}:shadow`];
        const shadow = ctxObj.payload.shadow;
        if (shadowImg && shadow) ctx.drawImage(shadowImg, x + shadow.offset[0] * z, y + shadow.offset[1] * z, shadowImg.width * z, shadowImg.height * z);
        if (img) ctx.drawImage(img, x, y, img.width * z, img.height * z);
        if (overlays.collisions) {
          ctx.strokeStyle = "#ff3b3b";
          for (const r of ctxObj.payload.collision) ctx.strokeRect(x + r[0] * z, y + r[1] * z, r[2] * z, r[3] * z);
        }
        if (selection?.type === "object" && selection.id === o.objectId) {
          ctx.strokeStyle = "#ffd600";
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, ctxObj.payload.logicalSize[0] * z, ctxObj.payload.logicalSize[1] * z);
          ctx.lineWidth = 1;
        }
        ctx.fillStyle = "#ff00c8";
        ctx.fillRect(anchor[0] * z - 2, anchor[1] * z - 2, 4, 4);
      }
      const cellRect = (x: number, y: number) => [x * cw * z, y * ch * z, cw * z, ch * z] as const;
      if (overlays.grid) {
        ctx.strokeStyle = "rgba(0,0,0,0.18)";
        for (let x = 0; x <= cols; x++) {
          ctx.beginPath();
          ctx.moveTo(x * cw * z + 0.5, 0);
          ctx.lineTo(x * cw * z + 0.5, rows * ch * z);
          ctx.stroke();
        }
        for (let y = 0; y <= rows; y++) {
          ctx.beginPath();
          ctx.moveTo(0, y * ch * z + 0.5);
          ctx.lineTo(cols * cw * z, y * ch * z + 0.5);
          ctx.stroke();
        }
      }
      if (t.mode === "corner" && (tool === "terrainA" || tool === "terrainB" || tool === "fill")) {
        for (let vy = 0; vy <= rows; vy++) {
          for (let vx = 0; vx <= cols; vx++) {
            ctx.fillStyle = t.vertices[vy * (cols + 1) + vx] ? "#3264c8" : "#469632";
            ctx.fillRect(vx * cw * z - 2, vy * ch * z - 2, 5, 5);
          }
        }
      }
      overlaysOrtho(ctx, cellRect);
    } else {
      const ts = isoPayload!;
      const step = ts.elevationStepPx;
      const items: { key: [number, number, number]; draw: () => void }[] = [];
      t.cells.forEach((c, i) => {
        const p = c.pieceKey ? isoPieces.get(c.pieceKey) : undefined;
        const cell: Cell = [i % cols, Math.floor(i / cols)];
        if (!p) return;
        items.push({
          key: isoSortKey(cell, p.footprintCells, c.elevation, p.kind === "floor" ? "floor" : "block"),
          draw: () => {
            const [x, y] = isoDrawPosition(p, cell, map.cellSize, c.elevation * step, geo.origin);
            if (atlas) ctx.drawImage(atlas, p.rect[0], p.rect[1], p.rect[2], p.rect[3], x * z, y * z, p.rect[2] * z, p.rect[3] * z);
          },
        });
      });
      for (const o of map.objects) {
        const p = o.pieceKey ? isoPieces.get(o.pieceKey) : undefined;
        if (!p) continue;
        const elev = t.cells[o.cell[1] * cols + o.cell[0]]?.elevation ?? 0;
        items.push({
          key: isoSortKey(o.cell, p.footprintCells, elev, "prop"),
          draw: () => {
            const [x, y] = isoDrawPosition(p, o.cell, map.cellSize, elev * step, [geo.origin[0] + o.offsetPx[0], geo.origin[1] + o.offsetPx[1]]);
            if (atlas) ctx.drawImage(atlas, p.rect[0], p.rect[1], p.rect[2], p.rect[3], x * z, y * z, p.rect[2] * z, p.rect[3] * z);
            const sx = (x + p.supportPoint[0]) * z;
            const sy = (y + p.supportPoint[1]) * z;
            ctx.fillStyle = "#ff00c8";
            ctx.fillRect(sx - 2, sy - 2, 4, 4);
            if (selection?.type === "object" && selection.id === o.objectId) {
              ctx.strokeStyle = "#ffd600";
              ctx.lineWidth = 2;
              ctx.strokeRect(x * z, y * z, p.rect[2] * z, p.rect[3] * z);
              ctx.lineWidth = 1;
            }
          },
        });
      }
      items.sort((a, b) => compareSortKeys(a.key, b.key)).forEach((it) => it.draw());
      const diamondPath = (x: number, y: number) => {
        const [tx, ty] = isoCellTop(x, y, map.cellSize, geo.origin);
        ctx.beginPath();
        ctx.moveTo(tx * z, ty * z);
        ctx.lineTo((tx + cw / 2) * z, (ty + ch / 2) * z);
        ctx.lineTo(tx * z, (ty + ch) * z);
        ctx.lineTo((tx - cw / 2) * z, (ty + ch / 2) * z);
        ctx.closePath();
      };
      if (overlays.grid) {
        ctx.strokeStyle = "rgba(0,0,0,0.2)";
        for (let y = 0; y < rows; y++) {
          for (let x = 0; x < cols; x++) {
            diamondPath(x, y);
            ctx.stroke();
          }
        }
      }
      const fillCell = (x: number, y: number, color: string) => {
        diamondPath(x, y);
        ctx.fillStyle = color;
        ctx.fill();
      };
      overlaysGeneric(fillCell);
    }

    function overlaysOrtho(c2: CanvasRenderingContext2D, cellRect: (x: number, y: number) => readonly [number, number, number, number]) {
      overlaysGeneric((x, y, color) => {
        c2.fillStyle = color;
        c2.fillRect(...cellRect(x, y));
      });
      for (const c of map!.collisions) {
        if (c.kind !== "polygon" || !overlays.collisions) continue;
        c2.strokeStyle = "#ff3b3b";
        c2.beginPath();
        c.points.forEach(([px, py], i) => (i ? c2.lineTo(px * z, py * z) : c2.moveTo(px * z, py * z)));
        c2.closePath();
        c2.stroke();
      }
      for (const r of map!.regions) {
        const [x, y, w, h] = r.rect;
        c2.strokeStyle = selection?.type === "region" && selection.id === r.regionId ? "#ffd600" : "#3c78dc";
        c2.lineWidth = 2;
        c2.strokeRect(x * cw * z + 1, y * ch * z + 1, w * cw * z - 2, h * ch * z - 2);
        c2.lineWidth = 1;
        c2.fillStyle = "#3c78dc";
        c2.font = "11px system-ui";
        c2.fillText(r.name, x * cw * z + 4, y * ch * z + 13);
      }
      if (regionPreview) {
        const [x, y, w, h] = regionPreview;
        c2.strokeStyle = "#ffd600";
        c2.strokeRect(x * cw * z, y * ch * z, w * cw * z, h * ch * z);
      }
    }

    function overlaysGeneric(fillCell: (x: number, y: number, color: string) => void) {
      if (overlays.blocked && passages?.blocked) passages.blocked.forEach((b, i) => b && fillCell(i % cols, Math.floor(i / cols), "rgba(0,0,0,0.35)"));
      if (overlays.collisions) for (const c of map!.collisions) if (c.kind === "cells") for (const [x, y] of c.cells) fillCell(x, y, "rgba(230,40,40,0.4)");
      if (overlays.path && passages) for (const r of passages.results) for (const [x, y] of r.path) fillCell(x, y, "rgba(40,200,80,0.35)");
      for (const e of map!.entrances) fillCell(e.cell[0], e.cell[1], selection?.type === "entrance" && selection.id === e.entranceId ? "rgba(255,214,0,0.9)" : "rgba(255,214,0,0.55)");
    }
  }, [map, geo, opened, atlas, objectImages, zoom, overlays, selection, tool, passages, allObjects, isoPayload, isoPieces, regionPreview]);

  // ---- edição ----
  function commit(next: TilemapPayload, pushHistory = true) {
    if (pushHistory && map) setHistory((h) => [...h.slice(-49), map]);
    setMap(next);
    setBrokenPublish(false);
  }

  function undo() {
    setHistory((h) => {
      if (!h.length) return h;
      setMap(h[h.length - 1]!);
      return h.slice(0, -1);
    });
  }

  function pointer(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - rect.left) / zoom, (e.clientY - rect.top) / zoom] as const;
  }

  function applyBrush(m: TilemapPayload, px: number, py: number): TilemapPayload {
    const [cols] = m.size;
    const t = m.terrain;
    if ((tool === "terrainA" || tool === "terrainB") && isCornerMap(m)) {
      const vx = Math.round(px / m.cellSize[0]);
      const vy = Math.round(py / m.cellSize[1]);
      return paintCornerVertex(m, opened!.tileset.payload as CornerTilesetPayload, vx, vy, tool === "terrainB" ? 1 : 0).map;
    }
    const cell = cellAt(px, py);
    if (!cell) return m;
    const i = cell[1] * cols + cell[0];
    if ((tool === "solid" || tool === "air") && t.mode === "side") {
      const solid = [...t.solid];
      solid[i] = tool === "solid" ? 1 : 0;
      return reresolveSide({ ...m, terrain: { ...t, solid } }, opened!.tileset.payload as SideTilesetPayload);
    }
    if (tool === "piece" && t.mode === "isometric") {
      const cells = [...t.cells];
      cells[i] = { pieceKey: piece || null, elevation };
      return { ...m, terrain: { ...t, cells } };
    }
    return m;
  }

  function onDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!map || !opened) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* sem captura: segue igual */
    }
    const [px, py] = pointer(e);
    const cell = cellAt(px, py);
    if (["terrainA", "terrainB", "solid", "air", "piece"].includes(tool)) {
      drag.current = { kind: "paint", start: cell ?? [0, 0] };
      commit(applyBrush(map, px, py));
      return;
    }
    if (!cell) return;
    if (tool === "fill" && isCornerMap(map)) {
      const vx = Math.round(px / map.cellSize[0]);
      const vy = Math.round(py / map.cellSize[1]);
      const current = map.terrain.vertices[vy * (map.size[0] + 1) + vx] ?? 0;
      commit(fillCornerVertices(map, opened.tileset.payload as CornerTilesetPayload, vx, vy, current ? 0 : 1));
      return;
    }
    if (tool === "collision") {
      const existing = map.collisions.find((c) => c.collisionId === "celulas" && c.kind === "cells");
      const cells = existing && existing.kind === "cells" ? existing.cells : [];
      const has = cells.some(([x, y]) => x === cell[0] && y === cell[1]);
      const nextCells = has ? cells.filter(([x, y]) => !(x === cell[0] && y === cell[1])) : [...cells, cell];
      const others = map.collisions.filter((c) => c.collisionId !== "celulas");
      commit({ ...map, collisions: nextCells.length ? [...others, { collisionId: "celulas", kind: "cells", cells: nextCells }] : others });
      return;
    }
    if (tool === "entrance") {
      let n = map.entrances.length + 1;
      while (map.entrances.some((x) => x.entranceId === `porta-${n}`)) n++;
      const [cols, rows] = map.size;
      const side = cell[0] === 0 ? "W" : cell[0] === cols - 1 ? "E" : cell[1] === 0 ? "N" : cell[1] === rows - 1 ? "S" : "S";
      commit({ ...map, entrances: [...map.entrances, { entranceId: `porta-${n}`, name: `Porta ${n}`, cell, side }] });
      setSelection({ type: "entrance", id: `porta-${n}` });
      return;
    }
    if (tool === "region") {
      drag.current = { kind: "region", start: cell };
      setRegionPreview([cell[0], cell[1], 1, 1]);
      return;
    }
    const hit = objectAtCell(cell);
    if (hit) {
      setSelection({ type: "object", id: hit.objectId });
      drag.current = { kind: "object", start: cell, objectId: hit.objectId };
      setHistory((h) => [...h.slice(-49), map]);
      return;
    }
    if (tool === "object" && objectSource) {
      let n = map.objects.length + 1;
      while (map.objects.some((o) => o.objectId === `obj-${n}`)) n++;
      const isPiece = objectSource.startsWith("piece:");
      const placement: MapPlacement = {
        objectId: `obj-${n}`,
        objectRevisionId: isPiece ? null : objectSource,
        pieceKey: isPiece ? objectSource.slice(6) : null,
        cell,
        offsetPx: [0, 0],
        label: isPiece ? isoPieces.get(objectSource.slice(6))?.name : allObjects.get(objectSource)?.name,
      };
      commit({ ...map, objects: [...map.objects, placement] });
      setSelection({ type: "object", id: placement.objectId });
      return;
    }
    const entrance = map.entrances.find((x) => x.cell[0] === cell[0] && x.cell[1] === cell[1]);
    const region = map.regions.find((r) => cell[0] >= r.rect[0] && cell[0] < r.rect[0] + r.rect[2] && cell[1] >= r.rect[1] && cell[1] < r.rect[1] + r.rect[3]);
    setSelection(entrance ? { type: "entrance", id: entrance.entranceId } : region ? { type: "region", id: region.regionId } : null);
    describeCell(cell);
  }

  function describeCell(cell: Cell) {
    if (!map) return;
    const [cols] = map.size;
    const i = cell[1] * cols + cell[0];
    const t = map.terrain;
    const terrain =
      t.mode === "corner"
        ? `máscara ${cornerMask(t.vertices, cols, cell[0], cell[1])} → ${t.resolved[i] ?? "AUSENTE no tileset"}`
        : t.mode === "side"
          ? `${t.solid[i] ? `sólido: ${t.resolved[i]}` : "ar"}`
          : `peça ${t.cells[i]?.pieceKey ?? "vazia"}, elevação ${t.cells[i]?.elevation ?? 0}`;
    const blocked = passages?.blocked?.[i] ? "bloqueada" : "caminhável";
    setInspect(`Célula (${cell[0]}, ${cell[1]}): ${terrain} · ${blocked}`);
  }

  function onMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drag.current || e.buttons !== 1 || !map) return;
    const [px, py] = pointer(e);
    if (drag.current.kind === "paint") {
      setMap((m) => (m ? applyBrush(m, px, py) : m));
      return;
    }
    const cell = cellAt(px, py);
    if (!cell) return;
    if (drag.current.kind === "object" && drag.current.objectId) {
      const id = drag.current.objectId;
      setMap((m) => (m ? moveObject(m, id, cell) : m));
      return;
    }
    if (drag.current.kind === "region") {
      const [sx, sy] = drag.current.start;
      setRegionPreview([Math.min(sx, cell[0]), Math.min(sy, cell[1]), Math.abs(cell[0] - sx) + 1, Math.abs(cell[1] - sy) + 1]);
    }
  }

  function onUp() {
    if (drag.current?.kind === "region" && regionPreview && map) {
      let n = map.regions.length + 1;
      while (map.regions.some((r) => r.regionId === `regiao-${n}`)) n++;
      commit({ ...map, regions: [...map.regions, { regionId: `regiao-${n}`, name: `Região ${n}`, kind: "area", rect: regionPreview }] });
      setSelection({ type: "region", id: `regiao-${n}` });
    }
    setRegionPreview(null);
    drag.current = null;
  }

  // ---- persistência ----
  async function saveDraft() {
    if (!map) return;
    try {
      const { draft } = await apiFetch<{ draft: { version: number } }>(`/projects/${projectId}/assets/${assetId}/draft`, { method: "PUT", json: { expectedVersion: draftVersion, payload: map } });
      setDraftVersion(draft.version);
      setMessage(`Rascunho salvo (versão ${draft.version}).`);
    } catch (err) {
      setMessage(err instanceof ApiError && err.code === "revision_conflict" ? "O rascunho foi alterado em outra aba; recarregue antes de salvar." : errorText(err));
    }
  }

  async function publish(allowBrokenPassages = false) {
    if (!map) return;
    try {
      await saveDraft();
      const res = await apiFetch<{ revision: { id: string; number: number }; missing: string[] }>(`/projects/${projectId}/world/maps/${assetId}/publish`, {
        method: "POST",
        json: { payload: map, allowBrokenPassages },
      });
      setMessage(`Revisão r${res.revision.number} publicada como candidata${res.missing.length ? ` · casos ausentes no tileset: ${res.missing.join(", ")}` : ""}. Aprove-a na biblioteca do projeto.`);
      setBrokenPublish(false);
      const keepDraft = draftVersion;
      await load();
      setDraftVersion(keepDraft + 1);
      onCatalogChange();
    } catch (err) {
      setMessage(errorText(err));
      if (err instanceof ApiError && /Passagem interrompida/.test(err.message)) setBrokenPublish(true);
    }
  }

  async function copyWith() {
    const source = opened?.revisions[0];
    if (!source || !opened) return;
    try {
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/world/maps/${assetId}/copy`, {
        method: "POST",
        json: { revisionId: source.id, name: `${opened.asset.name} (cópia)`, ...(copyTileset ? { tilesetRevisionId: copyTileset } : {}) },
      });
      onCatalogChange();
      onOpen(asset.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  if (!opened || !map || !geo) return <section>{message ? <p className="error">{message}</p> : <p className="muted">Abrindo mapa…</p>}</section>;

  const tools: Tool[] =
    kind === "corner"
      ? ["inspect", "object", "terrainA", "terrainB", "fill", "collision", "region", "entrance"]
      : kind === "sidescroller"
        ? ["inspect", "object", "solid", "air", "collision", "region", "entrance"]
        : ["inspect", "object", "piece", "collision", "region", "entrance"];
  const terrains = kind === "corner" ? (opened.tileset.payload as CornerTilesetPayload).terrains : null;
  const label = (t: Tool) => (terrains && t === "terrainA" ? `Pintar ${terrains[0].name}` : terrains && t === "terrainB" ? `Pintar ${terrains[1].name}` : TOOL_LABEL[t]);
  const objectChoices = kind === "isometric" ? [...isoPieces.values()].filter((p) => p.kind === "prop").map((p) => ({ value: `piece:${p.pieceKey}`, label: p.name })) : opened.available.objects.map((o) => ({ value: o.revisionId, label: `${o.name} r${o.number}${o.status === "approved" ? "" : ` (${o.status})`}` }));
  const issues = validation && !validation.success ? validation.error.issues.slice(0, 6) : [];
  const update = (fn: (m: TilemapPayload) => TilemapPayload) => commit(fn(map));
  const num = (v: string) => Math.max(0, Math.trunc(Number(v) || 0));

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          {opened.asset.name} · {map.size.join("×")} células · {map.projection}
        </h2>
        <span className="small muted">
          {opened.source.kind === "draft" ? `rascunho v${draftVersion}` : `revisão r${opened.source.number}`} · tileset {opened.tileset.name} r{opened.tileset.number} ({opened.tileset.status})
        </span>
      </div>
      <div className="row">
        {tools.map((t) => (
          <button key={t} type="button" className={tool === t ? "" : "secondary"} onClick={() => setTool(t)}>
            {label(t)}
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        {tool === "object" && (
          <label>
            Objeto a colocar
            <select value={objectSource} onChange={(e) => setObjectSource(e.target.value)}>
              <option value="">—</option>
              {objectChoices.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {tool === "piece" && isoPayload && (
          <>
            <label>
              Peça
              <select value={piece} onChange={(e) => setPiece(e.target.value)}>
                <option value="">vazio</option>
                {isoPayload.pieces
                  .filter((p) => p.kind !== "prop")
                  .map((p) => (
                    <option key={p.pieceKey} value={p.pieceKey}>
                      {p.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Elevação
              <input type="number" min={0} max={8} value={elevation} onChange={(e) => setElevation(num(e.target.value))} style={{ width: 60 }} />
            </label>
          </>
        )}
        <label>
          Zoom
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 2, 3, 4].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        {(Object.keys(overlays) as (keyof typeof overlays)[]).map((k) => (
          <label key={k} style={{ flexDirection: "row", gap: 4, color: "inherit" }}>
            <input type="checkbox" checked={overlays[k]} onChange={(e) => setOverlays({ ...overlays, [k]: e.target.checked })} />
            {{ grid: "grade", blocked: "bloqueio", path: "caminho", collisions: "colisões" }[k]}
          </label>
        ))}
        <button type="button" className="secondary" disabled={!history.length} onClick={undo}>
          Desfazer
        </button>
      </div>
      <div style={{ overflow: "auto", maxWidth: "100%", marginTop: 8 }}>
        <canvas
          ref={canvasRef}
          className="pixel bg-checker"
          style={{ touchAction: "none", cursor: "crosshair", imageRendering: "pixelated" }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => drag.current?.kind === "paint" && onUp()}
        />
      </div>
      {inspect && <p className="small">{inspect}</p>}
      {issues.length > 0 && (
        <ul className="small">
          {issues.map((i, n) => (
            <li key={n} className="error">
              {i.path.join(".")}: {i.message}
            </li>
          ))}
        </ul>
      )}

      <div className="grid2" style={{ marginTop: 8 }}>
        <div className="small">
          <h3>Objetos</h3>
          {map.objects.length === 0 && <p className="muted">Nenhum objeto. Ferramenta “Colocar e mover objetos”.</p>}
          {map.objects.map((o) => (
            <div key={o.objectId} className="row" style={{ background: selection?.id === o.objectId ? "var(--bg)" : undefined }}>
              <button type="button" className="secondary" onClick={() => setSelection({ type: "object", id: o.objectId })}>
                {o.label ?? o.objectId}
              </button>
              <label>
                x
                <input type="number" value={o.cell[0]} onChange={(e) => update((m) => moveObject(m, o.objectId, [num(e.target.value), o.cell[1]]))} style={{ width: 52 }} />
              </label>
              <label>
                y
                <input type="number" value={o.cell[1]} onChange={(e) => update((m) => moveObject(m, o.objectId, [o.cell[0], num(e.target.value)]))} style={{ width: 52 }} />
              </label>
              <label>
                Δx px
                <input type="number" value={o.offsetPx[0]} onChange={(e) => update((m) => moveObject(m, o.objectId, o.cell, [Math.trunc(Number(e.target.value) || 0), o.offsetPx[1]]))} style={{ width: 52 }} />
              </label>
              <label>
                Δy px
                <input type="number" value={o.offsetPx[1]} onChange={(e) => update((m) => moveObject(m, o.objectId, o.cell, [o.offsetPx[0], Math.trunc(Number(e.target.value) || 0)]))} style={{ width: 52 }} />
              </label>
              <button type="button" className="secondary" onClick={() => update((m) => ({ ...m, objects: m.objects.filter((x) => x.objectId !== o.objectId) }))}>
                Remover
              </button>
            </div>
          ))}
          <h3>Portas / entradas</h3>
          {map.entrances.map((en) => (
            <div key={en.entranceId} className="row">
              <label>
                ID estável
                <input
                  value={en.entranceId}
                  onChange={(e) =>
                    update((m) => ({
                      ...m,
                      entrances: m.entrances.map((x) => (x.entranceId === en.entranceId ? { ...x, entranceId: e.target.value } : x)),
                      passages: m.passages.map((p) => ({ from: p.from === en.entranceId ? e.target.value : p.from, to: p.to === en.entranceId ? e.target.value : p.to })),
                    }))
                  }
                  style={{ width: 110 }}
                />
              </label>
              <label>
                Nome
                <input value={en.name} onChange={(e) => update((m) => ({ ...m, entrances: m.entrances.map((x) => (x.entranceId === en.entranceId ? { ...x, name: e.target.value } : x)) }))} style={{ width: 90 }} />
              </label>
              {[0, 1].map((axis) => (
                <label key={axis}>
                  {axis ? "y" : "x"}
                  <input
                    type="number"
                    value={en.cell[axis]}
                    onChange={(e) =>
                      update((m) => ({ ...m, entrances: m.entrances.map((x) => (x.entranceId === en.entranceId ? { ...x, cell: (axis ? [x.cell[0], num(e.target.value)] : [num(e.target.value), x.cell[1]]) as Cell } : x)) }))
                    }
                    style={{ width: 52 }}
                  />
                </label>
              ))}
              <label>
                Lado
                <select value={en.side} onChange={(e) => update((m) => ({ ...m, entrances: m.entrances.map((x) => (x.entranceId === en.entranceId ? { ...x, side: e.target.value as "N" } : x)) }))}>
                  {["N", "E", "S", "W"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                onClick={() => update((m) => ({ ...m, entrances: m.entrances.filter((x) => x.entranceId !== en.entranceId), passages: m.passages.filter((p) => p.from !== en.entranceId && p.to !== en.entranceId) }))}
              >
                Remover
              </button>
            </div>
          ))}
          <h3>Passagens exigidas</h3>
          {map.passages.map((p, i) => {
            const r = passages?.results[i];
            return (
              <div key={i} className="row">
                {p.from} → {p.to}:{" "}
                {r ? <span className={r.connected ? "" : "error"}>{r.connected ? `conectada (${r.steps} passos)` : r.reason}</span> : "—"}
                <button type="button" className="secondary" onClick={() => update((m) => ({ ...m, passages: m.passages.filter((_, j) => j !== i) }))}>
                  Remover
                </button>
              </div>
            );
          })}
          {map.entrances.length >= 2 && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                const [a, b] = map.entrances;
                update((m) => ({ ...m, passages: [...m.passages, { from: a!.entranceId, to: b!.entranceId }] }));
              }}
            >
              Exigir passagem entre as duas primeiras portas
            </button>
          )}
          {passages && !passages.supported && <p className="muted">Passagem lateral exige física de pulo: não verificada neste perfil.</p>}
        </div>
        <div className="small">
          <h3>Regiões</h3>
          {map.regions.map((r) => (
            <div key={r.regionId} className="row">
              <label>
                Nome
                <input value={r.name} onChange={(e) => update((m) => ({ ...m, regions: m.regions.map((x) => (x.regionId === r.regionId ? { ...x, name: e.target.value } : x)) }))} style={{ width: 100 }} />
              </label>
              <label>
                Tipo
                <select value={r.kind} onChange={(e) => update((m) => ({ ...m, regions: m.regions.map((x) => (x.regionId === r.regionId ? { ...x, kind: e.target.value as "area" } : x)) }))}>
                  {["area", "spawn", "trigger", "no_build"].map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              <label>
                x,y,w,h
                <input
                  defaultValue={r.rect.join(",")}
                  onBlur={(e) => {
                    const v = e.target.value.split(",").map(num);
                    if (v.length === 4 && v[2]! > 0 && v[3]! > 0) update((m) => ({ ...m, regions: m.regions.map((x) => (x.regionId === r.regionId ? { ...x, rect: v as [number, number, number, number] } : x)) }));
                  }}
                  style={{ width: 90 }}
                />
              </label>
              <button type="button" className="secondary" onClick={() => update((m) => ({ ...m, regions: m.regions.filter((x) => x.regionId !== r.regionId) }))}>
                Remover
              </button>
            </div>
          ))}
          <h3>Colisões</h3>
          {map.collisions.map((c) => (
            <div key={c.collisionId} className="row">
              {c.kind === "cells" ? (
                <span>
                  {c.collisionId}: {c.cells.length} célula(s)
                </span>
              ) : (
                <label>
                  {c.collisionId} (polígono em px do mapa)
                  <input
                    defaultValue={c.points.map((p) => p.join(",")).join(" ")}
                    onBlur={(e) => {
                      const pts = e.target.value
                        .trim()
                        .split(/\s+/)
                        .map((p) => p.split(",").map((n) => Math.trunc(Number(n) || 0)) as [number, number]);
                      if (pts.length >= 3) update((m) => ({ ...m, collisions: m.collisions.map((x) => (x.collisionId === c.collisionId ? { ...x, points: pts } : x)) }));
                    }}
                    style={{ width: 200 }}
                  />
                </label>
              )}
              <button type="button" className="secondary" onClick={() => update((m) => ({ ...m, collisions: m.collisions.filter((x) => x.collisionId !== c.collisionId) }))}>
                Remover
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const [cw, ch] = map.cellSize;
              let n = map.collisions.length + 1;
              while (map.collisions.some((c) => c.collisionId === `poligono-${n}`)) n++;
              update((m) => ({ ...m, collisions: [...m.collisions, { collisionId: `poligono-${n}`, kind: "polygon", points: [[cw, ch], [cw * 2, ch], [cw * 2, ch * 2], [cw, ch * 2]] }] }));
            }}
          >
            Adicionar polígono de colisão
          </button>
          <h3>Revisões</h3>
          <div className="row">
            <button type="button" className="secondary" onClick={saveDraft}>
              Salvar rascunho
            </button>
            <button type="button" disabled={!validation?.success} onClick={() => publish(false)}>
              Publicar revisão
            </button>
            {brokenPublish && (
              <button type="button" className="secondary" onClick={() => publish(true)}>
                Publicar mesmo com passagem interrompida
              </button>
            )}
            <button type="button" className="secondary" onClick={() => load()}>
              Reabrir rascunho
            </button>
          </div>
          <ul>
            {opened.revisions.map((r) => (
              <li key={r.id}>
                r{r.number} <span className={`badge state-${r.status}`}>{r.status}</span>{" "}
                {r.technicalReport?.passages?.length ? `· passagens ${r.technicalReport.passages.every((p) => p.connected) ? "ok" : "interrompidas"}` : ""}{" "}
                <button type="button" className="secondary" onClick={() => load(r.id)}>
                  Abrir
                </button>
              </li>
            ))}
          </ul>
          {opened.revisions.length > 0 && (
            <div className="row">
              <label>
                Copiar a última revisão com o tileset
                <select value={copyTileset} onChange={(e) => setCopyTileset(e.target.value)}>
                  <option value="">o mesmo</option>
                  {opened.available.tilesets.map((t) => (
                    <option key={t.revisionId} value={t.revisionId}>
                      {t.name} r{t.number} ({t.status})
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="secondary" onClick={copyWith}>
                Copiar
              </button>
            </div>
          )}
        </div>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}
