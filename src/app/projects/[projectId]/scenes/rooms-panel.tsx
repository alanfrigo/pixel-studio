"use client";

import { useMemo, useState } from "react";
import { ROOM_MAX_COLS, ROOM_MAX_ROWS, type RoomPayload } from "@/contracts";
import { floorPlanProblems, fullFloorPlan } from "@/domain/scenes/room";
import { apiFetch } from "@/app/client/api";
import { createAsset, errorText, fileOf, flatRevisions, mediaUrl, PIXEL, type Profile, type ScenesCatalog, scenesApi, SIDES, type Side } from "./scenes-client";
import { Message, PlanRunner, RevisionCard } from "./shared";

/**
 * Sala (06 §sala mobiliada, §limites reais): planta de até 7 × 6 células e
 * portas nas paredes, tema, vista e `tile_size`. A planta vira guia raster e
 * uma sala aprovada da mesma vista pode ir como referência de estilo. Duas
 * salas ligadas por portas, mesma vista/escala.
 */

type Projection = "top_down" | "isometric" | "oblique";
interface Door {
  doorId: string;
  cell: [number, number];
  side: Side;
}

export function RoomsPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: ScenesCatalog; profiles: Profile[]; refresh: () => void }) {
  const usable = profiles.filter((p) => (p.capabilities.generate_room?.length ?? 0) > 0 && !p.unavailable);
  const [profileId, setProfileId] = useState("");
  const profile = usable.find((p) => p.id === profileId) ?? usable[0];
  const [name, setName] = useState("Biblioteca");
  const [theme, setTheme] = useState("biblioteca de um castelo, estantes de livros e uma mesa de leitura");
  const [projection, setProjection] = useState<Projection>("top_down");
  const [tileSize, setTileSize] = useState(32);
  const [plan, setPlan] = useState(fullFloorPlan());
  const [doors, setDoors] = useState<Door[]>([{ doorId: "porta-sul", cell: [3, 5], side: "S" }]);
  const [doorSide, setDoorSide] = useState<Side>("E");
  const [mode, setMode] = useState<"floor" | "door">("floor");
  const [styleRoom, setStyleRoom] = useState("");
  const problems = useMemo(() => floorPlanProblems(plan, doors), [plan, doors]);
  const rooms = flatRevisions(catalog.rooms);
  const styleOptions = rooms.filter(({ revision }) => revision.status === "approved" && (revision.payload as RoomPayload).projection === projection && (revision.payload as RoomPayload).tileSize === tileSize);

  function clickCell(c: number, r: number) {
    if (mode === "floor") {
      setPlan((p) => ({ ...p, cells: p.cells.map((v, i) => (i === r * ROOM_MAX_COLS + c ? !v : v)) }));
      return;
    }
    setDoors((ds) => {
      const existing = ds.findIndex((d) => d.cell[0] === c && d.cell[1] === r && d.side === doorSide);
      if (existing >= 0) return ds.filter((_, i) => i !== existing);
      let id = `porta-${doorSide.toLowerCase()}`;
      for (let n = 2; ds.some((d) => d.doorId === id); n++) id = `porta-${doorSide.toLowerCase()}-${n}`;
      return [...ds, { doorId: id, cell: [c, r], side: doorSide }];
    });
  }

  return (
    <>
      <section>
        <h2>Planta e portas</h2>
        <div className="row small">
          <button type="button" className={mode === "floor" ? "" : "secondary"} onClick={() => setMode("floor")}>
            Piso/rocha
          </button>
          <button type="button" className={mode === "door" ? "" : "secondary"} onClick={() => setMode("door")}>
            Portas
          </button>
          {mode === "door" && (
            <label>
              Lado
              <select value={doorSide} onChange={(e) => setDoorSide(e.target.value as Side)}>
                {SIDES.map((s) => (
                  <option key={s} value={s}>
                    {s} {s === "N" ? "(porta na parede do fundo)" : s === "S" ? "(passagem embaixo)" : "(passagem lateral de 2 células: clique na de cima)"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" className="secondary" onClick={() => (setPlan(fullFloorPlan()), setDoors([]))}>
            Recomeçar
          </button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${ROOM_MAX_COLS}, 40px)`, gap: 2, margin: "8px 0" }}>
          {Array.from({ length: ROOM_MAX_ROWS }, (_, r) =>
            Array.from({ length: ROOM_MAX_COLS }, (_, c) => {
              const floor = plan.cells[r * ROOM_MAX_COLS + c];
              const here = doors.filter((d) => (d.cell[0] === c && d.cell[1] === r) || ((d.side === "E" || d.side === "W") && d.cell[0] === c && d.cell[1] + 1 === r));
              const edge = (s: Side) => (here.some((d) => d.side === s) ? "4px solid #ffc800" : "1px solid #555");
              return (
                <button
                  key={`${c},${r}`}
                  type="button"
                  title={`${c},${r}`}
                  onClick={() => clickCell(c, r)}
                  style={{ width: 40, height: 40, padding: 0, background: floor ? "#c8b48c" : "#333", borderTop: edge("N"), borderRight: edge("E"), borderBottom: edge("S"), borderLeft: edge("W"), borderRadius: 0 }}
                />
              );
            }),
          )}
        </div>
        <div className="small">
          {doors.map((d) => (
            <span key={d.doorId} className="badge">
              {d.doorId}: {d.side} em {d.cell.join(",")}
            </span>
          ))}
        </div>
        {problems.map((p) => (
          <p key={p.path + p.message} className="error small">
            {p.message}
          </p>
        ))}
      </section>
      <section>
        <h2>Gerar sala</h2>
        <div className="row">
          <label>
            Perfil
            <select value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">{usable[0] ? `${usable[0].name} (padrão)` : "—"}</option>
              {usable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Nome
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Vista
            <select value={projection} onChange={(e) => setProjection(e.target.value as Projection)}>
              <option value="top_down">top-down</option>
              <option value="isometric">isométrica</option>
              <option value="oblique">oblíqua</option>
            </select>
          </label>
          <label>
            tile_size
            <select value={tileSize} onChange={(e) => setTileSize(Number(e.target.value))}>
              {[16, 24, 32, 48, 64].map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sala de estilo (mesma vista/escala)
            <select value={styleRoom} onChange={(e) => setStyleRoom(e.target.value)}>
              <option value="">—</option>
              {styleOptions.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {asset.name} r{revision.number} (referência visual)
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="small muted">A planta vai como guia raster: o modelo pinta por cima e a grade declarada é a da guia. Móveis saem depois pelo recorte local revisado.</p>
        {projection === "oblique" && <p className="small muted">⚠ Oblíqua: só paredes, portas e piso; sem móveis a extrair.</p>}
        {projection === "top_down" && tileSize !== 32 && <p className="small muted">Top-down: a imagem usa células de 32 px; o tile_size {tileSize} fica declarado como escala da sala.</p>}
        <label>
          Tema
          <input value={theme} onChange={(e) => setTheme(e.target.value)} style={{ width: "100%" }} />
        </label>
        <PlanRunner
          projectId={projectId}
          label="Sala"
          disabled={!usable.length || problems.length > 0}
          body={() => ({ operation: "generate_room", providerProfileId: profile?.id, theme, projection, tileSize, floorPlan: plan, doors, styleRoomRevisionId: styleRoom || null })}
          target={async () => (await createAsset(projectId, "room", name)).id}
          onDone={refresh}
        />
      </section>
      <section>
        <h2>Salas</h2>
        <div className="row" style={{ alignItems: "flex-start" }}>
          {rooms.length === 0 && <p className="muted small">Nenhuma sala ainda.</p>}
          {rooms.map(({ asset, revision }) => (
            <RoomCard key={revision.id} projectId={projectId} asset={asset} revision={revision} refresh={refresh} />
          ))}
        </div>
      </section>
      <LinkRooms projectId={projectId} catalog={catalog} refresh={refresh} />
    </>
  );
}

function RoomCard({ projectId, asset, revision, refresh }: { projectId: string; asset: Parameters<typeof RevisionCard>[0]["asset"]; revision: Parameters<typeof RevisionCard>[0]["revision"]; refresh: () => void }) {
  const p = revision.payload as RoomPayload;
  const [composite, setComposite] = useState<string | null>(null);
  const [grid, setGrid] = useState(false);
  const [origin, setOrigin] = useState<[number, number]>(p.gridOrigin);
  const [message, setMessage] = useState<string | null>(null);
  const pic = fileOf(revision, (p.background ?? p.picture).fileId);
  const [w, h] = [p.picture.rect[2], p.picture.rect[3]];
  async function preview() {
    try {
      setComposite((await apiFetch<{ previews: { zoom: string } }>(scenesApi(projectId, `/rooms/${revision.id}/preview`))).previews.zoom);
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function saveGrid() {
    try {
      await apiFetch(scenesApi(projectId, "/rooms/edit"), { method: "POST", json: { baseRevisionId: revision.id, gridOrigin: origin, note: "Grade revisada sobre a pintura" } });
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <RevisionCard projectId={projectId} asset={asset} revision={revision} src={null} refresh={refresh}>
      <div style={{ position: "relative", width: Math.min(256, w * 2) }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {pic && <img src={composite ?? mediaUrl(projectId, pic.id)} alt={asset.name} className="pixel bg-checker" style={{ ...PIXEL, width: "100%" }} />}
        {grid && p.projection !== "isometric" && (
          <svg viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}>
            {p.floorPlan.cells.map((f, i) =>
              f ? <rect key={i} x={origin[0] + (i % p.floorPlan.size[0]) * p.cellPx[0]} y={origin[1] + Math.floor(i / p.floorPlan.size[0]) * p.cellPx[1]} width={p.cellPx[0]} height={p.cellPx[1]} fill="none" stroke="#00dcff" strokeWidth={0.5} /> : null,
            )}
            {p.doors.map((d) => d.anchorPx && <circle key={d.doorId} cx={d.anchorPx[0]} cy={d.anchorPx[1]} r={3} fill="#ffc800" />)}
          </svg>
        )}
      </div>
      <div>
        <span className="badge">{p.projection}</span> <span className="badge">tile {p.tileSize}</span>{" "}
        <span className="badge">{p.route === "imported" ? "importada" : "guia raster"}</span>{" "}
        {p.furniture.length > 0 && <span className="badge">{p.furniture.length} móvel(is)</span>} {p.connections.length > 0 && <span className="badge">{p.connections.length} ligação(ões)</span>}
      </div>
      <div className="muted">Portas: {p.doors.map((d) => `${d.doorId} (${d.side})`).join(", ")}</div>
      <div className="row">
        <button type="button" className="secondary" onClick={preview}>
          Montar com móveis
        </button>
        <button type="button" className="secondary" onClick={() => setGrid((g) => !g)}>
          {grid ? "Ocultar grade" : "Ver grade"}
        </button>
      </div>
      {grid && p.projection !== "isometric" && (
        <div className="row">
          origem x <input type="number" value={origin[0]} style={{ width: 50 }} onChange={(e) => setOrigin([Number(e.target.value), origin[1]])} /> y{" "}
          <input type="number" value={origin[1]} style={{ width: 50 }} onChange={(e) => setOrigin([origin[0], Number(e.target.value)])} />
          <button type="button" onClick={saveGrid} disabled={origin[0] === p.gridOrigin[0] && origin[1] === p.gridOrigin[1]}>
            Gravar grade
          </button>
        </div>
      )}
      <Message text={message} error />
    </RevisionCard>
  );
}

function LinkRooms({ projectId, catalog, refresh }: { projectId: string; catalog: ScenesCatalog; refresh: () => void }) {
  const rooms = flatRevisions(catalog.rooms, (r) => r.status === "approved");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [aDoor, setADoor] = useState("");
  const [bDoor, setBDoor] = useState("");
  const [result, setResult] = useState<{ link: { ok: boolean; problems: string[]; offsetPx: [number, number] | null; method: string | null }; preview: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const doorsOf = (id: string) => ((rooms.find((r) => r.revision.id === id)?.revision.payload as RoomPayload | undefined)?.doors ?? []).map((d) => d.doorId);
  async function check() {
    try {
      setResult(await apiFetch(scenesApi(projectId, "/rooms/link"), { method: "POST", json: { aRevisionId: a, aDoorId: aDoor, bRevisionId: b, bDoorId: bDoor } }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  async function save() {
    try {
      const room = rooms.find((r) => r.revision.id === b)!.revision.payload as RoomPayload;
      await apiFetch(scenesApi(projectId, "/rooms/edit"), { method: "POST", json: { baseRevisionId: b, connections: [...room.connections.filter((c) => c.doorId !== bDoor), { doorId: bDoor, toRoomRevisionId: a, toDoorId: aDoor }], note: "Porta ligada à outra sala do edifício" } });
      setMessage("Ligação gravada como nova revisão candidata da sala B.");
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }
  return (
    <section>
      <h2>Duas salas de um edifício</h2>
      <div className="row">
        {(
          [
            ["Sala A", a, setA, aDoor, setADoor],
            ["Sala B", b, setB, bDoor, setBDoor],
          ] as const
        ).map(([label, value, set, door, setDoor]) => (
          <label key={label}>
            {label}
            <select value={value} onChange={(e) => (set(e.target.value), setDoor(""), setResult(null))}>
              <option value="">—</option>
              {rooms.map(({ asset, revision }) => (
                <option key={revision.id} value={revision.id}>
                  {asset.name} r{revision.number}
                </option>
              ))}
            </select>
            <select value={door} onChange={(e) => setDoor(e.target.value)}>
              <option value="">porta</option>
              {doorsOf(value).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button type="button" onClick={check} disabled={!a || !b || !aDoor || !bDoor}>
          Conferir e ver juntas
        </button>
      </div>
      {result && (
        <div className="small">
          {result.link.ok ? (
            <p>
              Portas ligadas ({result.link.method === "anchors" ? "âncoras" : "grade"}); B em {result.link.offsetPx?.join(", ")} px de A.{" "}
              <button type="button" onClick={save}>
                Gravar ligação em B
              </button>
            </p>
          ) : (
            result.link.problems.map((p) => (
              <p key={p} className="error">
                {p}
              </p>
            ))
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {result.preview && <img src={result.preview} alt="Duas salas juntas" className="pixel bg-checker" style={{ ...PIXEL, maxWidth: "100%" }} />}
        </div>
      )}
      <Message text={message} />
    </section>
  );
}
