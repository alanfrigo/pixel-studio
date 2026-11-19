"use client";

import { useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { errorText, type Overview } from "./shared";
import { DirectionChecks, ReviewButtons } from "./temporal-ui";

/**
 * Biblioteca (cartão S3): etiquetas (sem revisão), duplicar, separar direções,
 * excluir direção/quadro/parte, espelho explícito e canvas. Tudo é local:
 * nenhuma chamada paga, revisões anteriores intactas (pacotes exportados antes
 * continuam resolvendo os mesmos IDs e hashes).
 */

const MIRROR_PAIR: Partial<Record<Direction, Direction>> = { E: "W", W: "E", NE: "NW", NW: "NE", SE: "SW", SW: "SE" };

export function LibraryPanel({ projectId, data, onChanged }: { projectId: string; data: Overview; onChanged: () => void }) {
  const entries = [...data.bases.map((e) => ({ ...e, kind: "base" as const })), ...data.clips.map((e) => ({ ...e, kind: "clip" as const }))];
  const [assetId, setAssetId] = useState("");
  const entry = entries.find((e) => e.asset.id === assetId) ?? entries[0];
  const [revisionId, setRevisionId] = useState("");
  const revision = entry?.revisions.find((r) => r.id === revisionId) ?? entry?.revisions.find((r) => r.id === entry.asset.approvedRevisionId) ?? entry?.revisions[0];
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<{ assetId: string; revision: RevisionView } | null>(null);
  if (!entry || !revision) return <section className="muted">Biblioteca vazia.</section>;

  async function call(path: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) {
    setMessage(null);
    setCreated(null);
    try {
      const res = await apiFetch<Record<string, unknown>>(`/projects/${projectId}/library/${path}`, { method: "POST", json: body });
      setMessage(describe(res));
      const rev = (res.revision as RevisionView | undefined) ?? ((res.created as { revision: RevisionView }[] | undefined)?.[0]?.revision ?? null);
      if (rev) setCreated({ assetId: rev.assetId, revision: rev });
      onChanged();
    } catch (err) {
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>Biblioteca</h2>
      <p className="small muted">Operações locais: zero chamadas pagas. Cada uma publica revisão candidata nova (aprove no fluxo de revisão); as anteriores e os pacotes já exportados ficam como estão.</p>
      <div className="row">
        <label>
          Asset
          <select value={entry.asset.id} onChange={(e) => (setAssetId(e.target.value), setRevisionId(""))}>
            {entries.map((e) => (
              <option key={e.asset.id} value={e.asset.id}>
                {e.asset.name} ({e.kind === "clip" ? "clipe" : (e.revisions[0]?.payload as BasePayload | undefined)?.subject === "object" ? "objeto" : "base"})
              </option>
            ))}
          </select>
        </label>
        <label>
          Revisão
          <select value={revision.id} onChange={(e) => setRevisionId(e.target.value)}>
            {entry.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                r{r.number} · {r.status}
                {r.id === entry.asset.approvedRevisionId ? " · ativa" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Tags key={entry.asset.id} projectId={projectId} assetId={entry.asset.id} initial={data.tags[entry.asset.id] ?? []} onSaved={onChanged} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => call("duplicate", { revisionId: revision.id }, (r) => `Cópia criada: ${(r.asset as { name: string }).name} (mesmos arquivos).`)}>
          Duplicar
        </button>
        {entry.kind === "base" && (revision.payload as BasePayload).views.length > 1 && (
          <button type="button" className="secondary" onClick={() => call("ungroup", { revisionId: revision.id }, (r) => `${(r.created as unknown[]).length} asset(s) por direção criados (mesmos blobs).`)}>
            Separar direções
          </button>
        )}
      </div>
      {entry.kind === "base" ? <BaseOps revision={revision} call={call} /> : <ClipOps revision={revision} call={call} />}
      {message && <p className="small">{message}</p>}
      {created && created.revision.status === "candidate" && (
        <p className="small">
          Candidata r{created.revision.number}: <ReviewButtons projectId={projectId} assetId={created.assetId} revision={created.revision} activeRevisionId={entries.find((e) => e.asset.id === created.assetId)?.asset.approvedRevisionId ?? null} onChanged={onChanged} />
        </p>
      )}
    </section>
  );
}

function Tags({ projectId, assetId, initial, onSaved }: { projectId: string; assetId: string; initial: string[]; onSaved: () => void }) {
  const [text, setText] = useState(initial.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="row small">
      <label style={{ flex: 1 }}>
        Etiquetas (vírgula; não criam revisão)
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="ex.: baú, masmorra" />
      </label>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            const res = await apiFetch<{ tags: string[] }>(`/projects/${projectId}/library/tags`, { method: "PUT", json: { assetId, tags: text.split(",").map((t) => t.trim()).filter(Boolean) } });
            setMessage(`Etiquetas: ${res.tags.join(", ") || "nenhuma"}`);
            onSaved();
          } catch (err) {
            setMessage(errorText(err));
          }
        }}
      >
        Salvar etiquetas
      </button>
      {message && <span>{message}</span>}
    </div>
  );
}

