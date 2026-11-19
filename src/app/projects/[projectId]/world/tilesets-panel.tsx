"use client";

import { useState } from "react";
import { type CornerTilesetPayload, DEFAULT_SIDE_REQUIRED, type IsoTilesetPayload, SIDE_CONFIGURATIONS, type SideConfiguration, type SideTilesetPayload, type TexturePayload } from "@/contracts";
import type { AssetView, RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { JobStatus } from "./job-status";
import { errorText, estimateLabel, fileOf, mediaUrl, PIXEL, type PlanPreview, type Profile, review, runPlan, uploadImage, type WorldCatalog } from "./world-client";

/**
 * Tilesets (06 §autotile, §cobertura lateral, §payload isométrico): gabarito
 * local a partir de texturas aprovadas, importação com layout declarado,
 * verificação de emendas/lacunas/losangos e geração guiada pelo gabarito.
 */

type Kind = "corner" | "sidescroller" | "isometric";
const KIND_LABEL: Record<Kind, string> = { corner: "Top-down por cantos (16 máscaras)", sidescroller: "Lateral (tabela de plataforma)", isometric: "Isométrico (losangos e props)" };
const CHECK_KEYS = [
  ["check-sample-zoom", "Amostra montada pelas chaves"],
  ["check-pairs", "Piores pares de vizinhos"],
  ["check-patch-zoom", "Retalho: 4 losangos, prop alto, apoio e personagem atrás/à frente"],
] as const;

interface CheckView {
  report: Record<string, unknown>;
  warnings: string[];
  previews: Record<string, string>;
}

export function TilesetsPanel({ projectId, catalog, profiles, refresh }: { projectId: string; catalog: WorldCatalog; profiles: Profile[]; refresh: () => void }) {
  const [message, setMessage] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckView>>({});
  const [guided, setGuided] = useState<{ asset: AssetView; revision: RevisionView } | null>(null);
  const approvedTextures = catalog.textures.flatMap(({ asset, revisions }) => revisions.filter((r) => r.status === "approved").map((r) => ({ asset, revision: r })));

  async function decide(asset: AssetView, revision: RevisionView, decision: "approve" | "reject") {
    try {
      const reason = decision === "reject" ? (window.prompt("Motivo da reprovação") ?? "").trim() || null : null;
      if (decision === "reject" && !reason) return;
      await review(projectId, asset, revision.id, decision, reason);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  async function check(revision: RevisionView) {
    try {
      const res = await apiFetch<CheckView>(`/projects/${projectId}/world/tilesets/check`, { method: "POST", json: { revisionId: revision.id } });
      setChecks((c) => ({ ...c, [revision.id]: res }));
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <>
      {message && <p className="error">{message}</p>}
      <div className="grid2">
        <TemplateForm projectId={projectId} textures={approvedTextures} refresh={refresh} />
        <ImportForm projectId={projectId} refresh={refresh} />
      </div>
      <section>
        <h2>Tilesets do projeto</h2>
        {catalog.tilesets.length === 0 && <p className="muted small">Nenhum tileset. Aprove duas texturas e monte um gabarito, ou importe um atlas.</p>}
        {catalog.tilesets.map(({ asset, revisions }) => (
          <div key={asset.id} style={{ marginBottom: 16 }}>
            <strong>{asset.name}</strong> <span className="muted small">{KIND_LABEL[asset.kind as Kind]}</span>
            {revisions.slice(0, 4).map((rev) => (
              <TilesetRevision
                key={rev.id}
                projectId={projectId}
                asset={asset}
                revision={rev}
                check={checks[rev.id] ?? null}
                onCheck={() => check(rev)}
                onDecide={(d) => decide(asset, rev, d)}
                onGuided={() => setGuided({ asset, revision: rev })}
              />
            ))}
          </div>
        ))}
      </section>
      {guided && <GuidedForm projectId={projectId} profiles={profiles} textures={approvedTextures} target={guided} refresh={refresh} onClose={() => setGuided(null)} />}
    </>
  );
}

function TilesetRevision(props: {
  projectId: string;
  asset: AssetView;
  revision: RevisionView;
  check: CheckView | null;
  onCheck: () => void;
  onDecide: (d: "approve" | "reject") => void;
  onGuided: () => void;
}) {
  const { projectId, asset, revision, check } = props;
  const kind = asset.kind as Kind;
  const payload = revision.payload as CornerTilesetPayload | SideTilesetPayload | IsoTilesetPayload;
  const atlas = fileOf(revision, payload.atlas.fileId);
  const tr = revision.technicalReport as { routeLabel?: string; check?: Record<string, unknown>; warnings?: string[] } | null;
  const report = check?.report ?? tr?.check ?? null;
  const warnings = check?.warnings ?? tr?.warnings ?? [];
  const media = (key: string) => {
    const f = fileOf(revision, key);
    return f ? mediaUrl(props.projectId, f.id) : null;
  };
  return (
    <div className="small" style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8, marginTop: 6 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span>
          r{revision.number} <span className={`badge state-${revision.status}`}>{revision.status}</span> · {revision.origin}
          {"complete" in payload ? <span className={`badge ${payload.complete ? "state-approved" : "state-rejected"}`}>{payload.complete ? "completo" : "incompleto"}</span> : null}
        </span>
        <span className="row">
          <button type="button" className="secondary" onClick={props.onCheck}>
            Verificar
          </button>
          {revision.status === "approved" && (
            <button type="button" className="secondary" onClick={props.onGuided}>
              Gerar guiado por este gabarito
            </button>
          )}
          {revision.status === "candidate" && (
            <>
              <button type="button" onClick={() => props.onDecide("approve")}>
                Aprovar
              </button>
              <button type="button" className="secondary" onClick={() => props.onDecide("reject")}>
                Reprovar
              </button>
            </>
          )}
        </span>
      </div>
      {tr?.routeLabel && <p className="muted">{tr.routeLabel}</p>}
      <div className="row" style={{ alignItems: "flex-start" }}>
        {atlas && kind === "corner" && <MaskGrid src={mediaUrl(projectId, atlas.id)} payload={payload as CornerTilesetPayload} />}
        {atlas && kind !== "corner" && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(projectId, atlas.id)} alt="Atlas" className="pixel bg-checker" style={{ ...PIXEL, width: Math.min(480, Number(atlas.metadata.width) * 3) }} />
        )}
        <div style={{ minWidth: 260, flex: 1 }}>
          {kind === "sidescroller" && <SideTable payload={payload as SideTilesetPayload} />}
          {kind === "isometric" && <IsoTable payload={payload as IsoTilesetPayload} />}
          {report && <CheckSummary kind={kind} report={report} />}
          {warnings.length > 0 && (
            <ul>
              {warnings.map((w, i) => (
                <li key={i} className="error">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {CHECK_KEYS.map(([key, label]) => {
          const src = check ? check.previews[key.replace("check-", "").replace("-zoom", "_zoom")] : media(key);
          return src ? (
            <figure key={key} style={{ margin: 0 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={label} style={{ ...PIXEL, maxWidth: 520 }} />
              <figcaption>{label}</figcaption>
            </figure>
          ) : null;
        })}
      </div>
    </div>
  );
}

/** As 16 máscaras pelo atlas, com o número e os cantos de B (NO=1, NE=2, SE=4, SO=8); ausente em vermelho. */
function MaskGrid({ src, payload }: { src: string; payload: CornerTilesetPayload }) {
  const [cw, ch] = payload.cellSize;
  const scale = Math.max(1, Math.floor(64 / cw));
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(4, ${cw * scale}px)`, gap: 4 }}>
      {Array.from({ length: 16 }, (_, m) => {
        const tile = payload.tiles.find((t) => t.mask === m && t.variant === 0) ?? payload.tiles.find((t) => t.mask === m);
        return (
          <div key={m} title={`máscara ${m}`} style={{ position: "relative", width: cw * scale, height: ch * scale, outline: tile ? "1px solid var(--border)" : "2px solid var(--error)" }}>
            {tile && (
              <div
                className="pixel"
                style={{
                  ...PIXEL,
                  width: cw * scale,
                  height: ch * scale,
                  backgroundImage: `url(${src})`,
                  backgroundPosition: `${-tile.rect[0] * scale}px ${-tile.rect[1] * scale}px`,
                  backgroundSize: `${(payload.tiles.reduce((n, t) => Math.max(n, t.rect[0] + t.rect[2]), 0)) * scale}px auto`,
                }}
              />
            )}
            <span className="small" style={{ position: "absolute", left: 2, top: 0, color: "#fff", textShadow: "0 0 2px #000" }}>
              {m}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SideTable({ payload }: { payload: SideTilesetPayload }) {
  const present = new Set(payload.tiles.map((t) => t.configuration));
  return (
    <p>
      Corpo: {payload.platformMaterial} · superfície: {payload.surfaceMaterial} · linha caminhável y={payload.walkableLineY}
      <br />
      {SIDE_CONFIGURATIONS.map((c) => {
        const required = payload.requiredConfigurations.includes(c);
        const has = present.has(c);
        return (
          <span key={c} className={`badge ${has ? "state-approved" : required ? "state-rejected" : ""}`} style={{ marginRight: 4 }}>
            {c}
            {required ? "*" : ""}
            {!has ? " ✗" : ""}
          </span>
        );
      })}
      <br />
      <span className="muted">* exigida. Ausência exigida impede declarar o conjunto completo.</span>
    </p>
  );
}

function IsoTable({ payload }: { payload: IsoTilesetPayload }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Peça</th>
          <th>Tipo</th>
          <th>Tamanho</th>
          <th>groundOrigin</th>
          <th>supportPoint</th>
          <th>Footprint</th>
          <th>Elev.</th>
        </tr>
      </thead>
      <tbody>
        {payload.pieces.map((p) => (
          <tr key={p.pieceKey}>
            <td>{p.name}</td>
            <td>{p.kind}</td>
            <td>{p.logicalSize.join("×")}</td>
            <td>{p.groundOrigin.join(", ")}</td>
            <td>{p.supportPoint.join(", ")}</td>
            <td>{p.footprintCells.join("×")}</td>
            <td>{p.elevation}</td>
          </tr>
        ))}
      </tbody>
      <caption className="muted" style={{ captionSide: "bottom", textAlign: "left" }}>
        Losango {payload.groundDiamondSize.join("×")} px · degrau {payload.elevationStepPx} px · ordem {payload.sortRule}
      </caption>
    </table>
  );
}

function CheckSummary({ kind, report }: { kind: Kind; report: Record<string, unknown> }) {
  if (kind === "isometric") {
    const r = report as { floors?: { key: string; iou: number; ok: boolean }[]; props?: { key: string; ok: boolean; dx?: number; dy?: number }[]; patch?: { holes: number; overlaps: number }; placements?: { key: string; ok: boolean }[] };
    return (
      <p>
        Losangos: {r.floors?.map((f) => `${f.key} IoU ${f.iou} ${f.ok ? "✓" : "✗"}`).join(" · ") || "—"}
        <br />
        Retalho 2×2: {r.patch ? `${r.patch.holes} buraco(s), ${r.patch.overlaps} sobreposição(ões)` : "—"}
        <br />
        Apoio dos props: {r.props?.map((p) => `${p.key} ${p.ok ? "✓" : "✗"} (dx ${p.dx}, dy ${p.dy})`).join(" · ") || "—"} · no centro da célula:{" "}
        {r.placements?.every((p) => p.ok) ? "✓" : "✗"}
      </p>
    );
  }
  const r = report as { pairs?: { x: number; y: number }; flagged?: { axis: string; a: string; b: string; ratio: number }[]; missingMasks?: number[]; gaps?: string[]; maxRatio?: number; locked?: { passed: boolean } | null; threshold?: number };
  return (
    <p>
      Pares conferidos: {r.pairs ? `${r.pairs.x} horizontais, ${r.pairs.y} verticais` : "—"} · pior razão {r.maxRatio ?? "—"} (limiar {r.threshold})
      <br />
      Costuras discrepantes: {r.flagged?.length ? r.flagged.slice(0, 6).map((f) => `${f.a}${f.axis === "x" ? "→" : "↓"}${f.b} (${f.ratio})`).join(", ") : "nenhuma"}
      {kind === "corner" && (
        <>
          <br />
          Máscaras ausentes: {r.missingMasks?.length ? r.missingMasks.join(", ") : "nenhuma"}
        </>
      )}
      {kind === "sidescroller" && (
        <>
          <br />
          Lacunas na amostra (plataforma, vão, degraus): {r.gaps?.length ? r.gaps.join(", ") : "nenhuma"}
        </>
      )}
      {r.locked && (
        <>
          <br />
          Faixa travada igual ao gabarito: {r.locked.passed ? "✓" : "✗"}
        </>
      )}
    </p>
  );
}

type ApprovedTexture = { asset: AssetView; revision: RevisionView };

function TextureSelect({ label, value, onChange, textures }: { label: string; value: string; onChange: (v: string) => void; textures: ApprovedTexture[] }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {textures.map(({ asset, revision }) => (
          <option key={revision.id} value={revision.id}>
            {asset.name} r{revision.number} ({(revision.payload as TexturePayload).logicalSize.join("×")})
          </option>
        ))}
      </select>
    </label>
  );
}

function TemplateForm({ projectId, textures, refresh }: { projectId: string; textures: ApprovedTexture[]; refresh: () => void }) {
  const [kind, setKind] = useState<Kind>("corner");
  const [name, setName] = useState("Grama ↔ água");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [terrains, setTerrains] = useState([
    { terrainId: "grass", name: "Grama", color: "#469632" },
    { terrainId: "water", name: "Água", color: "#3264c8" },
  ]);
  const [diagonals, setDiagonals] = useState({ mask5: "separate", mask10: "separate" });
  const [band, setBand] = useState(4);
  const [configs, setConfigs] = useState<SideConfiguration[]>([...SIDE_CONFIGURATIONS]);
  const [prop, setProp] = useState<File | null>(null);
  const [support, setSupport] = useState("");
  const [occluder, setOccluder] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      let template: Record<string, unknown>;
      if (kind === "corner") template = { kind, materialA: a, materialB: b, terrains, diagonals, bandPx: band };
      else if (kind === "sidescroller") template = { kind, body: a, surface: b, configurations: configs, requiredConfigurations: [...DEFAULT_SIDE_REQUIRED] };
      else {
        const sp = support.split(",").map((n) => Number(n.trim()));
        const occ = occluder.trim() ? occluder.split(",").map((n) => Number(n.trim())) : null;
        template = {
          kind,
          floor: a,
          // Apoio vazio = base visual do prop, medida localmente (o retalho confere de novo).
          prop: prop ? { image: { from: "upload", uploadId: await uploadImage(projectId, prop, prop.name) }, name: prop.name.replace(/\.[^.]+$/, ""), ...(support.trim() ? { supportPoint: sp } : {}), occluderRect: occ } : null,
        };
      }
      const res = await apiFetch<{ revision: RevisionView; check: { warnings: string[] } }>(`/projects/${projectId}/world/tilesets/template`, { method: "POST", json: { target: { name }, template } });
      setMessage(`r${res.revision.number} publicada como candidata${res.check.warnings.length ? ` · ${res.check.warnings.join(" · ")}` : " · verificação sem alertas"}`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Gabarito local a partir de texturas aprovadas</h2>
      <p className="small muted">Composição local das texturas pelas regras do tileset: não é geração nativa de tileset (fica identificado na revisão).</p>
      <div className="row">
        <label>
          Tipo
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <div className="row">
        <TextureSelect label={kind === "corner" ? "Terreno A" : kind === "sidescroller" ? "Corpo da plataforma" : "Chão (projetado no losango)"} value={a} onChange={setA} textures={textures} />
        {kind !== "isometric" && <TextureSelect label={kind === "corner" ? "Terreno B" : "Superfície caminhável"} value={b} onChange={setB} textures={textures} />}
      </div>
      {kind === "corner" && (
        <>
          <div className="row">
            {terrains.map((t, i) => (
              <span key={i} className="row">
                <label>
                  Chave {i ? "B" : "A"}
                  <input value={t.terrainId} onChange={(e) => setTerrains(terrains.map((x, j) => (j === i ? { ...x, terrainId: e.target.value } : x)))} style={{ width: 80 }} />
                </label>
                <label>
                  Nome
                  <input value={t.name} onChange={(e) => setTerrains(terrains.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} style={{ width: 90 }} />
                </label>
                <label>
                  Cor
                  <input type="color" value={t.color} onChange={(e) => setTerrains(terrains.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)))} />
                </label>
              </span>
            ))}
          </div>
          <div className="row">
            {(["mask5", "mask10"] as const).map((m) => (
              <label key={m}>
                Diagonal {m === "mask5" ? "5 (NO+SE)" : "10 (NE+SO)"}
                <select value={diagonals[m]} onChange={(e) => setDiagonals({ ...diagonals, [m]: e.target.value })}>
                  <option value="separate">separada pelo centro</option>
                  <option value="connected">conectada pelo centro</option>
                </select>
              </label>
            ))}
            <label>
              Faixa travada (px)
              <input type="number" min={1} max={8} value={band} onChange={(e) => setBand(Number(e.target.value))} style={{ width: 60 }} />
            </label>
          </div>
        </>
      )}
      {kind === "sidescroller" && (
        <div className="row">
          {SIDE_CONFIGURATIONS.map((c) => (
            <label key={c} style={{ flexDirection: "row", gap: 3, color: "inherit" }}>
              <input type="checkbox" checked={configs.includes(c)} onChange={(e) => setConfigs(e.target.checked ? [...configs, c] : configs.filter((x) => x !== c))} />
              {c}
              {DEFAULT_SIDE_REQUIRED.includes(c) ? "*" : ""}
            </label>
          ))}
        </div>
      )}
      {kind === "isometric" && (
        <div className="row">
          <label>
            Prop alto (PNG transparente, opcional)
            <input type="file" accept="image/png" onChange={(e) => setProp(e.target.files?.[0] ?? null)} />
          </label>
          <label>
            Apoio x,y (px do prop)
            <input value={support} placeholder="auto (base visual)" onChange={(e) => setSupport(e.target.value)} style={{ width: 120 }} />
          </label>
          <label>
            Região de oclusão x,y,w,h
            <input value={occluder} placeholder="ex.: 0,0,48,66" onChange={(e) => setOccluder(e.target.value)} style={{ width: 120 }} />
          </label>
        </div>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={busy || !a || (kind !== "isometric" && !b)} onClick={submit}>
          Montar gabarito e verificar
        </button>
      </div>
      {message && <p className="small">{message}</p>}
    </section>
  );
}

const IMPORT_EXAMPLE: Record<Kind, string> = {
  corner: JSON.stringify(
    {
      projection: "top_down",
      cellSize: [32, 32],
      atlas: { margin: 0, spacing: 0 },
      terrains: [
        { terrainId: "grass", name: "Grama", color: "#469632" },
        { terrainId: "water", name: "Água", color: "#3264c8" },
      ],
      diagonals: { mask5: "separate", mask10: "separate" },
      tiles: Array.from({ length: 16 }, (_, m) => ({ tileKey: `gw-${m}`, mask: m, variant: 0, weight: 1, rect: [(m % 4) * 32, Math.floor(m / 4) * 32, 32, 32], frames: [] })),
      complete: true,
    },
    null,
    1,
  ),
  sidescroller: JSON.stringify(
    {
      projection: "side",
      cellSize: [16, 16],
      atlas: { margin: 0, spacing: 0 },
      platformMaterial: "terra",
      surfaceMaterial: "grama",
      walkableLineY: 0,
      requiredConfigurations: DEFAULT_SIDE_REQUIRED,
      tiles: DEFAULT_SIDE_REQUIRED.map((c, i) => ({ tileKey: `side-${c}`, configuration: c, variant: 0, weight: 1, rect: [i * 16, 0, 16, 16], frames: [] })),
      complete: true,
    },
    null,
    1,
  ),
  isometric: JSON.stringify(
    {
      projection: "isometric",
      groundDiamondSize: [64, 32],
      logicalCellSize: [32, 32],
      elevationStepPx: 16,
      sortRule: "depth_ij_elevation_v1",
      atlas: { margin: 0, spacing: 0 },
      pieces: [{ pieceKey: "floor", kind: "floor", name: "Chão", rect: [0, 0, 64, 32], logicalSize: [64, 32], groundOrigin: [32, 0], supportPoint: [32, 16], footprintCells: [1, 1], elevation: 0, occluderRect: null, blocksMovement: false }],
    },
    null,
    1,
  ),
};

function ImportForm({ projectId, refresh }: { projectId: string; refresh: () => void }) {
  const [kind, setKind] = useState<Kind>("corner");
  const [name, setName] = useState("Atlas importado");
  const [file, setFile] = useState<File | null>(null);
  const [layout, setLayout] = useState(IMPORT_EXAMPLE.corner);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const payload = JSON.parse(layout) as Record<string, unknown>;
      const uploadId = await uploadImage(projectId, file, file.name);
      const res = await apiFetch<{ revision: RevisionView; check: { warnings: string[] } }>(`/projects/${projectId}/world/tilesets/import`, {
        method: "POST",
        json: { target: { name }, kind, atlas: { image: { from: "upload", uploadId }, payload } },
      });
      setMessage(`r${res.revision.number} importada${res.check.warnings.length ? ` · ${res.check.warnings.join(" · ")}` : ""}`);
      refresh();
    } catch (err) {
      setMessage(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h2>Importar atlas</h2>
      <p className="small muted">Declare as chaves e o caso de cada região do atlas; um atlas sem esse mapeamento não satisfaz os casos só por ser uma folha de tiles.</p>
      <div className="row">
        <label>
          Tipo
          <select value={kind} onChange={(e) => (setKind(e.target.value as Kind), setLayout(IMPORT_EXAMPLE[e.target.value as Kind]))}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <label>
        Layout (payload do tileset em JSON)
        <textarea value={layout} onChange={(e) => setLayout(e.target.value)} style={{ minHeight: 140, fontFamily: "monospace", fontSize: 11 }} />
      </label>
      <button type="button" disabled={busy || !file} onClick={submit}>
        Importar e verificar
      </button>
      {message && <p className="small">{message}</p>}
    </section>
  );
}

function GuidedForm(props: { projectId: string; profiles: Profile[]; textures: ApprovedTexture[]; target: { asset: AssetView; revision: RevisionView }; refresh: () => void; onClose: () => void }) {
  const { projectId, target } = props;
  const usable = props.profiles.filter((p) => (p.capabilities.generate_tileset?.length ?? 0) > 0);
  const [profileId, setProfileId] = useState("");
  const [instruction, setInstruction] = useState("acabamento de pixel art mais rico, mantendo as áreas e as bordas");
  const [band, setBand] = useState(4);
  const [materials, setMaterials] = useState<string[]>([]);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const profile = usable.find((p) => p.id === profileId) ?? usable[0];

  async function plan() {
    setMessage(null);
    try {
      if (!profile) throw new Error("Nenhum perfil edita a partir de gabarito");
      const p = await apiFetch<PlanPreview>(`/projects/${projectId}/generation-plans`, {
        method: "POST",
        json: { operation: "generate_tileset", providerProfileId: profile.id, guideRevisionId: target.revision.id, instruction, lockedBandPx: band, materialRevisionIds: materials },
      });
      setPreview(p);
      return p;
    } catch (err) {
      setMessage(errorText(err));
      return null;
    }
  }

  async function run() {
    const p = preview ?? (await plan());
    if (!p) return;
    try {
      setJobId((await runPlan(projectId, p, target.asset.id)).job.id);
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>
          Gerar guiado · {target.asset.name} r{target.revision.number}
        </h2>
        <button type="button" className="secondary" onClick={props.onClose}>
          Fechar
        </button>
      </div>
      <p className="small muted">
        O gabarito aprovado vai como guia; o candidato volta à grade do atlas, a faixa travada é reaplicada e as emendas são conferidas. Rota genérica com referências — não é geração nativa de tileset, que exige um
        perfil com essa capacidade.
      </p>
      <label>
        Instrução
        <textarea value={instruction} maxLength={500} onChange={(e) => (setInstruction(e.target.value), setPreview(null))} />
      </label>
      <div className="row">
        <label>
          Perfil
          <select value={profile?.id ?? ""} onChange={(e) => (setProfileId(e.target.value), setPreview(null))}>
            {usable.length === 0 && <option value="">Nenhum perfil disponível</option>}
            {usable.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        {target.asset.kind !== "isometric" && (
          <label>
            Faixa travada (px)
            <input type="number" min={0} max={8} value={band} onChange={(e) => (setBand(Number(e.target.value)), setPreview(null))} style={{ width: 60 }} />
          </label>
        )}
        <label>
          Materiais de referência
          <select multiple value={materials} onChange={(e) => (setMaterials([...e.target.selectedOptions].map((o) => o.value)), setPreview(null))}>
            {props.textures.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary" onClick={plan}>
          Prévia do plano
        </button>
        <button type="button" onClick={run}>
          Gerar
        </button>
      </div>
      {preview && (
        <div className="small">
          <p>
            {preview.routeLabel} · destino {preview.destination.name}
            {preview.destination.simulated ? " (simulado: devolve o próprio gabarito)" : ""} · estimativa {estimateLabel(preview.plan)}
          </p>
          <pre style={{ whiteSpace: "pre-wrap" }}>{preview.plan.prompt.compiled}</pre>
        </div>
      )}
      {message && <p className="error small">{message}</p>}
      {jobId && <JobStatus projectId={projectId} jobId={jobId} onDone={props.refresh} />}
    </section>
  );
}
