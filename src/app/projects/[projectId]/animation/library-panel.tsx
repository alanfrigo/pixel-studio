"use client";

import { useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { apiFetch } from "@/app/client/api";
import { useMessages } from "@/i18n/client";
import { animationMessages } from "@/i18n/messages/animation";
import { commonMessages, labelOf } from "@/i18n/messages/common";
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
  const am = useMessages(animationMessages);
  const t = am.library;
  const c = useMessages(commonMessages);
  const entries = [...data.bases.map((e) => ({ ...e, kind: "base" as const })), ...data.clips.map((e) => ({ ...e, kind: "clip" as const }))];
  const [assetId, setAssetId] = useState("");
  const entry = entries.find((e) => e.asset.id === assetId) ?? entries[0];
  const [revisionId, setRevisionId] = useState("");
  const revision = entry?.revisions.find((r) => r.id === revisionId) ?? entry?.revisions.find((r) => r.id === entry.asset.approvedRevisionId) ?? entry?.revisions[0];
  const [message, setMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<{ assetId: string; revision: RevisionView } | null>(null);
  if (!entry || !revision) return <section className="muted">{t.empty}</section>;

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
      <h2>{t.heading}</h2>
      <p className="small muted">{t.intro}</p>
      <div className="row">
        <label>
          {t.asset}
          <select value={entry.asset.id} onChange={(e) => (setAssetId(e.target.value), setRevisionId(""))}>
            {entries.map((e) => (
              <option key={e.asset.id} value={e.asset.id}>
                {e.asset.name} ({e.kind === "clip" ? t.kinds.clip : (e.revisions[0]?.payload as BasePayload | undefined)?.subject === "object" ? t.kinds.object : t.kinds.base})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.revision}
          <select value={revision.id} onChange={(e) => setRevisionId(e.target.value)}>
            {entry.revisions.map((r) => (
              <option key={r.id} value={r.id}>
                r{r.number} · {labelOf(c.revisionStatus, r.status)}
                {r.id === entry.asset.approvedRevisionId ? ` · ${c.revisionStatus.active}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Tags key={entry.asset.id} projectId={projectId} assetId={entry.asset.id} initial={data.tags[entry.asset.id] ?? []} onSaved={onChanged} />
      <div className="row">
        <button type="button" className="secondary" onClick={() => call("duplicate", { revisionId: revision.id }, (r) => t.copyCreated((r.asset as { name: string }).name))}>
          {t.duplicate}
        </button>
        {entry.kind === "base" && (revision.payload as BasePayload).views.length > 1 && (
          <button type="button" className="secondary" onClick={() => call("ungroup", { revisionId: revision.id }, (r) => t.ungrouped((r.created as unknown[]).length))}>
            {t.ungroup}
          </button>
        )}
      </div>
      {entry.kind === "base" ? <BaseOps revision={revision} call={call} /> : <ClipOps revision={revision} call={call} />}
      {message && <p className="small">{message}</p>}
      {created && created.revision.status === "candidate" && (
        <p className="small">
          {am.shared.candidateRev(created.revision.number)}: <ReviewButtons projectId={projectId} assetId={created.assetId} revision={created.revision} activeRevisionId={entries.find((e) => e.asset.id === created.assetId)?.asset.approvedRevisionId ?? null} onChanged={onChanged} />
        </p>
      )}
    </section>
  );
}

function Tags({ projectId, assetId, initial, onSaved }: { projectId: string; assetId: string; initial: string[]; onSaved: () => void }) {
  const t = useMessages(animationMessages).library;
  const c = useMessages(commonMessages);
  const [text, setText] = useState(initial.join(", "));
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="row small">
      <label style={{ flex: 1 }}>
        {t.tags}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t.tagsPlaceholder} />
      </label>
      <button
        type="button"
        className="secondary"
        onClick={async () => {
          try {
            const res = await apiFetch<{ tags: string[] }>(`/projects/${projectId}/library/tags`, { method: "PUT", json: { assetId, tags: text.split(",").map((t) => t.trim()).filter(Boolean) } });
            setMessage(t.tagsSaved(res.tags.join(", ") || c.none));
            onSaved();
          } catch (err) {
            setMessage(errorText(err));
          }
        }}
      >
        {t.saveTags}
      </button>
      {message && <span>{message}</span>}
    </div>
  );
}

type Call = (path: string, body: Record<string, unknown>, describe: (r: Record<string, unknown>) => string) => Promise<void>;

function Margins({ onApply }: { onApply: (m: { left: number; right: number; top: number; bottom: number }) => void }) {
  const t = useMessages(animationMessages).library;
  const [m, setM] = useState({ left: 0, right: 0, top: 0, bottom: 0 });
  return (
    <fieldset className="small">
      <legend>{t.canvasLegend}</legend>
      <div className="row">
        {(["left", "right", "top", "bottom"] as const).map((k) => (
          <label key={k}>
            {t.sides[k]}
            <input type="number" min={-512} max={512} value={m[k]} onChange={(e) => setM((x) => ({ ...x, [k]: Math.round(Number(e.target.value) || 0) }))} />
          </label>
        ))}
        <button type="button" className="secondary" disabled={!m.left && !m.right && !m.top && !m.bottom} onClick={() => onApply(m)}>
          {t.applyCanvas}
        </button>
      </div>
    </fieldset>
  );
}

function MirrorConfirm({ onMirror }: { onMirror: (confirm: { reason: string } | null) => void }) {
  const t = useMessages(animationMessages).library;
  const [asym, setAsym] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <span className="row small">
      <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <input type="checkbox" checked={asym} onChange={(e) => setAsym(e.target.checked)} /> {t.allowAsymmetric}
      </label>
      {asym && <input placeholder={t.reasonPlaceholder} value={reason} onChange={(e) => setReason(e.target.value)} />}
      <button type="button" className="secondary" disabled={asym && reason.trim().length < 3} onClick={() => onMirror(asym ? { reason: reason.trim() } : null)}>
        {t.mirror}
      </button>
    </span>
  );
}

function BaseOps({ revision, call }: { revision: RevisionView; call: Call }) {
  const t = useMessages(animationMessages).library;
  const payload = revision.payload as BasePayload;
  const views = payload.views.map((v) => v.direction);
  const [drop, setDrop] = useState<Direction[]>([]);
  const mirrorable = views.filter((d) => MIRROR_PAIR[d] && !views.includes(MIRROR_PAIR[d]!));
  const [source, setSource] = useState<Direction | "">("");
  const src = (source || mirrorable[0]) as Direction | undefined;
  return (
    <>
      <fieldset className="small">
        <legend>{t.removeDirectionLegend}</legend>
        <DirectionChecks available={views} value={drop} onChange={setDrop} />
        <button type="button" className="secondary" disabled={drop.length === 0 || drop.length >= views.length} onClick={() => call("remove", { revisionId: revision.id, directions: drop }, () => t.removedPublished(drop.join(", ")))}>
          {t.removeDirections}
        </button>
      </fieldset>
      <fieldset className="small">
        <legend>{t.mirrorLegend}</legend>
        {mirrorable.length === 0 ? (
          <p className="muted">{t.noMirrorable}</p>
        ) : (
          <div className="row">
            <label>
              {t.sourceView}
              <select value={src} onChange={(e) => setSource(e.target.value as Direction)}>
                {mirrorable.map((d) => (
                  <option key={d} value={d}>
                    {d} → {MIRROR_PAIR[d]}
                  </option>
                ))}
              </select>
            </label>
            <MirrorConfirm onMirror={(confirm) => call("mirror", { revisionId: revision.id, source: src, ...(confirm ? { confirmAsymmetric: confirm } : {}) }, (r) => t.mirrorPublished(src!, MIRROR_PAIR[src!]!, Math.round(((r.asymmetry as number | null) ?? 0) * 100)))} />
          </div>
        )}
      </fieldset>
      <Margins onApply={(m) => call("canvas", { revisionId: revision.id, margins: m }, (r) => t.canvasBase((r.size as number[]).join("×"), (r.shift as number[]).join(",")))} />
    </>
  );
}

function ClipOps({ revision, call }: { revision: RevisionView; call: Call }) {
  const t = useMessages(animationMessages).library;
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
        <legend>{t.removeFrameLegend}</legend>
        <div className="row">
          {clip.frames.map((f) => (
            <label key={f.frameId} style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
              <input type="checkbox" checked={frames.includes(f.frameId)} onChange={(e) => setFrames((s) => (e.target.checked ? [...s, f.frameId] : s.filter((x) => x !== f.frameId)))} /> {f.frameId}
            </label>
          ))}
        </div>
        {stranded.map((e) => (
          <label key={e.eventId}>
            {t.eventMovesTo(e.eventId, e.frameId)}
            <select value={remap[e.eventId] ?? ""} onChange={(ev) => setRemap((r) => ({ ...r, [e.eventId]: ev.target.value }))}>
              <option value="">{t.choose}</option>
              <option value="__drop">{t.dropEvent}</option>
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
            call("remove", { revisionId: revision.id, frameIds: frames, eventRemap: Object.fromEntries(stranded.map((e) => [e.eventId, remap[e.eventId] === "__drop" ? null : remap[e.eventId]])) }, () => t.removedPublished(frames.join(", ")))
          }
        >
          {t.removeFrames}
        </button>
        {parts.length > 1 && (
          <span className="row">
            <select value={part} onChange={(e) => setPart(e.target.value)}>
              <option value="">{t.partPlaceholder}</option>
              {parts.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button type="button" className="secondary" disabled={!part} onClick={() => call("remove", { revisionId: revision.id, partId: part }, () => t.removedPart(part))}>
              {t.removePart}
            </button>
          </span>
        )}
      </fieldset>
      <fieldset className="small">
        <legend>{t.clipMirrorLegend(clip.direction, MIRROR_PAIR[clip.direction] ?? null)}</legend>
        {MIRROR_PAIR[clip.direction] ? <MirrorConfirm onMirror={(confirm) => call("mirror", { revisionId: revision.id, ...(confirm ? { confirmAsymmetric: confirm } : {}) }, () => t.clipMirrored(MIRROR_PAIR[clip.direction]!))} /> : <p className="muted">{t.facesCamera}</p>}
      </fieldset>
      <Margins onApply={(m) => call("canvas", { revisionId: revision.id, margins: m }, (r) => t.canvasClip((r.size as number[]).join("×"), (r.shift as number[]).join(",")))} />
    </>
  );
}
