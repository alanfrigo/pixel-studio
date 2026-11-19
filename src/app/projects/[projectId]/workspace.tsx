"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { GenerationPlan, ReferenceRole } from "@/contracts";
import type { AssetView, ProjectView, RevisionView, UploadView } from "@/server/catalog/catalog";
import type { ExportView } from "@/server/export/exports";
import type { JobView } from "@/server/jobs/queue";
import type { ProviderProfileView } from "@/server/providers/registry";
import { ApiError, apiFetch, errorMessage, formatBytes, newKey } from "@/app/client/api";
import { costText, estimateText } from "@/app/client/cost";
import { usePoll } from "@/app/client/use-poll";
import { useLocale, useMessages, useText } from "@/i18n/client";
import type { TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { workspaceMessages } from "@/i18n/messages/workspace";
import { dialogueMessages } from "@/i18n/messages/dialogue";
import { uiKitMessages } from "@/i18n/messages/ui-kit";
import { type PreviewBg, RevisionCompare } from "./revision-compare";
import { StylePanel } from "./style-panel";

type Lineage = Record<string, { revisionId: string; assetName: string; number: number; role: string; runtime: boolean }[]>;

interface Snapshot {
  project: ProjectView;
  palette: string[];
  briefLanguage: "pt-BR" | "en";
  jobs: JobView[];
  uploads: UploadView[];
  assets: { asset: AssetView; revisions: RevisionView[]; lineage: Lineage }[];
  exports: ExportView[];
}

const ACTIVE = new Set(["queued", "running"]);

export function Workspace({ projectId }: { projectId: string }) {
  const nav = useMessages(workspaceMessages).nav;
  const dialogueNav = useMessages(dialogueMessages).nav;
  const uiKitNav = useMessages(uiKitMessages).nav;
  const c = useMessages(commonMessages);
  const base = `/projects/${projectId}`;
  const { data, error, refresh } = usePoll<Snapshot>(
    async () => {
      const [{ project, style }, { jobs }, { uploads }, { assets }, { exports }] = await Promise.all([
        apiFetch<{ project: ProjectView; style: { payload: { palette: { colors: { hex: string }[] }; briefLanguage: string } } | null }>(base),
        apiFetch<{ jobs: JobView[] }>(`${base}/jobs`),
        apiFetch<{ uploads: UploadView[] }>(`${base}/uploads`),
        apiFetch<{ assets: AssetView[] }>(`${base}/assets`),
        apiFetch<{ exports: ExportView[] }>(`${base}/exports`),
      ]);
      const detailed = await Promise.all(assets.map((a) => apiFetch<{ asset: AssetView; revisions: RevisionView[]; lineage: Lineage }>(`${base}/assets/${a.id}`)));
      return {
        project,
        palette: style?.payload.palette.colors.map((c) => c.hex) ?? [],
        briefLanguage: style?.payload.briefLanguage === "en" ? "en" : "pt-BR",
        jobs,
        uploads,
        assets: detailed,
        exports,
      };
    },
    { active: (s) => s.jobs.some((j) => ACTIVE.has(j.state)) || s.uploads.some((u) => u.status === "pending"), fastMs: 800, slowMs: 6000 },
  );

  if (error && !data) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">{c.loading}</p>;

  return (
    <>
      <h1>{data.project.name}</h1>
      <nav className="row small" aria-label={nav.label}>
        <Link href={`/projects/${projectId}/animation`}>{nav.animation}</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/equipment`}>{nav.equipment}</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/world`}>{nav.world}</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/scenes`}>{nav.scenes}</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/dialogue`}>{dialogueNav}</Link>
        <span className="muted">·</span>
        <Link href={`/projects/${projectId}/ui`}>{uiKitNav.link}</Link>
      </nav>
      <div className="grid2">
        <GeneratePanel projectId={projectId} library={data.assets} defaultLanguage={data.briefLanguage} onChange={refresh} />
        <UploadPanel projectId={projectId} uploads={data.uploads} onChange={refresh} />
      </div>
      <JobsPanel projectId={projectId} jobs={data.jobs} assetOfRevision={new Map(data.assets.flatMap((a) => a.revisions.map((r) => [r.id, a.asset.id] as const)))} onChange={refresh} />
      <StylePanel projectId={projectId} onChange={refresh} />
      <AssetsPanel projectId={projectId} assets={data.assets} palette={data.palette} onChange={refresh} />
      <UiComponentsPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} onChange={refresh} />
      <ExportPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} exports={data.exports} onChange={refresh} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Geração por texto puro
