"use client";

import { useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import { apiFetch } from "@/app/client/api";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { animationMessages } from "@/i18n/messages/animation";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { type AssetEntry, DIRS, errorText, findRevision, isObject, type Overview, type ProfileInfo, routeLabel, uploadPng, viewUrl } from "./shared";
import { DirectionChecks, PlanActions, ReviewButtons, type RunFn, ViewPicker } from "./temporal-ui";

/**
 * Estados (ferido, congelado, baú aberto) e objetos (cartão S3). O estado é um
 * asset próprio ligado à origem (predecessor + aresta de identidade), com
 * matriz de direções: cada célula é vista aprovada, lacuna explícita (com
 * motivo) ou direção que a fonte não tem. Estado não é rename nem postura.
 */

type Props = { projectId: string; data: Overview; profile: ProfileInfo; run: RunFn; onChanged: () => void };

export function StatesPanel({ projectId, data, profile, run, onChanged }: Props) {
  const t = useMessages(animationMessages).states;
  const locale = useLocale();
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
  const route = routeLabel(profile, "state", locale);
  if (!row) return <section className="muted">{t.none}</section>;
  const dirs = directions.filter((d) => source?.views.includes(d));
  const plan =
    source && stateKey.trim() && description.trim() && dirs.length
      ? { operation: "create_state", providerProfileId: profile.id, sourceRevisionId: source.revisionId, stateKey: stateKey.trim(), description: description.trim(), directions: dirs }
      : null;
  return (
    <section>
      <h2>{t.heading}</h2>
      <p className="small muted">
        {t.intro} <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
      </p>
      <div className="row">
        <label>
          {t.identity}
          <select value={row.identityAssetId} onChange={(e) => setIdentityId(e.target.value)}>
            {rows.map((r) => (
              <option key={r.identityAssetId} value={r.identityAssetId}>
                {r.identityName} {r.subject === "object" ? t.objectSuffix : t.characterSuffix}
              </option>
            ))}
          </select>
        </label>
      </div>
      <StateMatrix projectId={projectId} data={data} row={row} onChanged={onChanged} />
      <h3>{t.newHeading}</h3>
      <div className="row">
        <label>
          {t.from}
          <select value={source?.revisionId ?? ""} onChange={(e) => setSourceId(e.target.value)}>
            {sources.map((s) => (
              <option key={s.revisionId} value={s.revisionId}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.stateKey}
          <input value={stateKey} onChange={(e) => setStateKey(e.target.value.toLowerCase())} placeholder={t.stateKeyPlaceholder} />
        </label>
        <label style={{ flex: 1 }}>
          {t.visualChange}
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.visualChangePlaceholder} />
        </label>
      </div>
      <DirectionChecks available={source?.views ?? []} value={dirs} onChange={setDirections} />
      <p className="small muted">{t.fillGapNote}</p>
      <PlanActions projectId={projectId} plan={plan} run={run} label={t.generateState} />
    </section>
  );
}

function StateMatrix({ projectId, data, row, onChanged }: { projectId: string; data: Overview; row: Overview["states"][number]; onChanged: () => void }) {
  const t = useMessages(animationMessages).states;
  const c = useMessages(commonMessages);
  const text = useText();
  const [open, setOpen] = useState<string | null>(null);
  const identity = findRevision(data, row.identityRevisionId);
  return (
    <>
      <table className="anim-matrix small">
        <thead>
          <tr>
            <th>{t.stateColumn}</th>
            {DIRS.map((d) => (
              <th key={d} title={c.directions[d]}>
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
                      <td key={d} className="gap" title={gap?.reason ? text(gap.reason as TextValue) : t.notGenerated}>
                        {t.gap}
                      </td>
                    );
                  return (
                    <td key={d} className="none" title={t.sourceLacksView}>
                      —
                    </td>
                  );
                })}
                <td>
                  <button type="button" className="secondary" onClick={() => setOpen(open === s.assetId ? null : s.assetId)}>
                    {t.revisionsButton(s.revisions.filter((r) => r.status === "candidate").length)}
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
                    r{r.number} · <span className={`badge state-${r.status}`}>{labelOf(c.revisionStatus, r.status)}</span> · {r.views.join(", ")} · {r.operation ?? ""}{" "}
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
  const am = useMessages(animationMessages);
  const t = am.objects;
  const text = useText();
  const objects = data.bases.filter(isObject);
  const [objectId, setObjectId] = useState("");
  const entry: AssetEntry | undefined = objects.find((o) => o.asset.id === objectId) ?? objects[0];
  const approved = entry?.revisions.find((r) => r.id === entry.asset.approvedRevisionId) ?? null;
  const payload = approved ? (approved.payload as BasePayload) : null;
  return (
    <section>
      <h2>{t.heading}</h2>
      <p className="small muted">{t.intro}</p>
      <NewObject projectId={projectId} data={data} onCreated={onChanged} />
      {objects.length > 0 && (
        <div className="row">
          <label>
            {t.object}
            <select value={entry?.asset.id ?? ""} onChange={(e) => setObjectId(e.target.value)}>
              {objects.map((o) => (
                <option key={o.asset.id} value={o.asset.id}>
                  {o.asset.name}
                  {o.asset.approvedRevisionId ? "" : t.notApproved}
                </option>
              ))}
            </select>
          </label>
          {approved && payload && (
            <span className="small muted">
              r{approved.number} · {payload.logicalSize.join("×")} · {t.info(payload.groundOrigin.join(","), payload.state, payload.views.map((v) => v.direction).join(", "))}
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
                  {am.shared.candidateRev(r.number)} · {(r.payload as BasePayload).views.map((v) => v.direction).join(", ")} · {reportRoute(r.technicalReport, text) ?? r.origin}{" "}
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
  const t = useMessages(animationMessages).objects;
  const c = useMessages(commonMessages);
  const locale = useLocale();
  const [name, setName] = useState("");
  const [direction, setDirection] = useState<Direction>("S");
  const [file, setFile] = useState<File | null>(null);
  const [sourceKey, setSourceKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const sources = data.imageSources.flatMap((s) => s.files.map((f) => ({ key: `${s.revisionId}|${f.fileKey}`, label: `${s.name} · ${f.fileKey}${f.width ? ` (${f.width}×${f.height})` : ""}`, revisionId: s.revisionId, fileKey: f.fileKey })));
  return (
    <details className="small">
      <summary>{t.newSummary}</summary>
      <div className="row">
        <label>
          {t.name}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.namePlaceholder} />
        </label>
        <label>
          {t.view}
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            {DIRS.map((d) => (
              <option key={d} value={d}>
                {d} · {c.directions[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t.localPng}
          <input type="file" accept="image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label>
          {t.orApprovedImage}
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
              const image = file ? { from: "upload", uploadId: await uploadPng(projectId, file, file.name, locale) } : { from: "revision", revisionId: src!.revisionId, fileKey: src!.fileKey };
              await apiFetch(`/projects/${projectId}/animation/objects`, { method: "POST", json: { name: name.trim(), image, direction } });
              setMessage(t.created);
              onCreated();
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          {t.create}
        </button>
      </div>
      {message && <p>{message}</p>}
    </details>
  );
}

function AnimateObject({ projectId, data, profile, object, revisionId, views, run }: { projectId: string; data: Overview; profile: ProfileInfo; object: AssetEntry; revisionId: string; views: Direction[]; run: RunFn }) {
  const am = useMessages(animationMessages);
  const t = am.objects;
  const c = useMessages(commonMessages);
  const locale = useLocale();
  const [direction, setDirection] = useState<Direction>(views[0] ?? "S");
  const [action, setAction] = useState("open");
  const [description, setDescription] = useState("");
  const [frames, setFrames] = useState(4);
  const [ms, setMs] = useState(100);
  const [playback, setPlayback] = useState<ClipPayload["playback"]>("once");
  const [keep, setKeep] = useState<boolean | null>(null);
  const [endId, setEndId] = useState("");
  const route = routeLabel(profile, "objectAnimation", locale);
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
      <h3>{t.animateHeading}</h3>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
        {t.noHumanoid}
      </p>
      <div className="row">
        <label>
          {am.shared.direction}
          <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            {views.map((d) => (
              <option key={d} value={d}>
                {d} · {c.directions[d]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {am.shared.action}
          <input value={action} onChange={(e) => setAction(e.target.value.toLowerCase())} />
        </label>
        <label style={{ flex: 1 }}>
          {t.motion}
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.motionPlaceholder} />
        </label>
      </div>
      <div className="row">
        <label>
          {t.generatedFrames}
          <input type="number" min={1} max={40} value={frames} onChange={(e) => setFrames(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
        </label>
        <label>
          {am.shared.msPerFrame}
          <input type="number" min={1} max={60000} value={ms} onChange={(e) => setMs(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label>
          {am.shared.playbackLabel}
          <select value={playback} onChange={(e) => setPlayback(e.target.value as ClipPayload["playback"])}>
            <option value="once">{am.shared.playback.once}</option>
            <option value="loop">{am.shared.playback.loop}</option>
            <option value="ping_pong">{am.shared.playback.ping_pong}</option>
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }} title={t.keepFirstTitle}>
          <input type="checkbox" checked={keepFirst} onChange={(e) => setKeep(e.target.checked)} /> {t.keepFirst}
        </label>
        <label>
          {t.endPose}
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
      <p className="small muted">{t.expected(frames + (keepFirst ? 1 : 0), keepFirst, frames)}</p>
      <PlanActions projectId={projectId} plan={route.ok ? plan : null} run={run} label={t.animate} />
    </div>
  );
}

/** Rota gravada no relatório técnico (bilíngue ou texto simples) ou a operação. */
function reportRoute(report: unknown, text: (t: TextValue | null | undefined) => string): string | null {
  const r = report as { routeLabel?: TextValue; operation?: string } | null;
  return r?.routeLabel ? text(r.routeLabel) : (r?.operation ?? null);
}
