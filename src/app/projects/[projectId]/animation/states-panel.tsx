"use client";

import { useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { type AssetEntry, DIR_LABEL, DIRS, errorText, findRevision, isObject, type Overview, type ProfileInfo, routeLabel, uploadPng, viewUrl } from "./shared";
import { DirectionChecks, PlanActions, ReviewButtons, type RunFn, ViewPicker } from "./temporal-ui";

/**
 * Estados (ferido, congelado, baú aberto) e objetos (cartão S3). O estado é um
 * asset próprio ligado à origem (predecessor + aresta de identidade), com
 * matriz de direções: cada célula é vista aprovada, lacuna explícita (com
 * motivo) ou direção que a fonte não tem. Estado não é rename nem postura.
 */

type Props = { projectId: string; data: Overview; profile: ProfileInfo; run: RunFn; onChanged: () => void };

export function StatesPanel({ projectId, data, profile, run, onChanged }: Props) {
  const rows = data.states;
  const [identityId, setIdentityId] = useState(rows[0]?.identityAssetId ?? "");
  const row = rows.find((r) => r.identityAssetId === identityId) ?? rows[0];
  const sources = row
    ? [{ label: `${row.identityName} (base)`, revisionId: row.identityRevisionId, views: row.directions }, ...row.states.filter((s) => s.approvedRevisionId).map((s) => ({ label: s.name, revisionId: s.approvedRevisionId!, views: s.approvedViews }))]
    : [];
  const [sourceId, setSourceId] = useState("");
  const source = sources.find((s) => s.revisionId === sourceId) ?? sources[0];
  const [stateKey, setStateKey] = useState("");
  const [description, setDescription] = useState("");
  const [directions, setDirections] = useState<Direction[]>([]);
  const route = routeLabel(profile, "state");
  if (!row) return <section className="muted">Nenhuma base ou objeto aprovado ainda.</section>;
  const dirs = directions.filter((d) => source?.views.includes(d));
  const plan =
    source && stateKey.trim() && description.trim() && dirs.length
      ? { operation: "create_state", providerProfileId: profile.id, sourceRevisionId: source.revisionId, stateKey: stateKey.trim(), description: description.trim(), directions: dirs }
      : null;
  return (
    <section>
      <h2>Estados · matriz de direções</h2>
      <p className="small muted">
        Estado visual é arte nova da mesma identidade (ferido, congelado, aberto), num asset próprio vinculado à origem — não é renomear nem trocar a postura de empunhadura. Rota deste perfil: <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
      </p>
      <div className="row">
        <label>
          Identidade
          <select value={row.identityAssetId} onChange={(e) => setIdentityId(e.target.value)}>
            {rows.map((r) => (
              <option key={r.identityAssetId} value={r.identityAssetId}>
                {r.identityName} {r.subject === "object" ? "(objeto)" : "(personagem)"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <StateMatrix projectId={projectId} data={data} row={row} onChanged={onChanged} />
      <h3>Novo estado ou lacuna</h3>
      <div className="row">
        <label>
          Parte de
          <select value={source?.revisionId ?? ""} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.revisionId} value={s.revisionId}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Chave do estado
          <input value={stateKey} onChange={(e) => setStateKey(e.target.value.toLowerCase())} placeholder="ex.: open, wounded" />
        </label>
        <label style={{ flex: 1 }}>
          Mudança visual
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex.: a tampa aberta revela o interior; mesma madeira e ferragens" />
        </label>
      </div>
      <DirectionChecks available={source?.views ?? []} value={dirs} onChange={setDirections} />
      <p className="small muted">Para preencher uma lacuna, marque só a direção faltante: as vistas já aprovadas do estado ficam com os mesmos arquivos.</p>
      <PlanActions projectId={projectId} plan={plan} run={run} label="Gerar estado" />
    </section>
  );
}

function StateMatrix({ projectId, data, row, onChanged }: { projectId: string; data: Overview; row: Overview["states"][number]; onChanged: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const identity = findRevision(data, row.identityRevisionId);
  return (
    <>
      <table className="anim-matrix small">
        <thead>
          <tr>
            <th>Estado</th>
            {DIRS.map((d) => (
              <th key={d} title={DIR_LABEL[d]}>
                {d}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>base · {(identity?.revision.payload as BasePayload | undefined)?.state ?? "default"}</td>
            {DIRS.map((d) => (
              <td key={d} className={row.directions.includes(d) ? "ok" : "none"}>
                {row.directions.includes(d) && identity ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="pixel" alt={d} src={viewUrl(projectId, identity.revision, d) ?? ""} width={32} height={32} />
                ) : (
                  "—"
                )}
              </td>
            ))}
            <td />
          </tr>
          {row.states.map((s) => {
            const approved = findRevision(data, s.approvedRevisionId);
            return (
              <tr key={s.assetId}>
                <td>{s.stateKey}</td>
                {DIRS.map((d) => {
                  const gap = s.gaps.find((g) => g.direction === d);
                  if (s.approvedViews.includes(d) && approved)
                    return (
                      <td key={d} className="ok">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img className="pixel" alt={d} src={viewUrl(projectId, approved.revision, d) ?? ""} width={32} height={32} />
                      </td>
                    );
                  if (row.directions.includes(d))
                    return (
                      <td key={d} className="gap" title={gap?.reason ?? "ainda não gerada"}>
                        lacuna
                      </td>
                    );
                  return (
                    <td key={d} className="none" title="a fonte não tem esta vista">
                      —
                    </td>
                  );
                })}
                <td>
                  <button type="button" className="secondary" onClick={() => setOpen(open === s.assetId ? null : s.assetId)}>
                    Revisões ({s.revisions.filter((r) => r.status === "candidate").length} candidata(s))
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {row.states
        .filter((s) => s.assetId === open)
        .map((s) => (
          <div key={s.assetId} className="anim-candidates">
            {s.revisions.map((r) => {
              const found = findRevision(data, r.id);
              if (!found) return null;
              return (
                <article key={r.id} className="small">
                  <p>
                    r{r.number} · <span className={`badge state-${r.status}`}>{r.status}</span> · {r.views.join(", ")} · {r.operation ?? ""}{" "}
                    <ReviewButtons projectId={projectId} assetId={s.assetId} revision={found.revision} activeRevisionId={s.approvedRevisionId} onChanged={onChanged} />
                  </p>
                  {r.status === "candidate" && (found.revision.payload as BasePayload).views.length > 1 && <ViewPicker projectId={projectId} revision={found.revision} onPublished={() => onChanged()} />}
                </article>
              );
            })}
          </div>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Objetos: identidade com vistas e animação de objeto
// ---------------------------------------------------------------------------

export function ObjectsPanel({ projectId, data, profile, run, onChanged }: Props) {
  const objects = data.bases.filter(isObject);
  const [objectId, setObjectId] = useState("");
  const entry: AssetEntry | undefined = objects.find((o) => o.asset.id === objectId) ?? objects[0];
  const approved = entry?.revisions.find((r) => r.id === entry.asset.approvedRevisionId) ?? null;
  const payload = approved ? (approved.payload as BasePayload) : null;
  return (
    <section>
      <h2>Objetos · vistas e animação</h2>
      <p className="small muted">
        Objeto (baú, tocha) é uma base sem rig humanoide: tem vistas, estados e clipes próprios. Vistas novas saem uma direção por vez na aba Vistas (rotação por direção); espelho de vistas só pela Biblioteca, como derivação explícita.
      </p>
      <NewObject projectId={projectId} data={data} onCreated={onChanged} />
      {objects.length > 0 && (
        <div className="row">
          <label>
            Objeto
            <select value={entry?.asset.id ?? ""} onChange={(e) => setObjectId(e.target.value)}>
              {objects.map((o) => (
                <option key={o.asset.id} value={o.asset.id}>
                  {o.asset.name}
                  {o.asset.approvedRevisionId ? "" : " (sem aprovação)"}
                </option>
              ))}
            </select>
          </label>
          {approved && payload && (
            <span className="small muted">
              r{approved.number} · {payload.logicalSize.join("×")} · apoio {payload.groundOrigin.join(",")} · estado {payload.state} · vistas {payload.views.map((v) => v.direction).join(", ")}
            </span>
          )}
        </div>
      )}
      {entry && (
        <div className="anim-candidates">
          {entry.revisions
            .filter((r) => r.status === "candidate")
            .map((r) => (
              <article key={r.id} className="small">
                <p>
                  Candidata r{r.number} · {(r.payload as BasePayload).views.map((v) => v.direction).join(", ")} · {(r.technicalReport as { routeLabel?: string; operation?: string } | null)?.routeLabel ?? (r.technicalReport as { operation?: string } | null)?.operation ?? r.origin}{" "}
                  <ReviewButtons projectId={projectId} assetId={entry.asset.id} revision={r} activeRevisionId={entry.asset.approvedRevisionId} onChanged={onChanged} />
                </p>
                {(r.payload as BasePayload).views.length > 1 && <ViewPicker projectId={projectId} revision={r} onPublished={() => onChanged()} />}
              </article>
            ))}
        </div>
      )}
      {approved && payload && entry && (
        <AnimateObject projectId={projectId} data={data} profile={profile} object={entry} revisionId={approved.id} views={payload.views.map((v) => v.direction)} run={run} />
      )}
    </section>
  );
}

function NewObject({ projectId, data, onCreated }: { projectId: string; data: Overview; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("S");
  const [file, setFile] = useState<File | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const sources = data.imageSources.flatMap((s) => s.files.map((f) => ({ key: `${s.revisionId}|${f.fileKey}`, label: `${s.name} · ${f.fileKey}${f.width ? ` (${f.width}×${f.height})` : ""}`, revisionId: s.revisionId, fileKey: f.fileKey })));
  return (
    <details className="small">
      <summary>Novo objeto a partir de imagem</summary>
      <div className="row">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Baú" />
        </label>
        <label>
          Vista
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            {DIRS.map((d) => (
              <option key={d} value={d}>
                {d} · {DIR_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          PNG local
          <input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          ou imagem aprovada
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">—</option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!name.trim() || (!file && !sourceKey)}
          onClick={async () => {
            setMessage(null);
            try {
              const src = sources.find((s) => s.key === sourceKey);
              const image = file ? { from: "upload", uploadId: await uploadPng(projectId, file, file.name) } : { from: "revision", revisionId: src!.revisionId, fileKey: src!.fileKey };
              await apiFetch(`/projects/${projectId}/animation/objects`, { method: "POST", json: { name: name.trim(), image, direction } });
              setMessage("Objeto criado como candidata: aprove-o abaixo para gerar vistas, estados e animação.");
              onCreated();
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          Criar objeto
        </button>
      </div>
      {message && <p>{message}</p>}
    </details>
  );
}

function AnimateObject({ projectId, data, profile, object, revisionId, views, run }: { projectId: string; data: Overview; profile: ProfileInfo; object: AssetEntry; revisionId: string; views: Direction[]; run: RunFn }) {
  const [direction, setDirection] = useState<Direction>(views[0] ?? "S");
  const [action, setAction] = useState("open");
  const [description, setDescription] = useState("");
  const [frames, setFrames] = useState(4);
  const [ms, setMs] = useState(100);
  const [playback, setPlayback] = useState<ClipPayload["playback"]>("once");
  const [keep, setKeep] = useState<boolean | null>(null);
  const [endId, setEndId] = useState("");
  const route = routeLabel(profile, "objectAnimation");
  const keepFirst = keep ?? playback !== "loop";
  const ends = useMemo(() => {
    const row = data.states.find((r) => r.identityAssetId === object.asset.id);
    return (row?.states ?? []).filter((s) => s.approvedRevisionId && s.approvedViews.includes(direction)).map((s) => ({ id: s.approvedRevisionId!, label: s.name }));
  }, [data.states, object.asset.id, direction]);
  const plan =
    description.trim() && action.trim()
      ? {
          operation: "animate_object",
          providerProfileId: profile.id,
          objectRevisionId: revisionId,
          direction,
          action: action.trim(),
          description: description.trim(),
          durationsMs: Array(frames).fill(ms),
          playback,
          keepFirstFrame: keepFirst,
          ...(endId ? { endFrame: { revisionId: endId, direction } } : {}),
        }
      : null;
  return (
    <div>
      <h3>Animar objeto</h3>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span> · sem esqueleto humanoide; o pivô é o apoio do objeto.
      </p>
      <div className="row">
        <label>
          Direção
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            {views.map((d) => (
              <option key={d} value={d}>
                {d} · {DIR_LABEL[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ação
          <input value={action} onChange={(e) => setAction(e.target.value.toLowerCase())} />
        </label>
        <label style={{ flex: 1 }}>
          Movimento
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="ex.: a tampa se abre devagar e para no alto" />
        </label>
      </div>
      <div className="row">
        <label>
          Quadros gerados
          <input type="number" min={1} max={40} value={frames} onChange={(e) => setFrames(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
        </label>
        <label>
          ms por quadro
          <input type="number" min={1} max={60000} value={ms} onChange={(e) => setMs(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label>
          Repetição
          <select value={playback} onChange={(e) => setPlayback(e.target.value as ClipPayload["playback"])}>
            <option value="once">uma vez</option>
            <option value="loop">ciclo</option>
            <option value="ping_pong">vai e volta</option>
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }} title="A vista aprovada entra como quadro 0 (pixels exatos) e o clipe tem um quadro a mais que os gerados">
          <input type="checkbox" checked={keepFirst} onChange={(e) => setKeep(e.target.checked)} /> manter a vista como quadro 0
        </label>
        <label>
          Pose final (opcional)
          <select value={endId} onChange={(e) => setEndId(e.target.value)}>
            <option value="">—</option>
            {ends.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="small muted">
        Resultado esperado: {frames + (keepFirst ? 1 : 0)} quadros ({keepFirst ? "ref + " : ""}
        {frames} gerados). O modelo desenha os gerados numa folha, fatiada e assentada no apoio localmente.
      </p>
      <PlanActions projectId={projectId} plan={route.ok ? plan : null} run={run} label="Animar objeto" />
    </div>
  );
}