// ---------------------------------------------------------------------------

interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { profileId: string; name: string; transport: string; simulated: boolean };
}

/** Papéis de referência na ordem do seletor (rótulos em `workspaceMessages.referenceRole`). */
const ROLES: ReferenceRole[] = ["identity", "style", "palette", "silhouette", "material", "pose", "equipment", "composition"];

interface RefChoice {
  revisionId: string;
  fileKey: string;
  fileId: string;
  label: string;
  role: ReferenceRole;
  instruction: string;
}

function GeneratePanel({
  projectId,
  library,
  defaultLanguage,
  onChange,
}: {
  projectId: string;
  library: { asset: AssetView; revisions: RevisionView[] }[];
  defaultLanguage: "pt-BR" | "en";
  onChange: () => void;
}) {
  const locale = useLocale();
  const m = useMessages(workspaceMessages).generate;
  const roleLabel = useMessages(workspaceMessages).referenceRole;
  const base = `/projects/${projectId}`;
  const assets = library.map((l) => l.asset);
  const { data: providers } = usePoll(
    () => apiFetch<{ profiles: (ProviderProfileView & { capabilities: Record<string, string[]>; unavailable: TextValue | null })[] }>("/settings/providers"),
    { active: () => false, slowMs: 60_000 },
  );
  const [target, setTarget] = useState<string>("new");
  const [name, setName] = useState(m.defaultName);
  const [brief, setBrief] = useState(m.defaultBrief);
  const [size, setSize] = useState(16);
  const [variants, setVariants] = useState(2);
  const [profileId, setProfileId] = useState("simulated");
  const [language, setLanguage] = useState<"pt-BR" | "en" | null>(null);
  const [refs, setRefs] = useState<RefChoice[]>([]);
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Uma intenção = uma chave de idempotência + um asset alvo. Cliques repetidos reutilizam ambos.
  const intent = useRef<{ digest: string; key: string; asset: Promise<string> | null } | null>(null);

  const itemAssets = assets.filter((a) => a.family === "item");
  const input = () => ({
    operation: "generate_asset" as const,
    providerProfileId: profileId,
    brief,
    language: language ?? defaultLanguage,
    params: { family: "item" as const, kind: "consumable" as const, logicalSize: [size, size] as [number, number], transparent: true, variants },
    references: refs.map((r) => ({ revisionId: r.revisionId, fileKey: r.fileKey, role: r.role, ...(r.instruction.trim() ? { instruction: r.instruction.trim() } : {}) })),
  });
  // Só revisões aprovadas servem de referência (o plano recusa as demais).
  const refOptions = library.flatMap(({ asset, revisions }) =>
    revisions
      .filter((r) => r.status === "approved")
      .flatMap((r) =>
        r.files
          .filter((f) => f.mime.startsWith("image/") && f.metadata.width)
          .map((f) => ({ key: `${r.id}|${f.fileKey}`, revisionId: r.id, fileKey: f.fileKey, fileId: f.id, label: `${asset.name} · r${r.number} · ${f.fileKey}` })),
      ),
  );
  const updateRefs = (next: RefChoice[]) => (setRefs(next), setPreview(null));
  const moveRef = (i: number, delta: number) => {
    const next = [...refs];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item!);
    updateRefs(next);
  };

  async function loadPreview(): Promise<PlanPreview> {
    const p = await apiFetch<PlanPreview>(`${base}/generation-plans`, { method: "POST", json: input() });
    setPreview(p);
    if (intent.current?.digest !== p.digest) intent.current = { digest: p.digest, key: newKey("gen"), asset: null };
    return p;
  }

  async function generate(newVariation: boolean) {
    setMessage(null);
    try {
      const p = preview && intent.current?.digest === preview.digest ? preview : await loadPreview();
      if (newVariation || !intent.current) intent.current = { digest: p.digest, key: newKey("gen"), asset: null };
      const current = intent.current;
      current.asset ??=
        target === "new"
          ? apiFetch<{ asset: AssetView }>(`${base}/assets`, { method: "POST", json: { family: "item", kind: "consumable", name } }).then((r) => r.asset.id)
          : Promise.resolve(target);
      const assetId = await current.asset;
      const res = await apiFetch<{ job: JobView; created: boolean }>(`${base}/jobs`, {
        method: "POST",
        headers: { "idempotency-key": `${current.key}:${assetId}` },
        json: { kind: "generation", request: { plan: p.plan, planDigest: p.digest, targetAssetId: assetId } },
      });
      setMessage(res.created ? m.queued(res.job.id) : m.duplicate(res.job.id));
      onChange();
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.message} (${err.code})` : String(err));
    }
  }

  const invalidate = () => setPreview(null);

  return (
    <section>
      <h2>{m.title}</h2>
      <form onSubmit={(e) => e.preventDefault()}>
        <label>
          {m.asset}
          <select value={target} onChange={(e) => (setTarget(e.target.value), (intent.current = null))}>
            <option value="new">{m.newAsset}</option>
            {itemAssets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        {target === "new" && (
          <label>
            {m.name}
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
        )}
        <label>
          {m.size}
          <select value={size} onChange={(e) => (setSize(Number(e.target.value)), invalidate())}>
            {[16, 24, 32, 48, 64].map((n) => (
              <option key={n} value={n}>
                {n} × {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.promptLanguage}
          <select value={language ?? defaultLanguage} onChange={(e) => (setLanguage(e.target.value as "pt-BR" | "en"), invalidate())}>
            <option value="pt-BR">pt-BR</option>
            <option value="en">en</option>
          </select>
        </label>
        <label>
          {m.variants}
          <select value={variants} onChange={(e) => (setVariants(Number(e.target.value)), invalidate())}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          {m.provider}
          <select value={profileId} onChange={(e) => (setProfileId(e.target.value), invalidate())}>
            {providers?.profiles.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.unavailable)}>
                {p.name}
                {p.unavailable ? m.unavailableSuffix : ""}
              </option>
            ))}
          </select>
        </label>
        <label style={{ flexBasis: "100%" }}>
          {m.brief}
          <textarea value={brief} onChange={(e) => (setBrief(e.target.value), invalidate())} maxLength={2000} />
        </label>
        <div style={{ flexBasis: "100%" }}>
          <div className="small muted">{m.referencesHint}</div>
          <ol className="list">
            {refs.map((r, i) => (
              <li key={`${r.revisionId}|${r.fileKey}|${i}`} className="row">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="pixel" alt="" src={`/api/v1/projects/${projectId}/media/${r.fileId}`} style={{ maxWidth: 48, maxHeight: 48 }} />
                <span className="small">
                  <strong>{m.image(i + 1)}</strong> · {r.label}
                </span>
                <select aria-label={m.imageRole(i + 1)} value={r.role} onChange={(e) => updateRefs(refs.map((x, j) => (j === i ? { ...x, role: e.target.value as ReferenceRole } : x)))}>
                  {ROLES.map((value) => (
                    <option key={value} value={value}>
                      {roleLabel[value]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={m.imageInstruction(i + 1)}
                  placeholder={m.instructionPlaceholder}
                  value={r.instruction}
                  maxLength={300}
                  onChange={(e) => updateRefs(refs.map((x, j) => (j === i ? { ...x, instruction: e.target.value } : x)))}
                />
                <button type="button" className="secondary" aria-label={m.moveUp} disabled={i === 0} onClick={() => moveRef(i, -1)}>
                  ↑
                </button>
                <button type="button" className="secondary" aria-label={m.moveDown} disabled={i === refs.length - 1} onClick={() => moveRef(i, 1)}>
                  ↓
                </button>
                <button type="button" className="secondary" aria-label={m.remove} onClick={() => updateRefs(refs.filter((_, j) => j !== i))}>
                  ×
                </button>
              </li>
            ))}
          </ol>
          <select
            aria-label={m.addReference}
            value=""
            disabled={refOptions.length === 0}
            onChange={(e) => {
              const o = refOptions.find((x) => x.key === e.target.value);
              if (o) updateRefs([...refs, { revisionId: o.revisionId, fileKey: o.fileKey, fileId: o.fileId, label: o.label, role: refs.length === 0 ? "identity" : "style", instruction: "" }]);
            }}
          >
            <option value="">{refOptions.length ? m.addApprovedReference : m.noApprovedReference}</option>
            {refOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="secondary" onClick={() => loadPreview().catch((e) => setMessage(String(e.message ?? e)))}>
          {m.planPreview}
        </button>
        <button type="button" onClick={() => generate(false)}>
          {m.generate}
        </button>
        <button type="button" className="secondary" onClick={() => generate(true)}>
          {m.newVariation}
        </button>
      </form>
      {message && <p className="small">{message}</p>}
      {preview && (
        <div className="small">
          <p>
            {m.destination} <strong>{preview.destination.name}</strong>
            {preview.destination.simulated && m.staysLocal} · {m.parts(preview.plan.parts.length)} · {m.estimate(estimateText(preview.plan, locale))}
          </p>
          <pre>{preview.plan.prompt.compiled}</pre>
          <p className="muted">
            {m.plan(preview.digest.slice(0, 12))} · {m.references(refs.length)}
            {preview.plan.operation === "generate_asset" && preview.plan.params.backgroundKey ? m.noAlphaRoute(preview.plan.params.backgroundKey) : ""}
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function UploadPanel({ projectId, uploads, onChange }: { projectId: string; uploads: UploadView[]; onChange: () => void }) {
  const locale = useLocale();
  const m = useMessages(workspaceMessages).upload;
  const c = useMessages(commonMessages);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function createItemFromUpload(u: UploadView) {
    setMessage(null);
    try {
      const name = u.originalName.replace(/\.[a-z0-9]+$/i, "") || m.importedItem;
      const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, {
        method: "POST",
        json: { family: "item", kind: "consumable", name },
      });
      await apiFetch(`/projects/${projectId}/assets/${asset.id}/revisions`, { method: "POST", json: { from: "upload", uploadId: u.id } });
      setMessage(m.itemCreated(name));
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    setMessage(m.sending);
    try {
      const res = await fetch(`/api/v1/projects/${projectId}/uploads`, { method: "POST", body: form });
      const body = await res.json();
      setMessage(res.ok ? m.received(body.job.id) : `${body.message} (${body.code})`);
      if (fileRef.current) fileRef.current.value = "";
      onChange();
    } catch (err) {
      setMessage(String(err));
    }
  }

  return (
    <section>
      <h2>{m.title}</h2>
      <p className="muted small">{m.hint}</p>
      <form onSubmit={upload}>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp,audio/wav,.ttf,.otf,.zip" />
        <button>{m.import}</button>
      </form>
      {message && <p className="small">{message}</p>}
      <ul className="list">
        {uploads.slice(0, 8).map((u) => (
          <li key={u.id} className="row">
            {u.modality === "raster" && u.status === "ready" && (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="pixel" alt={u.originalName} src={`/api/v1/projects/${projectId}/media/${u.id}`} style={{ maxWidth: 64, maxHeight: 64 }} />
            )}
            <span>{u.originalName}</span>
            <span className={`badge state-${u.status}`}>{labelOf(c.uploadStatus, u.status)}</span>
            <span className="muted small">
              {u.modality}
              {u.metadata?.width ? ` · ${u.metadata.width}×${u.metadata.height}` : ""}
              {u.metadata?.durationMs ? ` · ${u.metadata.durationMs} ms` : ""}
              {u.metadata?.package ? m.package((u.metadata.package as { revisions: number }).revisions) : ""}
            </span>
            {u.status === "rejected" && <span className="error small">{errorMessage(u.error, locale)}</span>}
            {u.status === "ready" && u.modality === "raster" && (
              <button className="secondary" onClick={() => createItemFromUpload(u)}>
                {m.createItem}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

function JobsPanel({ projectId, jobs, assetOfRevision, onChange }: { projectId: string; jobs: JobView[]; assetOfRevision: Map<string, string>; onChange: () => void }) {
  const locale = useLocale();
  const m = useMessages(workspaceMessages).jobs;
  const c = useMessages(commonMessages);
  const [message, setMessage] = useState<string | null>(null);

  async function act(job: JobView, action: "cancel" | "retry") {
    setMessage(null);
    let acknowledgePossibleCharge = false;
    if (action === "retry" && job.actions.retryMayCharge) {
      acknowledgePossibleCharge = window.confirm(m.retryChargeConfirm);
      if (!acknowledgePossibleCharge) return;
    }
    try {
      await apiFetch(`/projects/${projectId}/jobs/${job.id}/${action}`, { method: "POST", json: action === "retry" ? { acknowledgePossibleCharge } : {} });
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h2>{m.title}</h2>
      {message && <p className="error small">{message}</p>}
      {jobs.length === 0 && <p className="muted">{m.empty}</p>}
      <ul className="list">
        {jobs.map((job) => {
          const error = errorMessage(job.error, locale);
          return (
            <li key={job.id}>
              <div className="row">
                <strong>{labelOf(m.kind, job.kind)}</strong>
                <span className={`badge state-${job.state}`}>{labelOf(c.jobState, job.state)}</span>
                <span className="muted small">
                  {c.stage(job.stage)} · {m.attempt(job.attemptCount, job.maxAttempts)}
                  {job.cancelRequested && m.cancelRequested}
                  {job.kind === "generation" && m.providerCalls(job.summary.submissions)}
                  {job.summary.cost.map((cost) => m.cost(costText(cost, locale))).join("")}
                </span>
                {job.actions.canCancel && (
                  <button className="secondary" onClick={() => act(job, "cancel")}>
                    {m.cancel}
                  </button>
                )}
                {job.actions.canRetry && <button onClick={() => act(job, "retry")}>{m.retry}</button>}
              </div>
              {job.parts.length > 0 && (
                <div className="muted small">
                  {job.parts.map((p) => `${p.partKey}: ${labelOf(m.remoteState, p.remoteState)}${p.processed ? m.processed : ""}`).join(" · ")}
                </div>
              )}
              {error && job.state !== "succeeded" && (
                <div className={job.state === "queued" ? "small" : "error small"}>
                  {job.state === "queued" ? m.lastFailure : ""}
                  {error}
                </div>
              )}
              {job.kind === "local_process" && job.state === "succeeded" && <LocalOutputs projectId={projectId} job={job} assetOfRevision={assetOfRevision} onChange={onChange} />}
              <div className="muted small">{job.id}</div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Assets e revisões
// ---------------------------------------------------------------------------

function AssetsPanel({
  projectId,
  assets,
  palette,
  onChange,
}: {
  projectId: string;
  assets: { asset: AssetView; revisions: RevisionView[]; lineage: Lineage }[];
  palette: string[];
  onChange: () => void;
}) {
  const locale = useLocale();
  const text = useText();
  const m = useMessages(workspaceMessages).library;
  const edgeRole = useMessages(workspaceMessages).edgeRole;
  const c = useMessages(commonMessages);
  const [family, setFamily] = useState("all");
  const [status, setStatus] = useState<"all" | "pending" | "approved">("all");
  const [query, setQuery] = useState("");
  const [zoom, setZoom] = useState(4);
  const [bg, setBg] = useState<PreviewBg>("checker");
  const [compare, setCompare] = useState<string[]>([]);
  const families = [...new Set(assets.map((a) => a.asset.family))].sort();
  const visible = assets.filter(
    ({ asset, revisions }) =>
      (family === "all" || asset.family === family) &&
      (status === "all" || (status === "pending" ? revisions.some((r) => r.status === "candidate") : asset.approvedRevisionId !== null)) &&
      (!query.trim() || asset.name.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const imageOf = (rev: RevisionView) => rev.files.find((f) => f.fileKey === "image") ?? rev.files.find((f) => f.role === "normalized") ?? rev.files.find((f) => f.mime.startsWith("image/"));
  const byId = new Map(assets.flatMap(({ asset, revisions }) => revisions.map((r) => [r.id, { asset, rev: r }] as const)));
  const side = (id: string) => {
    const hit = byId.get(id);
    const file = hit && imageOf(hit.rev);
    return hit && file ? { label: `${hit.asset.name} r${hit.rev.number}`, src: `/api/v1/projects/${projectId}/media/${file.id}` } : null;
  };
  const toggleCompare = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id].slice(-2)));
  const [sideA, sideB] = [compare[0] ? side(compare[0]) : null, compare[1] ? side(compare[1]) : null];

  async function workshop(rev: RevisionView, fileId: string, operation: "remove_background_flood" | "apply_palette") {
    setMessage(null);
    try {
      let recipe: Record<string, unknown>;
      if (operation === "remove_background_flood") {
        const corner = await sampleCorner(`/api/v1/projects/${projectId}/media/${fileId}`);
        if (corner.alpha === 0) return setMessage(m.cornerTransparent);
        recipe = { version: 1, color: corner.hex, tolerance: 24, seeds: { borders: true, points: [] }, connectivity: 4 };
      } else {
        recipe = { version: 1, metric: "srgb8_squared", tieBreak: "lowest_index", dither: false, colors: palette };
      }
      const request = { operation, inputs: [{ role: "source", ref: { kind: "revision", revisionId: rev.id, fileKey: "image" } }], recipe };
      await apiFetch(`/projects/${projectId}/jobs`, {
        method: "POST",
        // Mesma revisão + mesma receita = mesmo job (clique repetido não duplica).
        headers: { "idempotency-key": `local:${operation}:${rev.id}:${await sha256Hex(JSON.stringify(recipe))}` },
        json: { kind: "local_process", request },
      });
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const [message, setMessage] = useState<string | null>(null);

  async function review(asset: AssetView, revision: RevisionView, decision: "approve" | "reject" | "promote") {
    setMessage(null);
    const reason = decision === "reject" ? window.prompt(c.rejectReasonPrompt) : null;
    if (decision === "reject" && !reason) return;
    try {
      await apiFetch(`/projects/${projectId}/assets/${asset.id}/reviews`, {
        method: "POST",
        json: { revisionId: revision.id, decision, reason, expectedActiveRevisionId: asset.approvedRevisionId },
      });
    } catch (err) {
      setMessage(
        err instanceof ApiError && err.status === 409
          ? m.staleConflict
          : String(err instanceof Error ? err.message : err),
      );
    }
    onChange();
  }

  return (
    <section>
      <h2>{m.title}</h2>
      <div className="row">
        <label>
          {m.family}
          <select value={family} onChange={(e) => setFamily(e.target.value)}>
            <option value="all">{m.all}</option>
            {families.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        </label>
        <label>
          {m.status}
          <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">{m.all}</option>
            <option value="pending">{m.pending}</option>
            <option value="approved">{m.approved}</option>
          </select>
        </label>
        <label>
          {m.search}
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.searchPlaceholder} />
        </label>
        <label>
          {m.zoom}
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
            {[1, 2, 4, 8].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <label>
          {m.background}
          <select value={bg} onChange={(e) => setBg(e.target.value as PreviewBg)}>
            <option value="checker">{m.bg.checker}</option>
            <option value="dark">{m.bg.dark}</option>
            <option value="light">{m.bg.light}</option>
          </select>
        </label>
        <span className="small muted">{m.count(visible.length, assets.length)}</span>
      </div>
      {sideA && sideB && <RevisionCompare a={sideA} b={sideB} zoom={zoom} bg={bg} onClose={() => setCompare([])} />}
      {compare.length === 1 && <p className="small muted">{m.pickAnother}</p>}
      {message && <p className="error small">{message}</p>}
      {assets.length === 0 && <p className="muted">{m.empty}</p>}
      {visible.map(({ asset, revisions, lineage }) => (
        <div key={asset.id} style={{ marginBottom: 16 }}>
          <div className="row">
            <strong>{asset.name}</strong>
            <span className="muted small">
              {asset.family}/{asset.kind} · {m.revisions(revisions.length)}
            </span>
          </div>
          <div className="revisions">
            {revisions.map((rev) => {
              const image = imageOf(rev);
              const w = Number(image?.metadata.width ?? 16);
              const h = Number(image?.metadata.height ?? 16);
              const report = rev.technicalReport as { sizeMatches?: boolean; receivedSize?: number[]; warnings?: TextValue[] } | null;
              const active = asset.approvedRevisionId === rev.id;
              return (
                <div key={rev.id} className={["revision", active && "active", compare.includes(rev.id) && "selected"].filter(Boolean).join(" ")}>
                  {image && (
                    <div className="row">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={`pixel bg-${bg}`} alt={`r${rev.number} 1×`} src={`/api/v1/projects/${projectId}/media/${image.id}`} width={w} height={h} />
                      {zoom > 1 && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img className={`pixel bg-${bg}`} alt={`r${rev.number} ${zoom}×`} src={`/api/v1/projects/${projectId}/media/${image.id}`} width={w * zoom} height={h * zoom} />
                      )}
                    </div>
                  )}
                  <div className="small">
                    r{rev.number} <span className={`badge state-${rev.status}`}>{active ? c.revisionStatus.active : labelOf(c.revisionStatus, rev.status)}</span>{" "}
                    <span className="muted">{rev.origin}</span>
                  </div>
                  {report?.sizeMatches === false && <div className="error small">{m.sizeMismatch(report.receivedSize?.join("×") ?? "?")}</div>}
                  {(rev.predecessorId || lineage[rev.id]?.length) && (
                    <div className="small muted">
                      {rev.predecessorId && <>{m.after(String(byId.get(rev.predecessorId)?.rev.number ?? "?"))}</>}
                      {lineage[rev.id]?.map((l) => (
                        <span key={`${l.revisionId}-${l.role}`}>
                          {" "}
                          · {m.edge((edgeRole as Record<string, string | undefined>)[l.role] ?? l.role.replaceAll("_", " "), l.assetName, l.number)}
                          {l.runtime ? m.usedInGame : ""}
                        </span>
                      ))}
                    </div>
                  )}
                  {(report?.warnings?.length ?? 0) > 0 && (
                    <details className="small">
                      <summary>{m.warnings(report!.warnings!.length)}</summary>
                      <ul>
                        {report!.warnings!.map((wn, i) => (
                          <li key={i}>{text(wn)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="row">
                    {rev.status !== "approved" && <button onClick={() => review(asset, rev, "approve")}>{c.approve}</button>}
                    {rev.status === "approved" && !active && (
                      <button className="secondary" onClick={() => review(asset, rev, "promote")}>
                        {m.makeActive}
                      </button>
                    )}
                    {rev.status === "candidate" && (
                      <button className="secondary" onClick={() => review(asset, rev, "reject")}>
                        {c.reject}
                      </button>
                    )}
                    {image && rev.status === "approved" && (
                      <Link className="button secondary" href={`/projects/${projectId}/inpaint?asset=${asset.id}&revision=${rev.id}&file=${encodeURIComponent(image.fileKey)}`}>
                        {m.inpainting}
                      </Link>
                    )}
                    {image && (
                      <button className="secondary" aria-pressed={compare.includes(rev.id)} onClick={() => toggleCompare(rev.id)}>
                        {compare.includes(rev.id) ? m.uncompare : m.compare}
                      </button>
                    )}
                  </div>
                  {image && image.fileKey === "image" && (
                    <div className="row">
                      <button className="secondary" onClick={() => workshop(rev, image.id, "remove_background_flood")}>
                        {m.removeBackground}
                      </button>
                      <button className="secondary" disabled={palette.length === 0} onClick={() => workshop(rev, image.id, "apply_palette")}>
                        {m.projectPalette}
                      </button>
                    </div>
                  )}
                  <span className="muted small">{formatBytes(image?.bytes ?? 0, locale)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Exportação
// ---------------------------------------------------------------------------

function ExportPanel({ projectId, assets, exports, onChange }: { projectId: string; assets: AssetView[]; exports: ExportView[]; onChange: () => void }) {
  const locale = useLocale();
  const text = useText();
  const m = useMessages(workspaceMessages).export;
  const c = useMessages(commonMessages);
  const approved = assets.filter((a) => a.approvedRevisionId);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);

  async function exportSelection() {
    setMessage(null);
    const revisionIds = approved.filter((a) => selected.has(a.id)).map((a) => a.approvedRevisionId!);
    try {
      const res = await apiFetch<{ export: ExportView; created: boolean }>(`/projects/${projectId}/exports`, {
        method: "POST",
        json: { revisionIds, profile: "portable-v1" },
      });
      setMessage(res.created ? m.queued : m.reused);
      onChange();
    } catch (err) {
      const problems = err instanceof ApiError ? (err.details?.problems as { message: TextValue }[] | undefined) : undefined;
      setMessage(problems?.length ? problems.map((p) => text(p.message)).join(" · ") : String(err instanceof Error ? err.message : err));
    }
  }

  return (
    <section>
      <h2>{m.title}</h2>
      <p className="muted small">{m.hint}</p>
      {approved.length === 0 && <p className="muted">{m.empty}</p>}
      <div className="row">
        {approved.map((a) => (
          <label key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
            <input
              type="checkbox"
              checked={selected.has(a.id)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(a.id);
                else next.delete(a.id);
                setSelected(next);
              }}
            />
            {a.name}
          </label>
        ))}
        <button disabled={selected.size === 0} onClick={exportSelection}>
          {m.exportZip}
        </button>
      </div>
      {message && <p className="small">{message}</p>}
      <ul className="list">
        {exports.map((e) => (
          <li key={e.id}>
            <div className="row">
              <span className={`badge state-${e.state === "ready" ? "succeeded" : e.state === "failed" ? "failed" : "queued"}`}>{labelOf(c.exportState, e.state)}</span>
              <span className="small">
                {e.report ? m.contents(e.report.entries, e.report.files) : m.selected(e.revisionIds.length)}
                {e.bytes ? ` · ${formatBytes(e.bytes, locale)}` : ""}
                {e.report?.addedDependencies.length ? m.dependencies(e.report.addedDependencies.length) : ""}
              </span>
              {e.state === "ready" && <a href={`/api/v1/projects/${projectId}/exports/${e.id}/download`}>{m.download(e.fileName ?? "")}</a>}
            </div>
            {e.state === "failed" && <div className="error small">{errorMessage(e.error, locale)}</div>}
            {e.report && (
              <div className="muted small">
                {m.limitations} {e.report.limitations.map((l) => text(l)).join(" · ")}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Oficina: saídas de processamento local
// ---------------------------------------------------------------------------

interface LocalRequestView {
  operation: string;
  inputs: { role: string; ref: { kind: string; revisionId?: string; fileKey?: string } }[];
}

interface LocalResultView {
  cacheHit: boolean;
  status: string;
  outputs: { index: number; role: string; key?: string; width?: number; height?: number }[];
  report: Record<string, unknown>;
  warnings: TextValue[];
}

const PUBLISHABLE = new Set(["cutout", "paletted", "protected"]);

function LocalOutputs({ projectId, job, assetOfRevision, onChange }: { projectId: string; job: JobView; assetOfRevision: Map<string, string>; onChange: () => void }) {
  const text = useText();
  const m = useMessages(workspaceMessages).local;
  const [message, setMessage] = useState<string | null>(null);
  const request = job.request as LocalRequestView;
  const result = job.result as LocalResultView;
  const source = request.inputs[0]?.ref;

  async function publish(index: number) {
    if (source?.kind !== "revision" || !source.revisionId) return;
    const assetId = assetOfRevision.get(source.revisionId);
    if (!assetId) return setMessage(m.sourceMissing);
    setMessage(null);
    try {
      const { revision } = await apiFetch<{ revision: RevisionView }>(`/projects/${projectId}/assets/${assetId}/revisions`, {
        method: "POST",
        json: { from: "job_output", jobId: job.id, outputIndex: index, baseRevisionId: source.revisionId, fileKey: source.fileKey },
      });
      setMessage(m.published(revision.number));
      onChange();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="small">
      <div className="muted">
        {labelOf(m.operation, request.operation)}
        {result.cacheHit ? m.cacheHit : ""}
        {typeof result.report.removedPixels === "number" ? m.removedPixels(result.report.removedPixels) : ""}
        {typeof result.report.changedPixels === "number" ? m.changedPixels(result.report.changedPixels) : ""}
      </div>
      {result.warnings.map((w, i) => (
        <div key={i} className="error">
          {text(w)}
        </div>
      ))}
      <div className="row" style={{ marginTop: 4 }}>
        {result.outputs.map((o) => (
          <div key={o.index} className="row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="pixel"
              alt={o.role}
              src={`/api/v1/projects/${projectId}/jobs/${job.id}/outputs/${o.index}`}
              width={(o.width ?? 16) * (o.width && o.width <= 64 ? 4 : 1)}
              height={(o.height ?? 16) * (o.width && o.width <= 64 ? 4 : 1)}
            />
            {PUBLISHABLE.has(o.role) && source?.kind === "revision" && (
              <button className="secondary" onClick={() => publish(o.index)}>
                {m.publish}
              </button>
            )}
          </div>
        ))}
      </div>
      {message && <div>{message}</div>}
    </div>
  );
}

/** Cor do pixel (0,0) da imagem servida, para amostrar o fundo. */
async function sampleCorner(src: string): Promise<{ hex: string; alpha: number }> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  return { hex: `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`, alpha: a! };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Componentes de UI do jogo
// ---------------------------------------------------------------------------

function UiComponentsPanel({ projectId, assets, onChange }: { projectId: string; assets: AssetView[]; onChange: () => void }) {
  const m = useMessages(workspaceMessages).ui;
  const router = useRouter();
  const [name, setName] = useState(m.defaultName);
  const ui = assets.filter((a) => a.family === "ui");
  async function create(kind: "button" | "panel") {
    const { asset } = await apiFetch<{ asset: AssetView }>(`/projects/${projectId}/assets`, { method: "POST", json: { family: "ui", kind, name } });
    onChange();
    router.push(`/projects/${projectId}/ui/${asset.id}`);
  }
  return (
    <section>
      <h2>{m.title}</h2>
      <div className="row">
        <label>
          {m.name}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <button className="secondary" onClick={() => create("button")}>
          {m.newButton}
        </button>
        <button className="secondary" onClick={() => create("panel")}>
          {m.newPanel}
        </button>
      </div>
      <ul className="list">
        {ui.map((a) => (
          <li key={a.id}>
            <Link href={`/projects/${projectId}/ui/${a.id}`}>{a.name}</Link> <span className="muted small">ui/{a.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
