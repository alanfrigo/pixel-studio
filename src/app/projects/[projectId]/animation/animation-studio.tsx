"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction, MotionPayload, ProjectionKind } from "@/contracts";
import { BUILTIN_PRESETS, presetText } from "@/domain/animation/presets";
import type { RevisionView } from "@/server/catalog/catalog";
import { ApiError, apiFetch, errorMessage } from "@/app/client/api";
import { costText } from "@/app/client/cost";
import { usePoll } from "@/app/client/use-poll";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { animationMessages } from "@/i18n/messages/animation";
import { studioMessages } from "@/i18n/messages/studio";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { ClipPlayer } from "./clip-player";
import { type AssetEntry, DIRS, errorText, estimateText, type Overview, type PlanPreview, type ProfileInfo, review, type RunResult, viewUrl } from "./shared";
import { SkeletonEditor } from "./skeleton-editor";
import { LibraryPanel } from "./library-panel";
import { ObjectsPanel, StatesPanel } from "./states-panel";
import { TemporalPanel } from "./temporal-panel";
import { ViewsGrid } from "./views-grid";

/**
 * Animação (cartão S1): três modos reais e distintos — um clique (preset),
 * texto livre e esqueleto — mais vistas 4/8 com mapa isométrico. Tudo parte de
 * uma base aprovada; o resultado é revisão candidata, aprovada no fluxo de
 * revisão. A rota de cada perfil é exibida pelo que ela realmente faz.
 *
 * Cartão S3: estados (matriz de direções), objetos e sua animação, edição
 * temporal (interpolar, trecho, correção com máscara, roupa) e biblioteca
 * (etiquetas, duplicar, separar, excluir parte, espelho explícito, canvas).
 */

type Tab = "preset" | "text" | "skeleton" | "views" | "clips" | "states" | "objects" | "temporal" | "library";

interface PresetConfig {
  ceilingAmount: number | null;
  ceilingUnit: string;
  allowUnknown: boolean;
  directions: Direction[];
}

const CONFIG_KEY = (projectId: string, profileId: string) => `pixel-studio:animation:${projectId}:${profileId}`;

function loadConfig(projectId: string, profileId: string): PresetConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY(projectId, profileId));
    return raw ? (JSON.parse(raw) as PresetConfig) : null;
  } catch {
    return null;
  }
}

