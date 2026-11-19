"use client";

import { useEffect, useMemo, useState } from "react";
import type { BasePayload, ClipPayload, Direction, MotionPayload, ProjectionKind } from "@/contracts";
import { BUILTIN_PRESETS } from "@/domain/animation/presets";
import type { RevisionView } from "@/server/catalog/catalog";
import { ApiError, apiFetch } from "@/app/client/api";
import { usePoll } from "@/app/client/use-poll";
import { ClipPlayer } from "./clip-player";
import { type AssetEntry, DIR_LABEL, DIRS, errorText, estimateText, type Overview, type PlanPreview, type ProfileInfo, review, type RunResult, viewUrl } from "./shared";
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
      setMessage(res.created ? `Job ${res.job.id} enfileirado · ${res.route.label}.` : `Mesmo pedido: job ${res.job.id} já existe (nenhum envio nem cobrança duplicados).`);
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
  if (!data) return <p className="muted">Carregando…</p>;

  return (
    <>
      <h1>Animação, estados e edição temporal</h1>
      {bases.length === 0 ? (
        <section>
          <p className="error">Nenhuma base de personagem aprovada neste projeto. Importe ou gere uma base (character/base) e aprove-a na biblioteca do projeto, ou crie um objeto (baú, tocha) a partir de uma imagem na aba Objetos.</p>
        </section>
      ) : (
        <section>
          <div className="row">
            <label>
              Base aprovada
              <select value={base?.asset.id ?? ""} onChange={(e) => setBaseAssetId(e.target.value)}>
                {bases.map((b) => (
                  <option key={b.asset.id} value={b.asset.id}>
                    {b.asset.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Perfil
              <select value={profile?.id ?? ""} onChange={(e) => setProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.simulated ? " (simulado)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Direção
              <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
                {DIRS.map((d) => (
                  <option key={d} value={d}>
                    {d} · {DIR_LABEL[d]}
                    {hasView(d) ? "" : " — sem vista"}
                  </option>
                ))}
              </select>
            </label>
            {approved && basePayload && (
              <span className="row small">
                {basePayload.views.map((v) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={v.direction} className="pixel" alt={`Vista ${v.direction}`} title={`Vista ${v.direction}`} src={viewUrl(projectId, approved, v.direction)!} width={48} height={48} />
                ))}
                <span className="muted">
                  r{approved.number} · {basePayload.logicalSize.join("×")} · pivô {basePayload.groundOrigin.join(",")}
                </span>
              </span>
            )}
          </div>
          {profile && <RouteBadges profile={profile} />}
          {!hasView(direction) && <p className="small error">A base não tem a vista {direction}: gere-a na aba Vistas. Espelhar a vista oposta não é implícito.</p>}
        </section>
      )}
      <nav className="row anim-tabs">
        {(
          [
            ["preset", "Um clique"],
            ["text", "Texto livre"],
            ["skeleton", "Esqueleto"],
            ["views", "Vistas 4/8"],
            ["clips", "Clipes e revisão"],
            ["states", "Estados"],
            ["objects", "Objetos"],
            ["temporal", "Edição temporal"],
            ["library", "Biblioteca"],
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
              <h2>Vistas</h2>
              <ViewsGrid
                projectId={projectId}
                base={base}
                approved={approved}
                projection={data.projection}
                worldToView={data.orientation.worldToView}
                rotationLabel={"label" in (profile.routes.rotation ?? {}) ? (profile.routes.rotation as { label: string }).label : null}
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
  const entries: [string, string][] = [
    ["Texto", "text"],
    ["Esqueleto", "skeleton"],
    ["Vistas", "rotation"],
  ];
  return (
    <ul className="small anim-routes">
      {entries.map(([label, key]) => {
        const r = profile.routes[key];
        return (
          <li key={key}>
            <strong>{label}:</strong>{" "}
            {r && "label" in r ? <span className={r.strategy === "native" ? "" : "anim-sheet"}>{r.label}</span> : <span className="error">indisponível{r && "unavailable" in r ? ` — ${r.unavailable}` : ""}</span>}
          </li>
        );
      })}
      {profile.simulated && <li className="muted">Perfil simulado: ensaia fila, publicação e revisão sem custo; não substitui provedor real.</li>}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Um clique
// ---------------------------------------------------------------------------

function PresetTab(props: { projectId: string; profile: ProfileInfo; baseRevisionId: string; direction: Direction; hasView: (d: Direction) => boolean; run: (plan: Record<string, unknown>, o?: { oneClick?: boolean; allowUnknownCost?: boolean }) => Promise<RunResult | null> }) {
  const { projectId, profile } = props;
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
      setReason("Configure o teto de custo deste perfil antes do primeiro clique.");
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
      <h2>Um clique · presets versionados</h2>
      <p className="small muted">
        Estimativa deste perfil: {profile.estimate ? (profile.estimate.kind === "known" ? `${profile.estimate.amount.amount} ${profile.estimate.amount.unit} por envio` : profile.estimate.kind === "unknown" ? `desconhecida — ${profile.estimate.reason}` : "faixa") : "—"} · direções:{" "}
        {directions.join(", ")} · teto: {config ? (config.ceilingAmount !== null ? `${config.ceilingAmount} ${config.ceilingUnit}` : "sem teto") : "não configurado"}
        {config?.allowUnknown ? " · custo desconhecido aceito" : ""}{" "}
        <button type="button" className="secondary" onClick={() => setEditing((e) => !e)}>
          Configurar
        </button>
      </p>
      {editing && <PresetConfigForm initial={config} profile={profile} direction={props.direction} hasView={props.hasView} reason={reason} onSave={saveConfig} />}
      <div className="anim-presets">
        {BUILTIN_PRESETS.map((p) => (
          <article key={p.key} className="anim-preset">
            <h3>
              {p.label} <span className="muted small">v{p.version}</span>
            </h3>
            <p className="small">
              {p.frameIds.length} quadros · {p.durationsMs.join("/")} ms · {p.playback === "loop" ? "ciclo" : "uma vez"}
              {p.stance ? ` · postura ${p.stance}` : ""}
            </p>
            <p className="small muted">
              {p.strategy === "skeleton" ? "Sequência de esqueleto (exige movimento aprovado)" : "Ação por texto"} · {p.intent}
            </p>
            <button type="button" disabled={busy !== null || directions.some((d) => !props.hasView(d))} onClick={() => animate(p.key)}>
              {busy === p.key ? "Enviando…" : "Animar"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function PresetConfigForm(props: { initial: PresetConfig | null; profile: ProfileInfo; direction: Direction; hasView: (d: Direction) => boolean; reason: string | null; onSave: (c: PresetConfig) => void }) {
  const estimateUnit = props.profile.estimate?.kind === "known" ? props.profile.estimate.amount.unit : "USD";
  const [amount, setAmount] = useState<string>(props.initial?.ceilingAmount?.toString() ?? "");
  const [unit, setUnit] = useState(props.initial?.ceilingUnit ?? estimateUnit);
  const [allowUnknown, setAllowUnknown] = useState(props.initial?.allowUnknown ?? false);
  const [dirs, setDirs] = useState<Direction[]>(props.initial?.directions?.length ? props.initial.directions : [props.direction]);
  return (
    <fieldset className="small">
      <legend>Configuração do atalho ({props.profile.name})</legend>
      {props.reason && <p className="error">{props.reason}</p>}
      <div className="row">
        <label>
          Teto por envio
          <input type="number" min={0} step={0.01} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="ex.: 0.10" />
        </label>
        <label>
          Unidade
          <select value={unit} onChange={(e) => setUnit(e.target.value)}>
            <option value="USD">USD</option>
            <option value="generations">gerações</option>
            <option value="credits">créditos</option>
          </select>
        </label>
        <label style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <input type="checkbox" checked={allowUnknown} onChange={(e) => setAllowUnknown(e.target.checked)} /> aceito custo desconhecido (1 envio por direção)
        </label>
      </div>
      <div className="row">
        Direções:
        {DIRS.map((d) => (
          <label key={d} style={{ flexDirection: "row", alignItems: "center", gap: 2 }} title={props.hasView(d) ? "" : "sem vista aprovada"}>
            <input type="checkbox" disabled={!props.hasView(d)} checked={dirs.includes(d)} onChange={(e) => setDirs((all) => (e.target.checked ? [...all, d] : all.filter((x) => x !== d)))} /> {d}
          </label>
        ))}
      </div>
      <button type="button" disabled={dirs.length === 0} onClick={() => props.onSave({ ceilingAmount: amount.trim() === "" ? null : Number(amount), ceilingUnit: unit, allowUnknown, directions: dirs })}>
        Salvar configuração
      </button>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Texto livre
// ---------------------------------------------------------------------------

function TextTab(props: { projectId: string; profile: ProfileInfo; baseRevisionId: string; direction: Direction; run: (plan: Record<string, unknown>) => Promise<RunResult | null> }) {
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
      <h2>Texto livre</h2>
      <label>
        Descreva o movimento
        <textarea value={text} maxLength={1000} onChange={(e) => (setText(e.target.value), setPreview(null))} placeholder="ex.: pula no lugar com os braços abertos e aterrissa agachado" />
      </label>
      <div className="row">
        <label>
          Quadros
          <input type="number" min={1} max={16} value={frames} onChange={(e) => (setFrames(Math.max(1, Math.min(16, Number(e.target.value) || 1))), setPreview(null))} />
        </label>
        <label>
          ms por quadro
          <input type="number" min={1} max={60000} value={ms} onChange={(e) => (setMs(Math.max(1, Number(e.target.value) || 1)), setPreview(null))} />
        </label>
        <label>
          Repetição
          <select value={playback} onChange={(e) => (setPlayback(e.target.value as ClipPayload["playback"]), setPreview(null))}>
            <option value="loop">ciclo</option>
            <option value="once">uma vez</option>
            <option value="ping_pong">vai e volta</option>
          </select>
        </label>
        <button type="button" className="secondary" disabled={!text.trim()} onClick={loadPreview}>
          Prévia do plano
        </button>
        <button type="button" disabled={!text.trim()} onClick={() => props.run(plan).catch(() => undefined)}>
          Gerar
        </button>
      </div>
      <p className="small muted">Texto não garante poses exatas: a animação por texto nativa recebe a vista e a ação; rotas genéricas desenham uma folha que é fatiada localmente.</p>
      {message && <p className="small error">{message}</p>}
      {preview && <PlanBox preview={preview} />}
    </section>
  );
}

function PlanBox({ preview }: { preview: PlanPreview }) {
  const sheet = (preview.plan.params as { sheet?: { columns: number; rows: number; backgroundKey: string | null } }).sheet;
  return (
    <div className="small">
      <p>
        <strong>{preview.route.label}</strong> · destino {preview.destination.name}
        {preview.destination.simulated ? " (simulado)" : ""} · estimativa {estimateText(preview.plan)} · capacidades {preview.plan.requiredCapabilities.join(", ")}
        {sheet ? ` · folha ${sheet.columns}×${sheet.rows}${sheet.backgroundKey ? " com fundo de cor-chave removido localmente" : " com alfa"}` : ""}
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
  const basePayload = approved.payload as BasePayload;
  const ownMotions = props.motions.filter((m) => m.revisions.some((r) => (r.technicalReport as { baseAssetId?: string } | null)?.baseAssetId === props.base.asset.id && (r.payload as MotionPayload).direction === direction));
  const latest = ownMotions[0]?.revisions[0] ?? null;
  const [actionText, setActionText] = useState("");
  const [appearance, setAppearance] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const imageUrl = viewUrl(projectId, approved, direction);
  if (!imageUrl) return <section className="error">A base não tem a vista {direction}; gere-a na aba Vistas.</section>;

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
      <h2>Esqueleto · poses editáveis</h2>
      <p className="small muted">
        {"label" in (props.profile.routes.skeleton ?? {}) ? (props.profile.routes.skeleton as { label: string }).label : "Perfil sem modo esqueleto"} — a sequência abaixo é o que vai ao provedor.
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
      <h3>Movimentos desta base ({direction})</h3>
      {ownMotions.length === 0 && <p className="small muted">Nenhum movimento publicado ainda.</p>}
      <ul className="list small">
        {ownMotions.flatMap((m) =>
          m.revisions.map((r) => {
            const mp = r.payload as MotionPayload;
            return (
              <li key={r.id} className="row">
                <span>
                  {m.asset.name} r{r.number} · <span className={`badge state-${r.status}`}>{r.status}</span> · {mp.action} · {mp.poses.length} poses · {mp.skeleton.kind}
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
                    Aprovar
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
                      Prévia
                    </button>
                    <button type="button" onClick={() => props.run(planFor(r.id)).catch(() => undefined)}>
                      Gerar com estas poses
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
          Ação (texto curto)
          <input value={actionText} onChange={(e) => setActionText(e.target.value)} placeholder="ex.: recua ao ser atingido" />
        </label>
        <label>
          Aparência (opcional)
          <input value={appearance} onChange={(e) => setAppearance(e.target.value)} placeholder="ex.: guerreiro de túnica azul" />
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
  const own = clips.filter((c) => c.asset.name.startsWith(`${base.asset.name} · `) || c.revisions.some((r) => (r.technicalReport as { baseAssetId?: string } | null)?.baseAssetId === base.asset.id));
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const all = own.flatMap((c) => c.revisions.map((r) => ({ asset: c.asset, revision: r })));
  const current = all.find((x) => x.revision.id === selected) ?? all[0] ?? null;
  return (
    <section>
      <h2>Clipes de {base.asset.name}</h2>
      {all.length === 0 && <p className="small muted">Nenhum clipe ainda: use um clique, texto livre ou esqueleto.</p>}
      <div className="grid2">
        <ul className="list small">
          {all.map(({ asset, revision }) => {
            const clip = revision.payload as ClipPayload;
            const report = revision.technicalReport as { routeLabel?: string; operation?: string; warnings?: string[] } | null;
            return (
              <li key={revision.id}>
                <button type="button" className={current?.revision.id === revision.id ? "" : "secondary"} onClick={() => setSelected(revision.id)}>
                  {asset.name} r{revision.number}
                </button>{" "}
                <span className={`badge state-${revision.status}`}>{revision.status}</span>
                {asset.approvedRevisionId === revision.id ? " · ativa" : ""} · {clip.frames.length} quadros · {report?.operation === "retime" ? "retime local (sem geração)" : (report?.routeLabel ?? revision.origin)}
                {(report?.warnings?.length ?? 0) > 0 && <span className="error"> · {report!.warnings!.length} alerta(s)</span>}
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
                  Aprovar r{current.revision.number}
                </button>
              )}
              {current.revision.status === "candidate" && (
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    const reason = window.prompt("Motivo da reprovação");
                    if (!reason) return;
                    try {
                      await review(projectId, current.asset.id, current.revision.id, "reject", current.asset.approvedRevisionId, reason);
                      onChanged();
                    } catch (err) {
                      setMessage(errorText(err));
                    }
                  }}
                >
                  Reprovar
                </button>
              )}
            </div>
            {((current.revision.technicalReport as { warnings?: string[] } | null)?.warnings ?? []).map((w, i) => (
              <p key={i} className="small error">
                {w}
              </p>
            ))}
            {message && <p className="small error">{message}</p>}
            <p className="small muted">Aprovados, os clipes entram na exportação portátil pela biblioteca do projeto.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function JobsList({ jobs }: { jobs: Overview["jobs"] }) {
  if (jobs.length === 0) return null;
  return (
    <section>
      <h2>Jobs de animação</h2>
      <ul className="list small">
        {jobs.map((j) => (
          <li key={j.id}>
            {j.id} · <span className={`badge state-${j.state}`}>{j.state}</span>
            {j.stage ? ` · ${j.stage}` : ""}
            {j.error ? <span className="error"> · {(j.error as { message?: string }).message}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
