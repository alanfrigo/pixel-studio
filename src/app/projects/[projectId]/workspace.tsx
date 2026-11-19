"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { GenerationPlan } from "@/contracts";
import type { AssetView, RevisionView, UploadView } from "@/server/catalog/catalog";
import type { ExportView } from "@/server/export/exports";
import type { ExportProfile, ExportProfileId } from "@/server/export/profiles";
import type { JobView } from "@/server/jobs/queue";
import { ApiError, apiFetch, errorMessage, formatBytes, newKey } from "@/app/client/api";
import { costText, estimateText } from "@/app/client/cost";
import { type CreationProfile, creationModelLabel, creationModelReason, creationReferenceLimit, recommendCreation } from "@/app/client/model-guidance";
import { usePoll } from "@/app/client/use-poll";
import { studioTemplates } from "@/app/examples/templates";
import { useLocale, useMessages, useText } from "@/i18n/client";
import { pick, type TextValue } from "@/i18n/locales";
import { commonMessages, labelOf } from "@/i18n/messages/common";
import { workspaceMessages } from "@/i18n/messages/workspace";
import { studioMessages } from "@/i18n/messages/studio";
import { ReferenceField, type ReferenceChoice } from "./reference-field";
import "./composer.css";
import { type PreviewBg, RevisionCompare } from "./revision-compare";
import { StylePanel } from "./style-panel";
import projectStyles from "./project-layout.module.css";

type Lineage = Record<string, { revisionId: string; assetName: string; number: number; role: string; runtime: boolean }[]>;

interface Snapshot {
  palette: string[];
  briefLanguage: "pt-BR" | "en";
  jobs: JobView[];
  uploads: UploadView[];
  assets: { asset: AssetView; revisions: RevisionView[]; lineage: Lineage }[];
  exports: ExportView[];
}

const ACTIVE = new Set(["queued", "running"]);