export function AnimationStudio({ projectId }: { projectId: string }) {
  const m = useMessages(animationMessages);
  const s = m.studio;
  const c = useMessages(commonMessages);
  const studio = useMessages(studioMessages);
  const text = useText();
  const { data, error, refresh } = usePoll(() => apiFetch<Overview>(`/projects/${projectId}/animation`), {
    active: (d) => d.jobs.some((j) => j.state === "queued" || j.state === "running"),
    fastMs: 1000,
    slowMs: 15_000,
  });
  const [tab, setTab] = useState<Tab>("preset");
  const [baseAssetId, setBaseAssetId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [direction, setDirection] = useState<Direction>("S");
  const [message, setMessage] = useState<string | null>(null);
  const [editorPreset, setEditorPreset] = useState<string | null>(null);

  const bases = useMemo(() => (data?.bases ?? []).filter((b) => b.asset.approvedRevisionId), [data]);
  const base = bases.find((b) => b.asset.id === baseAssetId) ?? bases[0] ?? null;
  const approved = base?.revisions.find((r) => r.id === base.asset.approvedRevisionId) ?? null;
  const basePayload = approved ? (approved.payload as BasePayload) : null;
  const profiles = (data?.profiles ?? []).filter((p) => !p.unavailable);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles[0] ?? null;
  const hasView = (d: Direction) => Boolean(basePayload?.views.some((v) => v.direction === d));

  async function run(plan: Record<string, unknown>, opts: { oneClick?: boolean; allowUnknownCost?: boolean } = {}): Promise<RunResult | null> {
    setMessage(null);
    try {
      const res = await apiFetch<RunResult>(`/projects/${projectId}/animation/run`, { method: "POST", json: { plan, oneClick: opts.oneClick ?? false, allowUnknownCost: opts.allowUnknownCost ?? false } });
      setMessage(res.created ? s.jobQueued(res.job.id, text(res.route.label)) : s.jobExists(res.job.id));
      refresh();
      return res;
    } catch (err) {
      if (err instanceof ApiError && err.details?.reason === "motion_missing") {
        setEditorPreset(String(err.details.presetKey));
        setTab("skeleton");
      }
      setMessage(errorText(err));
      throw err;
    }
  }

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{c.loading}</p>;

  return (
    <>
      <h1>{s.title}</h1>
      {bases.length === 0 ? (
        <section>
          <p className="muted">{s.noBases}</p>
          <Link href={`/projects/${projectId}#create`} className="button">{studio.startWithCharacter}</Link>
        </section>
      ) : (
        <section>
          <div className="row">
            <label>
              {s.approvedBase}
              <select value={base?.asset.id ?? ""} onChange={(e) => setBaseAssetId(e.target.value)}>
                {bases.map((b) => (
                  <option key={b.asset.id} value={b.asset.id}>
                    {b.asset.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {s.profile}
              <select value={profile?.id ?? ""} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.simulated ? m.shared.simulated : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {m.shared.direction}
              <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                {DIRS.map((d) => (
                  <option key={d} value={d}>
                    {d} · {c.directions[d]}
                    {hasView(d) ? "" : s.noView}
                  </option>
                ))}
              </select>
            </label>
            {approved && basePayload && (
              <span className="row small">
                {basePayload.views.map((v) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={v.direction} className="pixel" alt={m.shared.viewAlt(v.direction)} title={m.shared.viewAlt(v.direction)} src={viewUrl(projectId, approved, v.direction)!} width={48} height={48} />
                ))}
                <span className="muted">
                  r{approved.number} · {basePayload.logicalSize.join("×")} · {s.pivot(basePayload.groundOrigin.join(","))}
                </span>
              </span>
            )}
          </div>
          {profile && <RouteBadges profile={profile} />}
          {!hasView(direction) && <p className="small error">{s.missingView(direction)}</p>}
        </section>
      )}
      <nav className="row anim-tabs" aria-label={s.title}>
        {(
          [
            ["preset", s.tabs.preset],
            ["text", s.tabs.text],
            ["skeleton", s.tabs.skeleton],
            ["views", s.tabs.views],
            ["clips", s.tabs.clips],
            ["states", s.tabs.states],
            ["objects", s.tabs.objects],
            ["temporal", s.tabs.temporal],
            ["library", s.tabs.library],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "" : "secondary"} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {message && <p className="small">{message}</p>}
      {base && approved && basePayload && profile && (
        <>
          {tab === "preset" && <PresetTab projectId={projectId} profile={profile} baseRevisionId={approved.id} direction={direction} hasView={hasView} run={run} />}
          {tab === "text" && <TextTab projectId={projectId} profile={profile} baseRevisionId={approved.id} direction={direction} run={run} />}
          {tab === "skeleton" && (
            <SkeletonTab
              key={`${approved.id}:${direction}:${editorPreset ?? ""}`}
              projectId={projectId}
              profile={profile}
              base={base}
              approved={approved}
              direction={direction}
              projection={data.projection as ProjectionKind}
              motions={data.motions}
              presetKey={editorPreset}
              run={run}
              onChanged={refresh}
            />
          )}
          {tab === "views" && (
            <section>
              <h2>{s.viewsHeading}</h2>
              <ViewsGrid
                projectId={projectId}
                base={base}
                approved={approved}
                projection={data.projection}
                worldToView={data.orientation.worldToView}
                rotationLabel={"label" in (profile.routes.rotation ?? {}) ? text((profile.routes.rotation as { label: TextValue }).label) : null}
                onGenerate={async (views, asymmetries) => {
                  for (const view of views) {
                    await run({ operation: "rotate_views", providerProfileId: profile.id, baseRevisionId: approved.id, view, asymmetries }).catch(() => undefined);
                  }
                }}
                onChanged={refresh}
              />
            </section>
          )}
          {tab === "clips" && <ClipsTab projectId={projectId} base={base} clips={data.clips} onChanged={refresh} />}
        </>
      )}
      {profile && tab === "states" && <StatesPanel projectId={projectId} data={data} profile={profile} run={run} onChanged={refresh} />}
      {profile && tab === "objects" && <ObjectsPanel projectId={projectId} data={data} profile={profile} run={run} onChanged={refresh} />}
      {profile && tab === "temporal" && <TemporalPanel projectId={projectId} data={data} profile={profile} run={run} onChanged={refresh} />}
      {tab === "library" && <LibraryPanel projectId={projectId} data={data} onChanged={refresh} />}
      <JobsList jobs={data.jobs} />
    </>
  );
}

function RouteBadges({ profile }: { profile: ProfileInfo }) {
  const s = useMessages(animationMessages).studio;
  const c = useMessages(commonMessages);
  const text = useText();
  const entries: [string, string][] = [
    [s.routes.text, "text"],
    [s.routes.skeleton, "skeleton"],
    [s.routes.rotation, "rotation"],
  ];
  return (
    <ul className="small anim-routes">
      {entries.map(([label, key]) => {
        const r = profile.routes[key];
        return (
          <li key={key}>
            <strong>{label}:</strong>{" "}
            {r && "label" in r ? (
              <span className={r.strategy === "native" ? "" : "anim-sheet"}>{text(r.label as TextValue)}</span>
            ) : (
              <span className="error">
                {c.unavailable}
                {r && "unavailable" in r ? ` — ${text(r.unavailable as TextValue)}` : ""}
              </span>
            )}
          </li>
        );
      })}
      {profile.simulated && <li className="muted">{s.simulatedProfile}</li>}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Um clique
// ---------------------------------------------------------------------------

function PresetTab(props: { projectId: string; profile: ProfileInfo; baseRevisionId: string; direction: Direction; hasView: (d: Direction) => boolean; run: (plan: Record<string, unknown>, o?: { oneClick?: boolean; allowUnknownCost?: boolean }) => Promise<RunResult | null> }) {
  const { projectId, profile } = props;
  const m = useMessages(animationMessages);
  const t = m.studio.preset;
  const locale = useLocale();
  const text = useText();
  const [config, setConfig] = useState<PresetConfig | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    // Configuração por perfil guardada no navegador (conveniência; o servidor decide o envio pelo plano).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfig(loadConfig(projectId, profile.id));
  }, [projectId, profile.id]);

  const directions = config?.directions?.length ? config.directions : [props.direction];

  function saveConfig(next: PresetConfig) {
    setConfig(next);
    try {
      localStorage.setItem(CONFIG_KEY(projectId, profile.id), JSON.stringify(next));
    } catch {
      /* sem armazenamento local: vale só nesta sessão */
    }
    setEditing(false);
    setReason(null);
  }

  async function animate(presetKey: string) {
    if (!config) {
      setEditing(true);
      setReason(t.configureFirst);
      return;
    }
    setBusy(presetKey);
    try {
      for (const direction of directions) {
        await props.run(
          {
            operation: "animate_preset",
            providerProfileId: profile.id,
            baseRevisionId: props.baseRevisionId,
            direction,
            presetKey,
            costCeiling: config.ceilingAmount !== null ? { amount: config.ceilingAmount, unit: config.ceilingUnit } : null,
          },
          { oneClick: true, allowUnknownCost: config.allowUnknown },
        );
      }
    } catch (err) {
      if (err instanceof ApiError && err.details?.needsConfiguration && err.details.reason !== "motion_missing") {
        setEditing(true);
        setReason(err.message);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section>
      <h2>{t.heading}</h2>
      <p className="small muted">
        {t.estimateOfProfile}{" "}
        {profile.estimate
          ? profile.estimate.kind === "known"
            ? t.perSubmission(costText(profile.estimate.amount, locale))
            : profile.estimate.kind === "unknown"
              ? t.unknownEstimate(text(profile.estimate.reason as TextValue))
              : t.rangeEstimate
          : "—"}{" "}
        · {t.directions} {directions.join(", ")} · {t.ceiling}{" "}
        {config ? (config.ceilingAmount !== null ? costText({ amount: config.ceilingAmount, unit: config.ceilingUnit }, locale) : t.noCeiling) : t.notConfigured}
        {config?.allowUnknown ? t.unknownAccepted : ""}{" "}
        <button type="button" className="secondary" onClick={() => setEditing((e) => !e)}>
          {t.configure}
        </button>
      </p>
      {editing && <PresetConfigForm initial={config} profile={profile} direction={props.direction} hasView={props.hasView} reason={reason} onSave={saveConfig} />}
      <div className="anim-presets">
        {BUILTIN_PRESETS.map((p) => (
          <article key={p.key} className="anim-preset">
            <h3>
              {text(presetText(p).label)} <span className="muted small">v{p.version}</span>
            </h3>
            <p className="small">
              {m.shared.frames(p.frameIds.length)} · {p.durationsMs.join("/")} ms · {p.playback === "loop" ? m.shared.playback.loop : m.shared.playback.once}
              {p.stance ? t.stance(p.stance) : ""}
            </p>
            <p className="small muted">
              {p.strategy === "skeleton" ? t.skeletonSequence : t.textAction} · {text(presetText(p).intent)}
            </p>
            <button type="button" disabled={busy !== null || directions.some((d) => !props.hasView(d))} onClick={() => animate(p.key)}>
              {busy === p.key ? m.shared.sending : t.animate}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PresetConfigForm(props: { initial: PresetConfig | null; profile: ProfileInfo; direction: Direction; hasView: (d: Direction) => boolean; reason: string | null; onSave: (c: PresetConfig) => void }) {
  const t = useMessages(animationMessages).studio.config;
  const estimateUnit = props.profile.estimate?.kind === "known" ? props.profile.estimate.amount.unit : "USD";
  const [amount, setAmount] = useState<string>(props.initial?.ceilingAmount?.toString() ?? "");
  const [unit, setUnit] = useState(props.initial?.ceilingUnit ?? estimateUnit);
  const [allowUnknown, setAllowUnknown] = useState(props.initial?.allowUnknown ?? false);
  const [dirs, setDirs] = useState<Direction[]>(props.initial?.directions?.length ? props.initial.directions : [props.direction]);
  return (
    <fieldset className="small">
      <legend>{t.legend(props.profile.name)}</legend>
      {props.reason && <p className="error">{props.reason}</p>}
      <div className="row">
        <label>
          {t.ceilingPerSubmission}
          <input type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={t.ceilingPlaceholder} />
        </label>
        <label>
          {t.unit}
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="USD">USD</option>
            <option value="generations">{t.unitGenerations}</option>
            <option value="credits">{t.unitCredits}</option>
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={allowUnknown} onChange={(e) => setAllowUnknown(e.target.checked)} /> {t.allowUnknown}
        </label>
      </div>
      <div className="row">
        {t.directions}
        {DIRS.map((d) => (
          <label key={d} style={{ flexDirection: "row", alignItems: "center", gap: 2 }} title={props.hasView(d) ? "" : t.noApprovedView}>
            <input type="checkbox" disabled={!props.hasView(d)} checked={dirs.includes(d)} onChange={(e) => setDirs((all) => (e.target.checked ? [...all, d] : all.filter((x) => x !== d)))} /> {d}
          </label>
        ))}
      </div>
      <button type="button" disabled={dirs.length === 0} onClick={() => props.onSave({ ceilingAmount: amount.trim() === "" ? null : Number(amount), ceilingUnit: unit, allowUnknown, directions: dirs })}>
        {t.save}
      </button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Texto livre
// ---------------------------------------------------------------------------

function TextTab(props: { projectId: string; profile: ProfileInfo; baseRevisionId: string; direction: Direction; run: (plan: Record<string, unknown>) => Promise<RunResult | null> }) {
  const m = useMessages(animationMessages);
  const t = m.studio.text;
  const [text, setText] = useState("");
  const [frames, setFrames] = useState(4);
  const [ms, setMs] = useState(120);
  const [playback, setPlayback] = useState<ClipPayload["playback"]>("loop");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const plan = { operation: "animate_text", providerProfileId: props.profile.id, baseRevisionId: props.baseRevisionId, direction: props.direction, actionText: text, durationsMs: Array(frames).fill(ms), playback };

  async function loadPreview() {
    setMessage(null);
    try {
      setPreview(await apiFetch<PlanPreview>(`/projects/${props.projectId}/generation-plans`, { method: "POST", json: plan }));
    } catch (err) {
      setPreview(null);
      setMessage(errorText(err));
    }
  }

  return (
    <section>
      <h2>{t.heading}</h2>
      <label>
        {t.describeMotion}
        <textarea value={text} maxLength={1000} onChange={(e) => (setText(e.target.value), setPreview(null))} placeholder={t.motionPlaceholder} />
      </label>
      <div className="row">
        <label>
          {t.framesLabel}
          <input type="number" min={1} max={16} value={frames} onChange={(e) => (setFrames(Math.max(1, Math.min(16, Number(e.target.value) || 1))), setPreview(null))} />
        </label>
        <label>
          {m.shared.msPerFrame}
          <input type="number" min={1} max={60000} value={ms} onChange={(e) => (setMs(Math.max(1, Number(e.target.value) || 1)), setPreview(null))} />
        </label>
        <label>
          {m.shared.playbackLabel}
          <select value={playback} onChange={(e) => (setPlayback(e.target.value as ClipPayload["playback"]), setPreview(null))}>
            <option value="loop">{m.shared.playback.loop}</option>
            <option value="once">{m.shared.playback.once}</option>
            <option value="ping_pong">{m.shared.playback.ping_pong}</option>
          </select>
        </label>
        <button type="button" className="secondary" disabled={!text.trim()} onClick={loadPreview}>
          {m.shared.planPreview}
        </button>
        <button type="button" disabled={!text.trim()} onClick={() => props.run(plan).catch(() => undefined)}>
          {m.shared.generate}
        </button>
      </div>
      <p className="small muted">{t.note}</p>
      {message && <p className="small error">{message}</p>}
      {preview && <PlanBox preview={preview} />}
    </section>
  );
}

function PlanBox({ preview }: { preview: PlanPreview }) {
  const sh = useMessages(animationMessages).shared;
  const locale = useLocale();
  const text = useText();
  const sheet = (preview.plan.params as { sheet?: { columns: number; rows: number; backgroundKey: string | null } }).sheet;
  return (
    <div className="small">
      <p>
        <strong>{text(preview.route.label)}</strong> · {sh.plan.destination(preview.destination.name)}
        {preview.destination.simulated ? sh.simulated : ""} · {sh.plan.estimate(estimateText(preview.plan, locale))} · {sh.plan.capabilities(preview.plan.requiredCapabilities.join(", "))}
        {sheet ? sh.plan.sheet(sheet.columns, sheet.rows, Boolean(sheet.backgroundKey)) : ""}
      </p>
      <pre>{preview.plan.prompt.compiled}</pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Esqueleto
// ---------------------------------------------------------------------------

function SkeletonTab(props: {
  projectId: string;
  profile: ProfileInfo;
  base: AssetEntry;
  approved: RevisionView;
  direction: Direction;
  projection: ProjectionKind;
  motions: Overview["motions"];
  presetKey: string | null;
  run: (plan: Record<string, unknown>) => Promise<RunResult | null>;
  onChanged: () => void;
}) {
  const { projectId, approved, direction } = props;
  const am = useMessages(animationMessages);
  const t = am.studio.skeleton;
  const c = useMessages(commonMessages);
  const text = useText();
  const basePayload = approved.payload as BasePayload;
  const ownMotions = props.motions.filter((m) => m.revisions.some((r) => (r.technicalReport as { baseAssetId?: string } | null)?.baseAssetId === props.base.asset.id && (r.payload as MotionPayload).direction === direction));
  const latest = ownMotions[0]?.revisions[0] ?? null;
  const [actionText, setActionText] = useState("");
  const [appearance, setAppearance] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const imageUrl = viewUrl(projectId, approved, direction);
  if (!imageUrl) return <section className="error">{t.noView(direction)}</section>;

  const planFor = (motionRevisionId: string) => ({
    operation: "animate_skeleton",
    providerProfileId: props.profile.id,
    baseRevisionId: approved.id,
    motionRevisionId,
    actionText: actionText.trim() || (latest ? (latest.payload as MotionPayload).action : "movimento"),
    ...(appearance.trim() ? { appearance: appearance.trim() } : {}),
    playback: latest && (latest.payload as MotionPayload).loop ? "loop" : "once",
  });

  return (
    <section>
      <h2>{t.heading}</h2>
      <p className="small muted">
        {"label" in (props.profile.routes.skeleton ?? {}) ? text((props.profile.routes.skeleton as { label: TextValue }).label) : t.noSkeletonMode}
        {t.sequenceNote}
      </p>
      <SkeletonEditor
        projectId={projectId}
        baseRevisionId={approved.id}
        baseImageUrl={imageUrl}
        cell={basePayload.logicalSize}
        direction={direction}
        projection={props.projection}
        presets={BUILTIN_PRESETS}
        initialMotion={props.presetKey ? null : latest ? (latest.payload as MotionPayload) : null}
        initialPresetKey={props.presetKey}
        onSaved={() => props.onChanged()}
      />
      <h3>{t.motionsHeading(direction)}</h3>
      {ownMotions.length === 0 && <p className="small muted">{t.noMotions}</p>}
      <ul className="list small">
        {ownMotions.flatMap((m) =>
          m.revisions.map((r) => {
            const mp = r.payload as MotionPayload;
            return (
              <li key={r.id} className="row">
                <span>
                  {m.asset.name} r{r.number} · <span className={`badge state-${r.status}`}>{labelOf(c.revisionStatus, r.status)}</span> · {mp.action} · {t.poses(mp.poses.length)} · {mp.skeleton.kind}
                </span>
                {r.status === "candidate" && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={async () => {
                      try {
                        await review(projectId, m.asset.id, r.id, "approve", m.asset.approvedRevisionId);
                        props.onChanged();
                      } catch (err) {
                        setMessage(errorText(err));
                      }
                    }}
                  >
                    {c.approve}
                  </button>
                )}
                {r.status === "approved" && (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      onClick={async () => {
                        try {
                          setPreview(await apiFetch<PlanPreview>(`/projects/${projectId}/generation-plans`, { method: "POST", json: planFor(r.id) }));
                        } catch (err) {
                          setMessage(errorText(err));
                        }
                      }}
                    >
                      {am.shared.preview}
                    </button>
                    <button type="button" onClick={() => props.run(planFor(r.id)).catch(() => undefined)}>
                      {t.generateWithPoses}
                    </button>
                  </>
                )}
              </li>
            );
          }),
        )}
      </ul>
      <div className="row">
        <label>
          {t.actionShort}
          <input value={actionText} onChange={(e) => setActionText(e.target.value)} placeholder={t.actionPlaceholder} />
        </label>
        <label>
          {t.appearance}
          <input value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder={t.appearancePlaceholder} />
        </label>
      </div>
      {message && <p className="small error">{message}</p>}
      {preview && <PlanBox preview={preview} />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Clipes
// ---------------------------------------------------------------------------

function ClipsTab({ projectId, base, clips, onChanged }: { projectId: string; base: AssetEntry; clips: Overview["clips"]; onChanged: () => void }) {
  const m = useMessages(animationMessages);
  const t = m.studio.clips;
  const c = useMessages(commonMessages);
  const text = useText();
  const own = clips.filter((c) => c.asset.name.startsWith(`${base.asset.name} · `) || c.revisions.some((r) => (r.technicalReport as { baseAssetId?: string } | null)?.baseAssetId === base.asset.id));
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const all = own.flatMap((c) => c.revisions.map((r) => ({ asset: c.asset, revision: r })));
  const current = all.find((x) => x.revision.id === selected) ?? all[0] ?? null;
  return (
    <section>
      <h2>{t.heading(base.asset.name)}</h2>
      {all.length === 0 && <p className="small muted">{t.none}</p>}
      <div className="grid2">
        <ul className="list small">
          {all.map(({ asset, revision }) => {
            const clip = revision.payload as ClipPayload;
            const report = revision.technicalReport as { routeLabel?: TextValue; operation?: string; warnings?: TextValue[] } | null;
            return (
              <li key={revision.id}>
                <button type="button" className={current?.revision.id === revision.id ? "" : "secondary"} onClick={() => setSelected(revision.id)}>
                  {asset.name} r{revision.number}
                </button>{" "}
                <span className={`badge state-${revision.status}`}>{labelOf(c.revisionStatus, revision.status)}</span>
                {asset.approvedRevisionId === revision.id ? ` · ${c.revisionStatus.active}` : ""} · {m.shared.frames(clip.frames.length)} ·{" "}
                {report?.operation === "retime" ? t.retimeLocal : report?.routeLabel ? text(report.routeLabel) : revision.origin}
                {(report?.warnings?.length ?? 0) > 0 && <span className="error"> · {t.warnings(report!.warnings!.length)}</span>}
              </li>
            );
          })}
        </ul>
        {current && (
          <div>
            <ClipPlayer key={current.revision.id} projectId={projectId} revision={current.revision} onSaved={(id) => (setSelected(id), onChanged())} />
            <div className="row" style={{ marginTop: 8 }}>
              {current.revision.status !== "approved" && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await review(projectId, current.asset.id, current.revision.id, "approve", current.asset.approvedRevisionId);
                      onChanged();
                    } catch (err) {
                      setMessage(errorText(err));
                    }
                  }}
                >
                  {m.shared.approveRev(current.revision.number)}
                </button>
              )}
              {current.revision.status === "candidate" && (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    const reason = window.prompt(c.rejectReasonPrompt);
                    if (!reason) return;
                    try {
                      await review(projectId, current.asset.id, current.revision.id, "reject", current.asset.approvedRevisionId, reason);
                      onChanged();
                    } catch (err) {
                      setMessage(errorText(err));
                    }
                  }}
                >
                  {c.reject}
                </button>
              )}
            </div>
            {((current.revision.technicalReport as { warnings?: TextValue[] } | null)?.warnings ?? []).map((w, i) => (
              <p key={i} className="small error">
                {text(w)}
              </p>
            ))}
            {message && <p className="small error">{message}</p>}
            <p className="small muted">{t.exportNote}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function JobsList({ jobs }: { jobs: Overview["jobs"] }) {
  const s = useMessages(animationMessages).studio;
  const c = useMessages(commonMessages);
  const locale = useLocale();
  if (jobs.length === 0) return null;
  return (
    <section>
      <h2>{s.jobsHeading}</h2>
      <ul className="list small">
        {jobs.map((j) => (
          <li key={j.id}>
            {j.id} · <span className={`badge state-${j.state}`}>{labelOf(c.jobState, j.state)}</span>
            {j.stage ? ` · ${j.stage}` : ""}
            {j.error ? <span className="error"> · {errorMessage(j.error, locale)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
