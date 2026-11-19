"use client";

import { useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction } from "@/contracts";
import type { RevisionView } from "@/server/catalog/catalog";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { animationMessages } from "@/i18n/messages/animation";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { ClipPlayer } from "./clip-player";
import { DIRS, errorText, type Overview, type ProfileInfo, routeLabel, uploadPng, viewUrl } from "./shared";
import { FrameThumb, MaskPainter, maskToPng, PlanActions, ReviewButtons, type RunFn } from "./temporal-ui";

/**
 * Edição temporal (cartão S3) sobre um clipe aprovado: interpolar, editar um
 * trecho, corrigir um quadro com máscara e transferir roupa. Cada operação
 * publica uma revisão candidata; os quadros não tocados ficam com os mesmos
 * arquivos. A prévia toca com a duração de cada quadro e onion skin.
 */

type Sub = "interpolate" | "edit" | "correct" | "outfit";
type Props = { projectId: string; data: Overview; profile: ProfileInfo; run: RunFn; onChanged: () => void };

export function TemporalPanel({ projectId, data, profile, run, onChanged }: Props) {
  const t = useMessages(animationMessages).temporal;
  const c = useMessages(commonMessages);
  const clips = useMemo(() => data.clips.flatMap((c) => c.revisions.map((r) => ({ asset: c.asset, revision: r }))), [data.clips]);
  const approved = clips.filter((c) => c.revision.status === "approved");
  const [clipId, setClipId] = useState("");
  const current = clips.find((c) => c.revision.id === clipId) ?? approved[0] ?? null;
  const [sub, setSub] = useState<Sub>("interpolate");
  const [selected, setSelected] = useState<string[]>([]);
  const [focus, setFocus] = useState<string>("");
  return (
    <section>
      <h2>{t.heading}</h2>
      <div className="row">
        <label>
          {t.clip}
          <select value={current?.revision.id ?? ""} onChange={(e) => (setClipId(e.target.value), setSelected([]), setFocus(""))}>
            {clips.map(({ asset, revision }) => (
              <option key={revision.id} value={revision.id}>
                {asset.name} r{revision.number} · {labelOf(c.revisionStatus, revision.status)}
              </option>
            ))}
          </select>
        </label>
        {current && <ReviewButtons projectId={projectId} assetId={current.asset.id} revision={current.revision} activeRevisionId={current.asset.approvedRevisionId} onChanged={onChanged} />}
      </div>
      {current && (
        <div className="grid2">
          <div>
            <ClipPlayer key={current.revision.id} projectId={projectId} revision={current.revision} onSaved={(id) => (setClipId(id), onChanged())} />
            <ChangeSummary revision={current.revision} />
          </div>
          <div>
            <p className="small muted">{t.focusHint}</p>
            <div className="anim-frames">
              {(current.revision.payload as ClipPayload).frames.map((f, i) => (
                <div key={f.frameId} className="small">
                  <FrameThumb projectId={projectId} revision={current.revision} index={i} zoom={2} selected={focus === f.frameId} onClick={() => setFocus(f.frameId)} title={`${f.frameId} · ${f.durationMs} ms`} />
                  <label>
                    <input type="checkbox" checked={selected.includes(f.frameId)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, f.frameId] : s.filter((x) => x !== f.frameId)))} /> {f.frameId}
                  </label>
                  <span className="muted">{selected.includes(f.frameId) ? t.edit : t.protected}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <nav className="row anim-tabs">
        {(
          [
            ["interpolate", t.subs.interpolate],
            ["edit", t.subs.edit],
            ["correct", t.subs.correct],
            ["outfit", t.subs.outfit],
          ] as [Sub, string][]
        ).map(([k, label]) => (
          <button key={k} type="button" className={sub === k ? "" : "secondary"} onClick={() => setSub(k)}>
            {label}
          </button>
        ))}
      </nav>
      {sub === "interpolate" && <Interpolate projectId={projectId} data={data} profile={profile} clip={current?.revision ?? null} focus={focus} run={run} />}
      {sub === "edit" && current && <EditSegment projectId={projectId} profile={profile} clip={current.revision} selected={selected} run={run} />}
      {sub === "correct" && current && <CorrectFrame key={`${current.revision.id}:${focus}`} projectId={projectId} profile={profile} clip={current.revision} frameId={focus || (current.revision.payload as ClipPayload).frames[0]!.frameId} run={run} />}
      {sub === "outfit" && current && <TransferOutfit projectId={projectId} data={data} profile={profile} clip={current.revision} selected={selected} run={run} />}
      {!current && sub !== "interpolate" && <p className="small muted">{t.noClips}</p>}
    </section>
  );
}

/** O que a revisão mudou e quais dependentes revisar (eventos, coberturas de peças). */
function ChangeSummary({ revision }: { revision: RevisionView }) {
  const t = useMessages(animationMessages).temporal;
  const text = useText();
  const r = revision.technicalReport as {
    operation?: string;
    routeLabel?: TextValue;
    modeLabel?: TextValue;
    affected?: { events: { eventId: string; frameId: string }[]; overlays: { assetName: string; number: number; partId: string | null; frameId: string }[] };
    composite?: { protectedDiffPixels: number; editedPixels: number };
    keepFirstFrameSemantics?: TextValue;
    note?: TextValue;
    warnings?: TextValue[];
  } | null;
  if (!r?.operation) return null;
  return (
    <div className="small">
      <p>
        <strong>{r.operation}</strong> · {text(r.routeLabel ?? r.modeLabel ?? "")}
      </p>
      {r.note && <p className="muted">{text(r.note)}</p>}
      {r.keepFirstFrameSemantics && <p className="muted">{text(r.keepFirstFrameSemantics)}</p>}
      {r.composite && <p>{t.composite(r.composite.editedPixels, r.composite.protectedDiffPixels)}</p>}
      {r.affected && (r.affected.events.length > 0 || r.affected.overlays.length > 0) && (
        <p className="error">
          {t.review} {r.affected.events.map((e) => t.event(e.eventId, e.frameId)).join(", ")}
          {r.affected.events.length && r.affected.overlays.length ? "; " : ""}
          {[...new Set(r.affected.overlays.map((o) => `${o.assetName} r${o.number} · ${o.partId ?? t.rigidView} · ${o.frameId}`))].join("; ")}
        </p>
      )}
      {(r.warnings ?? []).map((w, i) => (
        <p key={i} className="error">
          {text(w)}
        </p>
      ))}
    </div>
  );
}

function Interpolate({ projectId, data, profile, clip, focus, run }: { projectId: string; data: Overview; profile: ProfileInfo; clip: RevisionView | null; focus: string; run: RunFn }) {
  const am = useMessages(animationMessages);
  const t = am.temporal;
  const locale = useLocale();
  const route = routeLabel(profile, "interpolation", locale);
  const [mode, setMode] = useState<"frames" | "views">(clip ? "frames" : "views");
  const [action, setAction] = useState("");
  const [count, setCount] = useState(2);
  const [transitionMs, setTransitionMs] = useState(200);
  const frames = clip ? (clip.payload as ClipPayload).frames : [];
  const start = frames.find((f) => f.frameId === focus) ?? frames[0];
  const next = start ? (frames[frames.indexOf(start) + 1] ?? (clip && (clip.payload as ClipPayload).playback === "loop" ? frames[0] : undefined)) : undefined;
  const views = data.bases.flatMap((b) => b.revisions.filter((r) => r.status === "approved").map((r) => ({ label: `${b.asset.name} r${r.number} (${(r.payload as BasePayload).state})`, revision: r })));
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [direction, setDirection] = useState<Direction>("S");
  const [clipAction, setClipAction] = useState("transition");
  const generic = route.strategy === "reference_sheet";
  const plan =
    !action.trim() || !route.ok
      ? null
      : mode === "frames"
        ? clip && start && next
          ? { operation: "interpolate_frames", providerProfileId: profile.id, start: { kind: "clip_frame", clipRevisionId: clip.id, frameId: start.frameId }, end: { kind: "clip_frame", clipRevisionId: clip.id, frameId: next.frameId }, action: action.trim(), transitionMs, ...(generic ? { count } : {}) }
          : null
        : a && b
          ? { operation: "interpolate_frames", providerProfileId: profile.id, start: { kind: "view", baseRevisionId: a, direction }, end: { kind: "view", baseRevisionId: b, direction }, action: action.trim(), transitionMs, newClip: { action: clipAction, startMs: 150, endMs: 250, playback: "once" }, ...(generic ? { count } : {}) }
          : null;
  const viewA = views.find((v) => v.revision.id === a);
  const viewB = views.find((v) => v.revision.id === b);
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
        {t.interpolateNote(generic)}
      </p>
      <div className="row">
        <label>
          {t.between}
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="frames">{t.modeFrames}</option>
            <option value="views">{t.modeViews}</option>
          </select>
        </label>
        {mode === "frames" ? (
          <span className="small">{start && next ? `${start.frameId} → ${next.frameId}` : t.focusNeighbor}</span>
        ) : (
          <>
            <label>
              {t.start}
              <select value={a} onChange={(e) => setA(e.target.value)}>
                <option value="">—</option>
                {views.map((v) => (
                  <option key={v.revision.id} value={v.revision.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.end}
              <select value={b} onChange={(e) => setB(e.target.value)}>
                <option value="">—</option>
                {views.map((v) => (
                  <option key={v.revision.id} value={v.revision.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {am.shared.direction}
              <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                {DIRS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.clipAction}
              <input value={clipAction} onChange={(e) => setClipAction(e.target.value.toLowerCase())} />
            </label>
            {viewA && viewUrl(projectId, viewA.revision, direction) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel bg-checker" alt={t.startAlt} src={viewUrl(projectId, viewA.revision, direction)!} width={48} height={48} />
            )}
            {viewB && viewUrl(projectId, viewB.revision, direction) && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel bg-checker" alt={t.endAlt} src={viewUrl(projectId, viewB.revision, direction)!} width={48} height={48} />
            )}
          </>
        )}
      </div>
      <div className="row">
        <label style={{ flex: 1 }}>
          {t.transition}
          <input value={action} onChange={(e) => setAction(e.target.value)} placeholder={t.transitionPlaceholder} />
        </label>
        {generic && (
          <label>
            {t.inBetweens}
            <input type="number" min={1} max={14} value={count} onChange={(e) => setCount(Math.max(1, Math.min(14, Number(e.target.value) || 1)))} />
          </label>
        )}
        <label>
          {t.totalDuration}
          <input type="number" min={1} max={60000} value={transitionMs} onChange={(e) => setTransitionMs(Math.max(1, Number(e.target.value) || 1))} />
        </label>
      </div>
      <PlanActions projectId={projectId} plan={plan} run={run} label={t.subs.interpolate} />
    </div>
  );
}

function EditSegment({ projectId, profile, clip, selected, run }: { projectId: string; profile: ProfileInfo; clip: RevisionView; selected: string[]; run: RunFn }) {
  const t = useMessages(animationMessages).temporal;
  const locale = useLocale();
  const route = routeLabel(profile, "edit", locale);
  const [description, setDescription] = useState("");
  const ordered = (clip.payload as ClipPayload).frames.map((f) => f.frameId).filter((id) => selected.includes(id));
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
        {t.segmentNote(ordered.join(", ") || t.checkFrames)}
      </p>
      <label>
        {t.coherentChange}
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t.changePlaceholder} />
      </label>
      <PlanActions projectId={projectId} plan={route.ok && ordered.length && description.trim() ? { operation: "edit_animation", providerProfileId: profile.id, clipRevisionId: clip.id, frameIds: ordered, description: description.trim() } : null} run={run} label={t.subs.edit} />
    </div>
  );
}

function CorrectFrame({ projectId, profile, clip, frameId, run }: { projectId: string; profile: ProfileInfo; clip: RevisionView; frameId: string; run: RunFn }) {
  const t = useMessages(animationMessages).temporal;
  const locale = useLocale();
  const payload = clip.payload as ClipPayload;
  const index = payload.frames.findIndex((f) => f.frameId === frameId);
  const frame = payload.frames[index]!;
  const [w, h] = payload.logicalSize;
  const zoom = Math.max(2, Math.floor(256 / Math.max(w, h)));
  const native = routeLabel(profile, "correctNative", locale);
  const candidate = routeLabel(profile, "correctCandidate", locale);
  const [mode, setMode] = useState<"native-mask" | "candidate-composite">(native.ok ? "native-mask" : "candidate-composite");
  const [partId, setPartId] = useState(frame.layers.length === 1 ? frame.layers[0]!.partId : "body");
  const [instruction, setInstruction] = useState("");
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const [maskUploadId, setMaskUploadId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const available = mode === "native-mask" ? native : candidate;
  const plan = available.ok && instruction.trim() ? { operation: "correct_frame", providerProfileId: profile.id, clipRevisionId: clip.id, frameId, partId, instruction: instruction.trim(), mode, maskUploadId } : null;
  return (
    <div>
      <p className="small muted">{t.correctNote(frameId)}</p>
      <div className="row">
        <label>
          {t.mode}
          <select value={mode} onChange={(e) => (setMode(e.target.value as typeof mode), setMaskUploadId(null))}>
            <option value="native-mask" disabled={!native.ok}>
              {t.nativeMask} {native.ok ? "" : t.unavailableForProfile}
            </option>
            <option value="candidate-composite" disabled={!candidate.ok}>
              {t.candidateComposite} {candidate.ok ? "" : t.unavailable}
            </option>
          </select>
        </label>
        <label>
          {t.layer}
          <select value={partId} onChange={(e) => setPartId(e.target.value)}>
            {frame.layers.map((l) => (
              <option key={l.partId} value={l.partId}>
                {l.partId}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t.correction}
          <input value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t.correctionPlaceholder} />
        </label>
      </div>
      <p className="small">
        <span className={available.strategy === "native" ? "" : "anim-sheet"}>{available.text}</span>
      </p>
      <MaskPainter width={w} height={h} zoom={zoom} background={<FrameThumb projectId={projectId} revision={clip} index={index} zoom={zoom} />} onChange={(m) => (setMask(m), setMaskUploadId(null))} />
      <div className="row small">
        <button
          type="button"
          className="secondary"
          disabled={!mask}
          onClick={async () => {
            setMessage(null);
            try {
              setMaskUploadId(await uploadPng(projectId, await maskToPng(mask!, w, h, locale), `mascara-${frameId}.png`, locale));
              setMessage(t.maskSent);
            } catch (err) {
              setMessage(errorText(err));
            }
          }}
        >
          {t.useMask}
        </button>
        <span className="muted">{maskUploadId ? t.regionMarked : mask ? t.paintAndConfirm : t.noMask}</span>
      </div>
      {message && <p className="small">{message}</p>}
      <PlanActions projectId={projectId} plan={mask && !maskUploadId ? null : plan} run={run} label={t.subs.correct} />
    </div>
  );
}

function TransferOutfit({ projectId, data, profile, clip, selected, run }: { projectId: string; data: Overview; profile: ProfileInfo; clip: RevisionView; selected: string[]; run: RunFn }) {
  const t = useMessages(animationMessages).temporal;
  const locale = useLocale();
  const route = routeLabel(profile, "outfit", locale);
  const sources = data.imageSources.flatMap((s) => s.files.map((f) => ({ key: `${s.revisionId}|${f.fileKey}`, label: `${s.name} · ${f.fileKey}`, revisionId: s.revisionId, fileKey: f.fileKey, fileId: f.fileId })));
  const [sourceKey, setSourceKey] = useState("");
  const [stateKey, setStateKey] = useState("outfit_");
  const [instructions, setInstructions] = useState("");
  const src = sources.find((s) => s.key === sourceKey);
  const frames = (clip.payload as ClipPayload).frames.map((f) => f.frameId).filter((id) => selected.length === 0 || selected.includes(id));
  return (
    <div>
      <p className="small muted">
        <span className={route.ok ? (route.strategy === "native" ? "" : "anim-sheet") : "error"}>{route.text}</span>
        {t.outfitNoteBefore}
        <strong>{t.outfitNoteStrong}</strong>
        {t.outfitNoteAfter}
      </p>
      <div className="row">
        <label>
          {t.outfitImage}
          <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="">—</option>
            {sources.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pixel bg-checker" alt={t.outfitAlt} src={`/api/v1/projects/${projectId}/media/${src.fileId}`} width={48} height={48} />
        )}
        <label>
          {t.clipState}
          <input value={stateKey} onChange={(e) => setStateKey(e.target.value.toLowerCase())} />
        </label>
        <label style={{ flex: 1 }}>
          {t.instructions}
          <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t.instructionsPlaceholder} />
        </label>
      </div>
      <p className="small muted">{t.framesNote(frames.join(", "))}</p>
      <PlanActions
        projectId={projectId}
        plan={
          route.ok && src && /^outfit_[a-z0-9]/.test(stateKey)
            ? { operation: "transfer_outfit", providerProfileId: profile.id, clipRevisionId: clip.id, frameIds: frames, outfitRevisionId: src.revisionId, outfitFileKey: src.fileKey, stateKey, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) }
            : null
        }
        run={run}
        label={t.generateDressed}
      />
    </div>
  );
}