export function Workspace({ projectId, view, templateId, exportProfiles }: { projectId: string; view: "create" | "library" | "activity" | "export" | "style"; templateId?: string; exportProfiles: ExportProfile[] }) {
  const m = useMessages(studioMessages);
  const c = useMessages(commonMessages);
  const base = `/projects/${projectId}`;
  const { data, error, refresh } = usePoll<Snapshot>(
    async () => {
      const [{ style }, { jobs }, { uploads }, { assets }, { exports }] = await Promise.all([
        apiFetch<{ style: { payload: { palette: { colors: { hex: string }[] }; briefLanguage: string } } | null }>(base),
        apiFetch<{ jobs: JobView[] }>(`${base}/jobs`),
        apiFetch<{ uploads: UploadView[] }>(`${base}/uploads`),
        apiFetch<{ assets: AssetView[] }>(`${base}/assets`),
        apiFetch<{ exports: ExportView[] }>(`${base}/exports`),
      ]);
      const detailed = await Promise.all(assets.map((a) => apiFetch<{ asset: AssetView; revisions: RevisionView[]; lineage: Lineage }>(`${base}/assets/${a.id}`)));
      return {
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

  let pending: RevisionView | undefined;
  let approved: RevisionView | undefined;
  let preview: { fileId: string; name: string; createdAt: string } | undefined;
  for (const { asset, revisions } of data.assets) {
    const characterBase = asset.family === "character" && asset.kind === "base";
    if (characterBase || asset.family === "item") pending ??= revisions.find((r) => r.status === "candidate");
    if (characterBase) approved ??= revisions.find((r) => r.id === asset.approvedRevisionId);
    if (view !== "create" || (!characterBase && asset.family !== "item")) continue;
    for (const revision of revisions) {
      if (revision.origin !== "generation" || (revision.status !== "candidate" && revision.id !== asset.approvedRevisionId)) continue;
      if (preview && revision.createdAt <= preview.createdAt) continue;
      const file = revision.files.find((f) => f.role === "view" || f.role === "normalized");
      if (file) preview = { fileId: file.id, name: asset.name, createdAt: revision.createdAt };
    }
  }
  const running = data.jobs.some((j) => j.kind === "generation" && ACTIVE.has(j.state));
  const templateQuery = templateId ? `&template=${encodeURIComponent(templateId)}` : "";
  const next = pending
    ? { title: m.reviewTitle, description: m.reviewDescription, action: m.reviewAction, href: `${base}?view=library${templateQuery}#review` }
    : running
      ? { title: m.jobsTitle, description: m.jobsDescription, action: m.jobsAction, href: `${base}?view=activity${templateQuery}` }
      : approved
        ? { title: m.animateTitle, description: m.animateDescription, action: m.animateAction, href: `${base}/animation` }
        : null;
  const title = view === "library" ? m.assets : view === "activity" ? m.activity : view === "style" ? m.style : m.exportStep;

  return (
    <>
      {view !== "create" && <h1>{title}</h1>}
      <div className="create-flow" hidden={view !== "create"}>
        <GeneratePanel key={templateId} projectId={projectId} library={data.assets} uploads={data.uploads} defaultLanguage={data.briefLanguage} templateId={templateId} onChange={refresh} />
        {(next || preview) && (
          <div className={projectStyles.next}>
            {next && (
              <div className={projectStyles.nextText}>
                <span className="studio-kicker">{m.next}</span>
                <h2>{next.title}</h2>
                <p className="muted">{next.description}</p>
                <Link className="button secondary" href={next.href}>{next.action} <span aria-hidden="true">→</span></Link>
              </div>
            )}
            {preview && (
              <div className={projectStyles.preview}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/api/v1/projects/${projectId}/media/${preview.fileId}`} alt={preview.name} width={64} height={64} loading="lazy" />
                <span>{m.generatedPreview}</span>
              </div>
            )}
          </div>
        )}
      </div>
      {view === "library" && (
        <div id="review" className="workspace-library">
          <AssetsPanel projectId={projectId} assets={data.assets} palette={data.palette} onChange={refresh} />
          {approved && !pending && (
            <div className="workspace-review-next">
              <span>{m.animateTitle}</span>
              <Link className="button secondary" href={`${base}/animation`}>{m.animateAction} <span aria-hidden="true">→</span></Link>
            </div>
          )}
          <UploadPanel projectId={projectId} uploads={data.uploads} onChange={refresh} />
          <UiComponentsPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} onChange={refresh} />
        </div>
      )}
      {view === "activity" && <JobsPanel projectId={projectId} jobs={data.jobs} assetOfRevision={new Map(data.assets.flatMap((a) => a.revisions.map((r) => [r.id, a.asset.id] as const)))} onChange={refresh} />}
      {view === "style" && <StylePanel projectId={projectId} onChange={refresh} />}
      {view === "export" && <ExportPanel projectId={projectId} assets={data.assets.map((a) => a.asset)} exports={data.exports} profiles={exportProfiles} onChange={refresh} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Compositor de sprites
// ---------------------------------------------------------------------------

interface PlanPreview {
  plan: GenerationPlan;
  digest: string;
  destination: { profileId: string; name: string; transport: string; simulated: boolean };
}

function GeneratePanel({
  projectId,
  library,
  uploads,
  defaultLanguage,
  templateId,
  onChange,
}: {
  projectId: string;
  library: { asset: AssetView; revisions: RevisionView[] }[];
  uploads: UploadView[];
  defaultLanguage: "pt-BR" | "en";
  templateId?: string;
  onChange: () => void;
}) {
  const locale = useLocale();
  const m = useMessages(workspaceMessages).generate;
  const text = useText();
  const base = `/projects/${projectId}`;
  const template = studioTemplates.find((candidate) => candidate.id === templateId);
  const { data: providers, error: providerError } = usePoll(
    () => apiFetch<{ profiles: CreationProfile[] }>("/settings/providers?for=creation"),
    { active: () => false, fastMs: 60_000, slowMs: 60_000 },
  );
  const [family, setFamily] = useState<"character" | "item">(template?.family ?? "character");
  const [target, setTarget] = useState("new");
  const [name, setName] = useState(() => pick(template?.name, locale));
  const [brief, setBrief] = useState(() => pick(template?.brief, defaultLanguage));
  const [size, setSize] = useState(template?.size ?? 32);
  const [variants, setVariants] = useState(1);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [language, setLanguage] = useState<"pt-BR" | "en" | null>(null);
  const [refs, setRefs] = useState<ReferenceChoice[]>([]);
  const [uploading, setUploading] = useState(false);
  const [review, setReview] = useState<{ formKey: string; preview: PlanPreview } | null>(null);
  const confirmation = useRef<{ formKey: string; key: string } | null>(null);
  const [result, setResult] = useState<{ formKey: string; text: string; queued?: true } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  // Uma intenção guarda o asset e a mesma chave de idempotência até outro envio deliberado.
  const intent = useRef<{ formKey: string; digest: string; key: string; assetId: string | null; submitted: boolean } | null>(null);

  const character = family === "character";
  const targets = library.flatMap(({ asset }) => asset.family === family && (!character || asset.kind === "base") ? [asset] : []);
  const targetAsset = targets.find((asset) => asset.id === target);
  const kind = targetAsset?.kind ?? (character ? "base" : "consumable");
  const uploadById = new Map(uploads.map((upload) => [upload.id, upload]));
  const { recommended, available } = recommendCreation(providers?.profiles ?? [], family, refs.length);
  const selected = profileId === null ? recommended : available.find((profile) => profile.id === profileId);
  const manualProfile = profileId === null ? undefined : providers?.profiles.find((profile) => profile.id === profileId);
  const referenceUploads = refs.flatMap(({ source }) => "uploadId" in source ? [uploadById.get(source.uploadId)] : []);
  const rejectedReferences = referenceUploads.some((upload) => upload?.status === "rejected");
  const loadingReferences = referenceUploads.some((upload) => upload?.status !== "rejected" && !upload?.normalizedSha256);
  const blocked = !selected || uploading || loadingReferences || rejectedReferences;
  const firstPerModel = new Set<string>();
  const modelOptions: CreationProfile[] = [];
  const otherProfiles: CreationProfile[] = [];
  for (const profile of available) {
    const key = `${profile.transport}:${profile.model ?? profile.name}`;
    if (firstPerModel.has(key)) otherProfiles.push(profile);
    else { firstPerModel.add(key); modelOptions.push(profile); }
  }
  const selectedLabel = selected?.simulated ? m.simulated : selected ? creationModelLabel(selected) : "";
  const billing = selected?.simulated ? m.offline : selected?.transport === "codex_cli" ? m.quota : m.credits;
  const limit = selected ? creationReferenceLimit(selected) : 0;
  const request = {
    operation: "generate_asset",
    providerProfileId: selected?.id ?? "",
    brief: brief.trim(),
    language: language ?? defaultLanguage,
    params: { family, kind, logicalSize: [size, size], transparent: true, variants },
    references: refs.map(({ source, role, instruction }) => ({
      ...("uploadId" in source ? { uploadId: source.uploadId } : { revisionId: source.revisionId, fileKey: source.fileKey }),
      role, ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
    })),
  };
  const formKey = JSON.stringify([request, targetAsset?.id ?? null, targetAsset ? null : name.trim(), selected?.transport, selected?.model]);
  const preview = review?.formKey === formKey ? review.preview : null;
  const message = result?.formKey === formKey ? result : null;
  const refOptions = library.flatMap(({ asset, revisions }) =>
    revisions.filter((r) => r.status === "approved").flatMap((r) => r.files
      .filter((f) => f.mime.startsWith("image/") && f.metadata.width && f.role !== "raw")
      .map((f) => ({
        key: f.id, source: { revisionId: r.id, fileKey: f.fileKey, fileId: f.id },
        label: `${asset.name} · r${r.number} · ${f.fileKey}`,
      }))),
  );

  async function submit(mode: "review" | "confirm" | "generate" | "variation") {
    if (pending.current || blocked || !selected || (mode === "confirm" && !preview)) return;
    if ((!targetAsset && !name.trim()) || !request.brief) {
      setResult({ formKey, text: m.missingText });
      return;
    }
    pending.current = true;
    setBusy(true);
    setResult(null);
    try {
      const p = (mode === "variation" ? null : preview) ?? await apiFetch<PlanPreview>(`${base}/generation-plans`, { method: "POST", json: request });
      if (mode === "review" || (!p.destination.simulated && mode !== "confirm")) {
        if (mode === "variation" || confirmation.current?.formKey !== formKey) {
          confirmation.current = { formKey, key: newKey("gen") };
        }
        setReview({ formKey, preview: p });
        return;
      }
      const previous = intent.current;
      const sameRun = previous?.formKey === formKey && previous.digest === p.digest;
      const key = mode === "confirm" ? confirmation.current?.key : mode === "variation" && previous?.submitted ? newKey("gen") : undefined;
      const current = sameRun && (!key || key === previous.key)
        ? previous
        : { formKey, digest: p.digest, key: key ?? newKey("gen"), assetId: sameRun ? previous.assetId : targetAsset?.id ?? null, submitted: false };
      intent.current = current;
      if (current.assetId === null) {
        const { asset } = await apiFetch<{ asset: AssetView }>(`${base}/assets`, {
          method: "POST",
          json: { family, kind, name: name.trim() },
        });
        current.assetId = asset.id;
      }
      const res = await apiFetch<{ job: JobView; created: boolean }>(`${base}/jobs`, {
        method: "POST",
        headers: { "idempotency-key": `${current.key}:${current.assetId}` },
        json: { kind: "generation", request: { plan: p.plan, planDigest: p.digest, targetAssetId: current.assetId } },
      });
      current.submitted = true;
      setReview(null);
      setResult({ formKey, text: res.created ? m.queued : m.duplicate, queued: true });
      onChange();
    } catch (err) {
      setResult({ formKey, text: err instanceof Error ? err.message : String(err) });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  const actionLabel = selected?.simulated
    ? character ? m.generateCharacter : m.generateItem
    : m.planPreview;

  return (
    <section id="create" className="composer">
      <header className="composer-head">
        <h1>{m.title}</h1>
        <p>{m.intro}</p>
      </header>
      <form className="composer-form" aria-busy={busy} onSubmit={(event) => {
        event.preventDefault();
        if (!preview || selected?.simulated) void submit(selected?.simulated ? "generate" : "review");
      }}>
        <fieldset className="composer-families" disabled={busy}>
          <legend>{m.type}</legend>
          {(["character", "item"] as const).map((value) => (
            <label className="composer-family" key={value}>
              <input
                type="radio"
                name="sprite-family"
                value={value}
                checked={family === value}
                onChange={() => { setFamily(value); setTarget("new"); }}
              />
              <strong>{value === "character" ? m.character : m.item}</strong>
              <span>{value === "character" ? m.characterCaption : m.itemCaption}</span>
            </label>
          ))}
        </fieldset>
        <div className="composer-fields">
          {!targetAsset ? (
            <label>
              {m.name}
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required disabled={busy} />
            </label>
          ) : <p className="small">{m.asset}: <strong>{targetAsset.name}</strong></p>}
          <label>
            {m.brief}
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={2000} rows={4} aria-describedby="composer-brief-hint" required disabled={busy} />
          </label>
          <p id="composer-brief-hint" className="small muted">{character ? m.characterHint : m.itemHint}</p>
        </div>
        <ReferenceField projectId={projectId} refs={refs} uploads={uploadById} library={refOptions} setRefs={setRefs} disabled={busy} uploading={uploading} setUploading={setUploading} onUpload={onChange} />
        <div className="composer-controls composer-generation-options">
          <label>
            {m.provider}
            <select value={profileId ?? ""} disabled={busy || (!providers && !providerError)} onChange={(e) => setProfileId(e.target.value || null)} aria-describedby="composer-model-note">
              <option value="">{recommended ? m.automaticModel(recommended.simulated ? m.simulated : creationModelLabel(recommended)) : providers ? m.automaticUnavailable : m.chooseModel}</option>
              {profileId && !selected && <option value={profileId} disabled>{manualProfile ? creationModelLabel(manualProfile) : profileId}{m.unavailableSuffix}</option>}
              {modelOptions.map((profile) => <option key={profile.id} value={profile.id}>
                {profile.simulated ? m.simulated : creationModelLabel(profile)}
                {profile.transport === "codex_cli" ? ` · ${m.quota}` : profile.simulated ? ` · ${m.offline}` : ` · ${m.credits}`}
              </option>)}
              {otherProfiles.length > 0 && <optgroup label={m.otherProfiles}>
                {otherProfiles.map((profile) => <option key={profile.id} value={profile.id}>{creationModelLabel(profile)} · {profile.name}</option>)}
              </optgroup>}
            </select>
          </label>
          <label>
            {m.size}
            <select value={size} disabled={busy} onChange={(e) => setSize(Number(e.target.value))}>
              {[16, 24, 32, 48, 64].map((n) => <option key={n} value={n}>{n} × {n}</option>)}
            </select>
          </label>
          <div className="composer-model-note" id="composer-model-note" aria-live="polite">
            {selected ? <>
              <p>{text(creationModelReason(selected, refs.length))}</p>
              <small>{billing}{limit > 0 ? ` · ${m.referenceLimit(limit).toLowerCase()}` : ""}</small>
            </> : <p className="error">{profileId ? m.incompatibleModel : providerError ?? (providers ? m.noModel : m.chooseModel)}</p>}
          </div>
        </div>
        {preview && (
          <div className="composer-preview" role="region" aria-label={m.reviewTitle}>
            <h2>{m.reviewTitle}</h2>
            <p><strong>{selectedLabel || preview.destination.name}</strong> · {m.parts(preview.plan.parts.length)} · {m.estimate(estimateText(preview.plan, locale))}</p>
            <p className="small muted">{m.references(refs.length)}</p>
            {!preview.destination.simulated && <p className="small">{m.reviewPrivacy}</p>}
            <details>
              <summary>{m.compiledPrompt}</summary>
              <pre>{preview.plan.prompt.compiled}</pre>
              {preview.plan.operation === "generate_asset" && preview.plan.params.backgroundKey && <p className="muted small">{m.noAlphaRoute(preview.plan.params.backgroundKey)}</p>}
            </details>
          </div>
        )}
        {rejectedReferences
          ? <p className="small error" role="status">{m.referenceRejected}</p>
          : loadingReferences && <p className="small muted" role="status">{m.waitingReferences}</p>}
        <div className="composer-actions">
          {preview && !preview.destination.simulated && !message?.queued ? <>
            <button type="button" disabled={busy || blocked} onClick={() => void submit("confirm")}>{busy ? m.busy : m.confirmGeneration}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setReview(null)}>{m.dismissReview}</button>
          </> : message?.queued ? (
            <button type="button" className="secondary" disabled={busy || blocked} onClick={() => void submit("variation")}>{m.newVariation}</button>
          ) : (
            <button type="submit" disabled={busy || blocked}>{busy ? m.busy : actionLabel}</button>
          )}
          <div className="composer-model-links">
            <Link href={`/examples?project=${encodeURIComponent(projectId)}#examples-results`}>{m.compareModels}</Link>
            <Link href="/settings">{m.modelSettings}</Link>
          </div>
        </div>
        <div className="composer-status small" role="status">
          {message && <p className={message.queued ? undefined : "error"}>{message.text} {message.queued && <Link href={`${base}?view=library#review`}>{m.openLibrary}</Link>}</p>}
        </div>
        <details className="composer-advanced">
          <summary>{m.advanced}</summary>
          <div className="composer-controls">
            {targets.length > 0 && (
              <label>
                {m.asset}
                <select value={targetAsset?.id ?? "new"} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
                  <option value="new">{m.newAsset}</option>
                  {targets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select>
              </label>
            )}
            <label>
              {m.promptLanguage}
              <select value={language ?? defaultLanguage} disabled={busy} onChange={(e) => setLanguage(e.target.value as "pt-BR" | "en")}>
                <option value="pt-BR">pt-BR</option>
                <option value="en">en</option>
              </select>
            </label>
            <label>
              {m.variants}
              <select value={variants} disabled={busy} onChange={(e) => setVariants(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
          </div>
          <div className="composer-actions">
            {!preview && selected?.simulated && <button type="button" className="secondary" disabled={busy || blocked} onClick={() => void submit("review")}>{m.planPreview}</button>}
          </div>
        </details>
      </form>
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

function ExportPanel({ projectId, assets, exports, profiles, onChange }: { projectId: string; assets: AssetView[]; exports: ExportView[]; profiles: ExportProfile[]; onChange: () => void }) {
  const locale = useLocale();
  const text = useText();
  const m = useMessages(workspaceMessages).export;
  const c = useMessages(commonMessages);
  const [profileId, setProfileId] = useState<ExportProfileId>("portable-v1");
  const profile = profiles.find((p) => p.id === profileId)!;
  const approved = assets.filter((a) => a.approvedRevisionId);
  const compatible = approved.filter((a) => profile.kinds[a.family]?.includes(a.kind));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const revisionIds = compatible.flatMap((a) => selected.has(a.id) && a.approvedRevisionId ? [a.approvedRevisionId] : []);

  async function exportSelection() {
    if (!revisionIds.length) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<{ export: ExportView; created: boolean }>(`/projects/${projectId}/exports`, {
        method: "POST",
        json: { revisionIds, profile: profileId },
      });
      setMessage(res.created ? m.queued : m.reused);
      onChange();
    } catch (err) {
      const problems = err instanceof ApiError ? (err.details?.problems as { message: TextValue }[] | undefined) : undefined;
      setMessage(problems?.length ? problems.map((p) => text(p.message)).join(" · ") : String(err instanceof Error ? err.message : err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-busy={busy}>
      <h2>{m.title}</h2>
      <p className="muted small">{m.hint}</p>
      {approved.length === 0 && <p className="muted">{m.empty}</p>}
      <div className="row">
        <label>
          {m.format}
          <select value={profileId} disabled={busy} onChange={(e) => {
            setProfileId(e.target.value as ExportProfileId);
            setSelected(new Set());
            setMessage(null);
          }}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{text(p.label)}</option>)}
          </select>
        </label>
      </div>
      <details className="small">
        <summary>{m.profileDetails}</summary>
        <ul>
          {profile.supports.map((support) => <li key={support.en}>{text(support)}</li>)}
        </ul>
        <strong>{m.limitations}</strong>
        <ul>
          {profile.limitations.map((limitation) => <li key={limitation.en}>{text(limitation)}</li>)}
        </ul>
      </details>
      {approved.length > 0 && compatible.length === 0 && <p className="muted">{m.noCompatible}</p>}
      <div className="row">
        {compatible.map((a) => (
          <label key={a.id} style={{ flexDirection: "row", alignItems: "center", gap: 4, color: "inherit" }}>
            <input
              type="checkbox"
              disabled={busy}
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
        <button disabled={busy || revisionIds.length === 0} onClick={exportSelection}>
          {m.exportZip}
        </button>
      </div>
      {message && <p className="small" role="status">{message}</p>}
      <ul className="list">
        {exports.map((e) => (
          <li key={e.id}>
            <div className="row">
              <span className={`badge state-${e.state === "ready" ? "succeeded" : e.state === "failed" ? "failed" : "queued"}`}>{labelOf(c.exportState, e.state)}</span>
              <strong className="small">{text(profiles.find((p) => p.id === e.profile)?.label ?? e.profile)}</strong>
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