type Call = (path: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => Promise<void>;

function Margins({ onApply }: { onApply: (m: { left: number; right: number; top: number; bottom: number }) => void }) {
  const [m, setM] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  return (
    <fieldset className="small">
      <legend>Canvas (sem gerar pixels; negativo reduz)</legend>
      <div className="row">
        {(["left", "right", "top", "bottom"] as const).map((k) => (
          <label key={k}>
            {{ left: "esquerda", right: "direita", top: "topo", bottom: "base" }[k]}
            <input type="number" min={-512} max={512} value={m[k]} onChange={(e) => setM((x) => ({ ...x, [k]: Math.round(Number(e.target.value) || 0) }))} />
          </label>
        ))}
        <button type="button" className="secondary" disabled={!m.left && !m.right && !m.top && !m.bottom} onClick={() => onApply(m)}>
          Aplicar canvas
        </button>
      </div>
    </fieldset>
  );
}

function MirrorConfirm({ onMirror }: { onMirror: (confirm: { reason: string } | null) => void }) {
  const [asym, setAsym] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <span className="row small">
      <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <input type="checkbox" checked={asym} onChange={(e) => setAsym(e.target.checked)} /> autorizo espelhar arte assimétrica
      </label>
      {asym && <input placeholder="motivo" value={reason} onChange={(e) => setReason(e.target.value)} />}
      <button type="button" className="secondary" disabled={asym && reason.trim().length < 3} onClick={() => onMirror(asym ? { reason: reason.trim() } : null)}>
        Espelhar
      </button>
    </span>
  );
}

function BaseOps({ revision, call }: { revision: RevisionView; call: Call }) {
  const payload = revision.payload as BasePayload;
  const views = payload.views.map((v) => v.direction);
  const [drop, setDrop] = useState<Direction[]>([]);
  const mirrorable = views.filter((d) => MIRROR_PAIR[d] && !views.includes(MIRROR_PAIR[d]!));
  const [source, setSource] = useState<Direction | "">("");
  const src = (source || mirrorable[0]) as Direction | undefined;
  return (
    <>
      <fieldset className="small">
        <legend>Excluir direção (revisão nova)</legend>
        <DirectionChecks available={views} value={drop} onChange={setDrop} />
        <button type="button" className="secondary" disabled={drop.length === 0 || drop.length >= views.length} onClick={() => call("remove", { revisionId: revision.id, directions: drop }, () => `Revisão sem ${drop.join(", ")} publicada.`)}>
          Excluir direções
        </button>
      </fieldset>
      <fieldset className="small">
        <legend>Espelho explícito (não conta como geração)</legend>
        {mirrorable.length === 0 ? (
          <p className="muted">Nenhuma vista lateral com par faltante (N e S encaram a câmera e não têm par).</p>
        ) : (
          <div className="row">
            <label>
              Vista de origem
              <select value={src} onChange={(e) => setSource(e.target.value as Direction)}>
                {mirrorable.map((d) => (
                  <option key={d} value={d}>
                    {d} → {MIRROR_PAIR[d]}
                  </option>
                ))}
              </select>
            </label>
            <MirrorConfirm onMirror={(confirm) => call("mirror", { revisionId: revision.id, source: src, ...(confirm ? { confirmAsymmetric: confirm } : {}) }, (r) => `Espelho ${src} → ${MIRROR_PAIR[src!]} publicado (assimetria medida ${Math.round(((r.asymmetry as number | null) ?? 0) * 100)}%).`)} />
          </div>
        )}
      </fieldset>
      <Margins onApply={(m) => call("canvas", { revisionId: revision.id, margins: m }, (r) => `Canvas ${(r.size as number[]).join("×")} (deslocamento ${(r.shift as number[]).join(",")}).`)} />
    </>
  );
}

function ClipOps({ revision, call }: { revision: RevisionView; call: Call }) {
  const clip = revision.payload as ClipPayload;
  const [frames, setFrames] = useState<string[]>([]);
  const [remap, setRemap] = useState<Record<string, string>>({});
  const [part, setPart] = useState("");
  const parts = [...new Set(clip.frames.flatMap((f) => f.layers.map((l) => l.partId)))];
  const stranded = clip.events.filter((e) => frames.includes(e.frameId));
  const remaining = clip.frames.map((f) => f.frameId).filter((id) => !frames.includes(id));
  return (
    <>
      <fieldset className="small">
        <legend>Excluir quadro ou parte (revisão nova)</legend>
        <div className="row">
          {clip.frames.map((f) => (
            <label key={f.frameId} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <input type="checkbox" checked={frames.includes(f.frameId)} onChange={(e) => setFrames((s) => (e.target.checked ? [...s, f.frameId] : s.filter((x) => x !== f.frameId)))} /> {f.frameId}
            </label>
          ))}
        </div>
        {stranded.map((e) => (
          <label key={e.eventId}>
            Evento {e.eventId} ({e.frameId}) vai para
            <select value={remap[e.eventId] ?? ""} onChange={(ev) => setRemap((r) => ({ ...r, [e.eventId]: ev.target.value }))}>
              <option value="">— escolha —</option>
              <option value="__drop">remover o evento</option>
              {remaining.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={frames.length === 0 || remaining.length === 0 || stranded.some((e) => !remap[e.eventId])}
          onClick={() =>
            call("remove", { revisionId: revision.id, frameIds: frames, eventRemap: Object.fromEntries(stranded.map((e) => [e.eventId, remap[e.eventId] === "__drop" ? null : remap[e.eventId]])) }, () => `Revisão sem ${frames.join(", ")} publicada.`)
          }
        >
          Excluir quadros
        </button>
        {parts.length > 1 && (
          <span className="row">
            <select value={part} onChange={(e) => setPart(e.target.value)}>
              <option value="">— parte —</option>
              {parts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" disabled={!part} onClick={() => call("remove", { revisionId: revision.id, partId: part }, () => `Revisão sem a parte ${part} publicada.`)}>
              Excluir parte
            </button>
          </span>
        )}
      </fieldset>
      <fieldset className="small">
        <legend>Espelho explícito do clipe ({clip.direction} → {MIRROR_PAIR[clip.direction] ?? "sem par"})</legend>
        {MIRROR_PAIR[clip.direction] ? <MirrorConfirm onMirror={(confirm) => call("mirror", { revisionId: revision.id, ...(confirm ? { confirmAsymmetric: confirm } : {}) }, () => `Clipe espelhado para ${MIRROR_PAIR[clip.direction]} criado (asset próprio).`)} /> : <p className="muted">N e S encaram a câmera: sem espelho.</p>}
      </fieldset>
      <Margins onApply={(m) => call("canvas", { revisionId: revision.id, margins: m }, (r) => `Canvas ${(r.size as number[]).join("×")}; camadas, sockets e pivô deslocados em ${(r.shift as number[]).join(",")}.`)} />
    </>
  );
}
